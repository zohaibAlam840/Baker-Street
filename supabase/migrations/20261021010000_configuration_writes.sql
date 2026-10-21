-- Atomic, validated configuration commands for the administrator UI.
-- Configuration changes affect future scheduling decisions, so the database
-- protects active appointments and records every changed row in audit_log.

begin;

do $audit_triggers$
declare table_name text;
begin
  foreach table_name in array array[
    'locations', 'resources', 'services', 'service_durations', 'service_resources'
  ] loop
    execute format('drop trigger if exists %I_audit_trigger on %I', table_name, table_name);
    execute format(
      'create trigger %I_audit_trigger after insert or update or delete on %I for each row execute function audit_domain_change()',
      table_name,
      table_name
    );
  end loop;
end
$audit_triggers$;

-- Configuration writes must pass through the commands below. The functions
-- re-check the actor and can inspect appointment rows that ADMIN correctly
-- cannot read through ordinary RLS.
do $remove_direct_write_policies$
declare table_name text;
begin
  foreach table_name in array array[
    'locations', 'resources', 'services', 'service_durations', 'service_resources'
  ] loop
    execute format('drop policy if exists %I on %I', 'admins insert '||table_name, table_name);
    execute format('drop policy if exists %I on %I', 'admins update '||table_name, table_name);
    execute format('drop policy if exists %I on %I', 'admins delete '||table_name, table_name);
  end loop;
end
$remove_direct_write_policies$;
revoke insert,update,delete on locations,resources,services,service_durations,service_resources from authenticated;

create or replace function update_location_configuration(
  p_location_id uuid,
  p_name text,
  p_type location_type,
  p_city text,
  p_state text,
  p_timezone text,
  p_active boolean
) returns void
language plpgsql
security definer
set search_path=public,pg_catalog
as $update_location$
begin
  if current_app_role() is distinct from 'ADMIN'::app_role then
    raise exception 'System administrator access required' using errcode='42501';
  end if;
  if nullif(btrim(p_name),'') is null or length(btrim(p_name)) > 120 then
    raise exception 'Location name is invalid';
  end if;
  if p_type is null or p_active is null then raise exception 'Location configuration is incomplete'; end if;
  if nullif(btrim(p_timezone),'') is null
    or not exists(select 1 from pg_timezone_names where name=btrim(p_timezone)) then
    raise exception 'Enter a valid IANA timezone, such as America/New_York.';
  end if;
  lock table appointments in share mode;
  if not p_active and exists(
    select 1 from appointments
    where location_id=p_location_id and status in ('SCHEDULED','CONFIRMED') and end_time>now()
  ) then
    raise exception 'This location has future appointments and cannot be deactivated.';
  end if;

  update locations set
    name=btrim(p_name), type=p_type, city=nullif(btrim(p_city),''),
    state=nullif(btrim(p_state),''), timezone=btrim(p_timezone), active=p_active
  where id=p_location_id;
  if not found then raise exception 'Location not found'; end if;
end
$update_location$;

create or replace function update_resource_configuration(
  p_resource_id uuid,
  p_name text,
  p_resource_type text,
  p_capacity int,
  p_location_id uuid,
  p_active boolean
) returns void
language plpgsql
security definer
set search_path=public,pg_catalog
as $update_resource$
declare current_resource resources%rowtype;
begin
  if current_app_role() is distinct from 'ADMIN'::app_role then
    raise exception 'System administrator access required' using errcode='42501';
  end if;
  if nullif(btrim(p_name),'') is null or length(btrim(p_name)) > 120 then
    raise exception 'Resource name is invalid';
  end if;
  if nullif(btrim(p_resource_type),'') is null or length(btrim(p_resource_type)) > 80 then
    raise exception 'Resource type is invalid';
  end if;
  if p_capacity is null or p_capacity not between 1 and 10000 or p_active is null then
    raise exception 'Resource capacity must be between 1 and 10,000';
  end if;
  if p_location_id is not null and not exists(
    select 1 from locations where id=p_location_id and (active or not p_active)
  ) then
    raise exception 'An active location is required for an active resource';
  end if;

  lock table appointments in share mode;
  select * into current_resource from resources where id=p_resource_id for update;
  if not found then raise exception 'Resource not found'; end if;

  if not p_active and exists(
    select 1 from appointment_resources ar
    join appointments a on a.id=ar.appointment_id
    where ar.resource_id=p_resource_id
      and a.status in ('SCHEDULED','CONFIRMED') and a.end_time>now()
  ) then
    raise exception 'This resource has future appointments and cannot be deactivated.';
  end if;
  if p_location_id is not null and p_location_id is distinct from current_resource.location_id and exists(
    select 1 from appointment_resources ar
    join appointments a on a.id=ar.appointment_id
    where ar.resource_id=p_resource_id
      and a.status in ('SCHEDULED','CONFIRMED') and a.end_time>now()
      and a.location_id is distinct from p_location_id
  ) then
    raise exception 'This resource has future appointments at another location and cannot be moved.';
  end if;
  if exists(
    select 1
    from appointment_resources ar
    join appointments a on a.id=ar.appointment_id
    where ar.resource_id=p_resource_id
      and a.status in ('SCHEDULED','CONFIRMED') and a.end_time>now()
      and (
        select count(*)
        from appointment_resources overlapping_link
        join appointments overlapping on overlapping.id=overlapping_link.appointment_id
        where overlapping_link.resource_id=p_resource_id
          and overlapping.status in ('SCHEDULED','CONFIRMED')
          and overlapping.start_time<a.end_time and overlapping.end_time>a.start_time
      ) > p_capacity
  ) then
    raise exception 'The lower capacity would conflict with future appointments.';
  end if;

  update resources set
    name=btrim(p_name), resource_type=btrim(p_resource_type), capacity=p_capacity,
    location_id=p_location_id, active=p_active
  where id=p_resource_id;
end
$update_resource$;

create or replace function update_service_configuration(
  p_service_id uuid,
  p_name text,
  p_code text,
  p_department text,
  p_durations int[],
  p_default_duration int,
  p_primary_objective text,
  p_requires_authorization boolean,
  p_in_person_allowed boolean,
  p_telehealth_allowed boolean,
  p_group_allowed boolean,
  p_active boolean,
  p_resource_ids uuid[]
) returns void
language plpgsql
security definer
set search_path=public,pg_catalog
as $update_service$
declare supplied_count int;
begin
  if current_app_role() is distinct from 'ADMIN'::app_role then
    raise exception 'System administrator access required' using errcode='42501';
  end if;
  if nullif(btrim(p_name),'') is null or length(btrim(p_name)) > 120 then
    raise exception 'Service name is invalid';
  end if;
  if btrim(p_code) !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then
    raise exception 'Service code is invalid';
  end if;
  if nullif(btrim(p_department),'') is null or length(btrim(p_department)) > 120 then
    raise exception 'Department is invalid';
  end if;
  if coalesce(cardinality(p_durations),0)=0 or exists(
    select 1 from unnest(p_durations) duration
    where duration not between 15 and 1440 or duration % 15 <> 0
  ) then
    raise exception 'Allowed durations are invalid';
  end if;
  select count(distinct duration) into supplied_count from unnest(p_durations) duration;
  if supplied_count <> cardinality(p_durations) then
    raise exception 'Allowed durations must be unique';
  end if;
  if not p_default_duration=any(p_durations) then
    raise exception 'Default duration must be one of the allowed durations';
  end if;
  if p_primary_objective not in (
    'MAXIMIZE_SERVICE_HOURS','MAXIMIZE_SERVICE_SESSIONS',
    'MAXIMIZE_AUTHORIZATION_UTILIZATION','COMPLETE_REQUIRED_SERVICES',
    'MAXIMIZE_PROVIDER_CONTINUITY','MINIMIZE_TRAVEL'
  ) then
    raise exception 'Optimization objective is invalid';
  end if;
  if p_requires_authorization is null or p_in_person_allowed is null
    or p_telehealth_allowed is null or p_group_allowed is null or p_active is null then
    raise exception 'Service configuration is incomplete';
  end if;
  if not p_in_person_allowed and not p_telehealth_allowed then
    raise exception 'At least one delivery mode is required';
  end if;
  if p_resource_ids is null then p_resource_ids := '{}'::uuid[]; end if;
  select count(distinct resource_id) into supplied_count from unnest(p_resource_ids) resource_id;
  if supplied_count <> cardinality(p_resource_ids) then
    raise exception 'Selected resources must be unique';
  end if;

  lock table appointments in share mode;
  perform 1 from resources where id=any(p_resource_ids) order by id for share;
  if (select count(*) from resources where id=any(p_resource_ids) and active) <> cardinality(p_resource_ids) then
    raise exception 'One or more selected resources are inactive or were not found';
  end if;
  perform 1 from services where id=p_service_id for update;
  if not found then raise exception 'Service not found'; end if;

  if exists(
    select 1 from appointments
    where service_id=p_service_id and status in ('SCHEDULED','CONFIRMED') and end_time>now()
      and round(extract(epoch from (end_time-start_time))/60)::int <> all(p_durations)
  ) then
    raise exception 'Allowed durations cannot invalidate future appointments.';
  end if;
  if not p_in_person_allowed and exists(
    select 1 from appointments
    where service_id=p_service_id and status in ('SCHEDULED','CONFIRMED')
      and end_time>now() and not telehealth
  ) then
    raise exception 'In-person delivery cannot be disabled while the service has future appointments.';
  end if;
  if not p_telehealth_allowed and exists(
    select 1 from appointments
    where service_id=p_service_id and status in ('SCHEDULED','CONFIRMED')
      and end_time>now() and telehealth
  ) then
    raise exception 'Telehealth cannot be disabled while the service has future appointments.';
  end if;
  if p_requires_authorization and exists(
    select 1 from appointments
    where service_id=p_service_id and status in ('SCHEDULED','CONFIRMED')
      and end_time>now() and authorization_id is null
  ) then
    raise exception 'Authorization cannot be required while future appointments lack authorization.';
  end if;
  if cardinality(p_resource_ids)>0 and exists(
    select 1 from appointments a
    where a.service_id=p_service_id and a.status in ('SCHEDULED','CONFIRMED')
      and a.end_time>now() and not a.telehealth
      and not exists(
        select 1 from appointment_resources ar
        where ar.appointment_id=a.id and ar.resource_id=any(p_resource_ids)
      )
  ) then
    raise exception 'Required resources cannot invalidate future appointments.';
  end if;

  update services set
    service_name=btrim(p_name), service_code=btrim(p_code), department=btrim(p_department),
    default_duration_minutes=p_default_duration,
    min_duration_minutes=(select min(duration) from unnest(p_durations) duration),
    max_duration_minutes=(select max(duration) from unnest(p_durations) duration),
    requires_authorization=p_requires_authorization,
    in_person_allowed=p_in_person_allowed, telehealth_allowed=p_telehealth_allowed,
    group_allowed=p_group_allowed, active=p_active,
    optimization_profile=coalesce(optimization_profile,'{}'::jsonb)
      || jsonb_build_object('primary_objective',p_primary_objective)
  where id=p_service_id;

  update service_durations set active=(duration_minutes=any(p_durations))
  where service_id=p_service_id and active is distinct from (duration_minutes=any(p_durations));
  insert into service_durations(service_id,duration_minutes,active)
  select p_service_id,duration,true from unnest(p_durations) duration
  on conflict(service_id,duration_minutes) do update set active=true;

  delete from service_resources
  where service_id=p_service_id and resource_id<>all(p_resource_ids);
  insert into service_resources(service_id,resource_id,required)
  select p_service_id,resource_id,true from unnest(p_resource_ids) resource_id
  on conflict(service_id,resource_id) do update set required=true;
end
$update_service$;

revoke all on function update_location_configuration(uuid,text,location_type,text,text,text,boolean) from public,anon;
revoke all on function update_resource_configuration(uuid,text,text,int,uuid,boolean) from public,anon;
revoke all on function update_service_configuration(uuid,text,text,text,int[],int,text,boolean,boolean,boolean,boolean,boolean,uuid[]) from public,anon;
grant execute on function update_location_configuration(uuid,text,location_type,text,text,text,boolean) to authenticated;
grant execute on function update_resource_configuration(uuid,text,text,int,uuid,boolean) to authenticated;
grant execute on function update_service_configuration(uuid,text,text,text,int[],int,text,boolean,boolean,boolean,boolean,boolean,uuid[]) to authenticated;

create or replace function app_schema_status()
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $status$
  select jsonb_build_object(
    'ready',true,'version','20261021010000',
    'optimizer_approval',to_regprocedure('public.approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text)') is not null,
    'atomic_booking',to_regprocedure('public.create_appointment_series(jsonb,text)') is not null,
    'opaque_conflicts',to_regprocedure('public.optimization_busy_intervals(timestamp with time zone,timestamp with time zone)') is not null,
    'schedule_recovery',to_regclass('public.recovery_cases') is not null
      and to_regprocedure('public.respond_recovery_offer_with_contact(uuid,integer,text,text,uuid,communication_response_channel,uuid,text)') is not null,
    'communications',to_regclass('public.communication_consents') is not null
      and to_regclass('public.communication_jobs') is not null
      and to_regclass('public.communication_destination_suppressions') is not null
      and to_regclass('public.communication_delivery_attempts') is not null
      and to_regprocedure('public.sync_appointment_reminders(uuid)') is not null
      and to_regprocedure('public.prepare_communication_delivery(uuid,uuid)') is not null,
    'configuration_writes',to_regprocedure('public.update_service_configuration(uuid,text,text,text,integer[],integer,text,boolean,boolean,boolean,boolean,boolean,uuid[])') is not null
      and to_regprocedure('public.update_location_configuration(uuid,text,location_type,text,text,text,boolean)') is not null
      and to_regprocedure('public.update_resource_configuration(uuid,text,text,integer,uuid,boolean)') is not null
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
