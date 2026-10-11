begin;

-- Approval metadata lives with the request. The idempotency key makes a
-- mobile retry safe: the same tap can reach the server twice but commit once.
alter table optimization_requests add column if not exists idempotency_key text;
alter table optimization_requests add column if not exists approved_by uuid references auth.users(id) on delete set null;
alter table optimization_requests add column if not exists approved_at timestamptz;
alter table optimization_requests add column if not exists decision_reason text;
create unique index if not exists optimization_requests_idempotency_idx
  on optimization_requests(idempotency_key) where idempotency_key is not null;

alter table optimization_results add column if not exists selected boolean not null default false;
alter table appointments add column if not exists last_change_reason text;

-- Keep operational notes and the justification for the latest edit separate.
-- The old trigger treated an appointment note as an override reason.
create or replace function audit_appointment_change() returns trigger
language plpgsql security definer set search_path=public as $audit$
begin
  if tg_op='INSERT' then
    insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
    values(
      auth.uid(),'APPOINTMENT_CREATED',new.patient_id,new.id,
      to_jsonb(new)-'notes'-'cancellation_reason',new.last_change_reason
    );
    return new;
  elsif tg_op='UPDATE' then
    insert into audit_log(user_id,action,patient_id,appointment_id,old_values,new_values,override_reason)
    values(
      auth.uid(),
      case when new.status='CANCELLED' and old.status<>'CANCELLED' then 'APPOINTMENT_CANCELLED'
           when old.status='CANCELLED' and new.status<>'CANCELLED' then 'APPOINTMENT_RESTORED'
           else 'APPOINTMENT_UPDATED' end,
      new.patient_id,new.id,
      to_jsonb(old)-'notes'-'cancellation_reason',
      to_jsonb(new)-'notes'-'cancellation_reason',
      coalesce(new.cancellation_reason,new.last_change_reason)
    );
    return new;
  end if;
  return old;
end
$audit$;

-- Strengthen the shared write gate used by manual booking as well as the
-- optimizer. This closes the previous gap where the UI ran the rule engine but
-- a direct authenticated insert could exceed an authorization or use an
-- ineligible clinician/duration.
create or replace function validate_appointment_integrity() returns trigger
language plpgsql security definer set search_path=public as $integrity$
declare
  linked authorizations%rowtype;
  limit_hours numeric;
  used_hours numeric;
  local_day date;
  patient_zone text;
  local_start timestamp;
  local_end timestamp;
  week_start date;
  max_hours numeric;
  max_sessions int;
  week_hours numeric;
  week_sessions int;
begin
  if new.start_time >= new.end_time then raise exception 'Appointment end must be after start'; end if;
  if tg_op='UPDATE' and old.scheduling_flexibility='LOCKED' and (
    new.start_time<>old.start_time or new.end_time<>old.end_time
    or new.provider_id is distinct from old.provider_id
    or new.location_id is distinct from old.location_id
    or new.scheduling_flexibility<>'LOCKED'
  ) then raise exception 'Locked appointments cannot be moved, reassigned, relocated, or unlocked'; end if;
  if tg_op='UPDATE' and new.status='COMPLETED'
    and old.status in ('SCHEDULED','CONFIRMED')
    and new.patient_id=old.patient_id and new.service_id=old.service_id
    and new.provider_id is not distinct from old.provider_id
    and new.authorization_id is not distinct from old.authorization_id
    and new.location_id is not distinct from old.location_id
    and new.start_time=old.start_time and new.end_time=old.end_time
    and new.telehealth=old.telehealth then
    return new;
  end if;
  -- Cancellation must remain possible after credentials, authorizations, or
  -- configuration expire. Restoring an appointment runs every live check.
  if new.status not in ('SCHEDULED','CONFIRMED','COMPLETED') then return new; end if;
  select timezone into patient_zone from patients where id=new.patient_id and status='ACTIVE';
  if not found then raise exception 'Patient is not active'; end if;
  patient_zone := coalesce(patient_zone,'America/New_York');
  local_start := new.start_time at time zone patient_zone;
  local_end := new.end_time at time zone patient_zone;
  local_day := local_start::date;
  week_start := local_day - (extract(isodow from local_day)::int - 1);
  if local_start::date<>local_end::date
    or extract(second from local_start)<>0 or extract(second from local_end)<>0
    or mod(extract(minute from local_start)::int,15)<>0
    or mod(extract(minute from local_end)::int,15)<>0 then
    raise exception 'Appointments must stay on one local day and use 15-minute boundaries';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.patient_id::text || ':' || week_start::text,0));
  if new.provider_id is not null then
    perform 1 from providers where id=new.provider_id for update;
  end if;

  if not exists(
    select 1 from services s
    where s.id=new.service_id and s.active and (
      exists(
        select 1 from service_durations d where d.service_id=s.id and d.active
          and d.duration_minutes=extract(epoch from(new.end_time-new.start_time))/60
      ) or (
        not exists(select 1 from service_durations d where d.service_id=s.id and d.active)
        and s.default_duration_minutes=extract(epoch from(new.end_time-new.start_time))/60
      )
    )
  ) then raise exception 'Appointment duration is not configured for the service'; end if;

  if new.provider_id is not null and not exists(
    select 1 from providers p join provider_services ps on ps.provider_id=p.id
    where p.id=new.provider_id and p.status='ACTIVE' and ps.service_id=new.service_id and ps.eligible
      and (ps.effective_start is null or ps.effective_start<=local_day)
      and (ps.effective_end is null or ps.effective_end>=local_day)
  ) then raise exception 'Clinician is not eligible for the service'; end if;

  if new.provider_id is not null
    and exists(select 1 from provider_credentials where provider_id=new.provider_id)
    and not exists(
      select 1 from provider_credentials c
      where c.provider_id=new.provider_id and c.status='ACTIVE'
        and (c.issue_date is null or c.issue_date<=local_start::date)
        and (c.expiration_date is null or c.expiration_date>=local_end::date)
    ) then raise exception 'Clinician credential is not valid for the appointment'; end if;

  if not exists(
    select 1 from patient_availability a
    where a.patient_id=new.patient_id and a.availability_type in ('AVAILABLE','PREFERRED')
      and a.day_of_week=extract(dow from local_start)::int
      and a.start_time<=local_start::time and a.end_time>=local_end::time
      and (a.effective_start is null or a.effective_start<=local_day)
      and (a.effective_end is null or a.effective_end>=local_day)
  ) or exists(
    select 1 from patient_availability a
    where a.patient_id=new.patient_id and a.availability_type='HARD_UNAVAILABLE'
      and a.day_of_week=extract(dow from local_start)::int
      and a.start_time<local_end::time and a.end_time>local_start::time
      and (a.effective_start is null or a.effective_start<=local_day)
      and (a.effective_end is null or a.effective_end>=local_day)
  ) then raise exception 'Patient is not available for the appointment'; end if;

  if exists(
    select 1 from patient_restrictions r
    where r.patient_id=new.patient_id and r.day_of_week=extract(dow from local_start)::int
      and r.start_time<local_end::time and r.end_time>local_start::time
      and (r.service_allowed is null or r.service_allowed<>new.service_id)
      and (r.effective_start is null or r.effective_start<=local_day)
      and (r.effective_end is null or r.effective_end>=local_day)
  ) then raise exception 'Appointment conflicts with a patient restriction'; end if;

  if new.provider_id is not null and (
    not exists(
      select 1 from provider_availability a
      where a.provider_id=new.provider_id and a.availability_type in ('CLINICAL','PREFERRED')
        and a.day_of_week=extract(dow from local_start)::int
        and a.start_time<=local_start::time and a.end_time>=local_end::time
        and (new.telehealth or a.location_id is null or a.location_id=new.location_id)
        and (a.effective_start is null or a.effective_start<=local_day)
        and (a.effective_end is null or a.effective_end>=local_day)
    ) or exists(
      select 1 from provider_availability a
      where a.provider_id=new.provider_id and a.availability_type in ('HARD_UNAVAILABLE','PTO')
        and a.day_of_week=extract(dow from local_start)::int
        and a.start_time<local_end::time and a.end_time>local_start::time
        and (a.effective_start is null or a.effective_start<=local_day)
        and (a.effective_end is null or a.effective_end>=local_day)
    )
  ) then raise exception 'Clinician is not available for the appointment'; end if;

  if exists(
    select 1 from patient_preferences p
    where p.patient_id=new.patient_id and p.is_hard_constraint
      and (p.preferred_service_id is null or p.preferred_service_id=new.service_id)
      and (
        (p.preferred_provider_id is not null and p.preferred_provider_id is distinct from new.provider_id)
        or (p.preferred_location_id is not null and p.preferred_location_id is distinct from new.location_id)
        or (p.preferred_day is not null and p.preferred_day<>extract(dow from local_start)::int)
        or (p.preferred_start_time is not null and p.preferred_end_time is not null
          and (p.preferred_start_time>local_start::time or p.preferred_end_time<local_end::time))
      )
  ) then raise exception 'Appointment violates a required patient preference'; end if;

  if new.provider_id is not null and not new.telehealth and exists(
    select 1 from appointments a
    where a.provider_id=new.provider_id and a.id<>new.id and not a.telehealth
      and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
      and a.location_id is not null and a.location_id<>new.location_id
      and ((a.end_time<=new.start_time and new.start_time-a.end_time<interval '30 minutes')
        or (a.start_time>=new.end_time and a.start_time-new.end_time<interval '30 minutes'))
  ) then raise exception 'There is not enough travel time between locations'; end if;

  if new.authorization_id is not null then
    select * into linked from authorizations where id=new.authorization_id for update;
    if not found or linked.patient_id <> new.patient_id or linked.service_id <> new.service_id then
      raise exception 'Authorization does not match patient and service';
    end if;
    if local_day < linked.start_date or local_day > linked.end_date or linked.status <> 'ACTIVE' then
      raise exception 'Authorization is not active on the appointment date';
    end if;
    limit_hours := case
      when linked.authorized_hours is not null then linked.authorized_hours
      when linked.authorized_units is not null and linked.units_per_hour>0 then linked.authorized_units/linked.units_per_hour
      else null end;
    if limit_hours is not null then
      select coalesce(sum(extract(epoch from(a.end_time-a.start_time))/3600),0)
      into used_hours from appointments a
      where a.authorization_id=new.authorization_id and a.id<>new.id
        and a.status in ('SCHEDULED','CONFIRMED','COMPLETED');
      if new.status in ('SCHEDULED','CONFIRMED','COMPLETED') then
        used_hours := used_hours + extract(epoch from(new.end_time-new.start_time))/3600;
      end if;
      if used_hours > limit_hours + 0.0001 then raise exception 'Authorization no longer has enough hours'; end if;
    end if;
  elsif exists(select 1 from services where id=new.service_id and requires_authorization) then
    raise exception 'This service requires an authorization';
  end if;

  select maximum_hours_per_week,maximum_sessions_per_week
  into max_hours,max_sessions
  from patient_service_requirements
  where patient_id=new.patient_id and service_id=new.service_id
    and effective_start<=local_day and (effective_end is null or effective_end>=local_day)
  order by effective_start desc,created_at desc limit 1;
  if max_hours is not null then
    select coalesce(sum(extract(epoch from(a.end_time-a.start_time))/3600),0)
    into week_hours from appointments a
    where a.patient_id=new.patient_id and a.service_id=new.service_id and a.id<>new.id
      and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
      and (a.start_time at time zone patient_zone)::date between week_start and week_start+6;
    if week_hours+extract(epoch from(new.end_time-new.start_time))/3600>max_hours+0.0001 then
      raise exception 'Appointment would exceed the clinical weekly maximum';
    end if;
  end if;
  if max_sessions is not null then
    select count(*) into week_sessions from appointments a
    where a.patient_id=new.patient_id and a.service_id=new.service_id and a.id<>new.id
      and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
      and (a.start_time at time zone patient_zone)::date between week_start and week_start+6;
    if week_sessions+1>max_sessions then
      raise exception 'Appointment would exceed the clinical weekly session maximum';
    end if;
  end if;

  if new.telehealth and not exists(select 1 from services where id=new.service_id and telehealth_allowed) then
    raise exception 'Selected service does not allow telehealth';
  end if;
  if not new.telehealth and not exists(select 1 from services where id=new.service_id and in_person_allowed) then
    raise exception 'Selected service does not allow in-person delivery';
  end if;
  if not new.telehealth and (new.location_id is null or not exists(
    select 1 from locations where id=new.location_id and active
  )) then raise exception 'An active location is required for in-person care'; end if;
  return new;
end
$integrity$;

create or replace function validate_appointment_resource_capacity() returns trigger
language plpgsql security definer set search_path=public as $resource$
declare
  target appointments%rowtype;
  room resources%rowtype;
  in_use int;
begin
  select * into target from appointments where id=new.appointment_id;
  select * into room from resources where id=new.resource_id for update;
  if not found or not room.active then raise exception 'Room or resource is unavailable'; end if;
  if room.location_id is not null and room.location_id is distinct from target.location_id then
    raise exception 'Room or resource is at a different location';
  end if;
  if not exists(select 1 from service_resources where service_id=target.service_id and resource_id=new.resource_id) then
    raise exception 'Room or resource is not configured for this service';
  end if;
  select count(*) into in_use
  from appointment_resources ar join appointments a on a.id=ar.appointment_id
  where ar.resource_id=new.resource_id and a.id<>new.appointment_id
    and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
    and tstzrange(a.start_time,a.end_time,'[)') && tstzrange(target.start_time,target.end_time,'[)');
  if in_use>=room.capacity then raise exception 'Room or resource reached capacity'; end if;
  return new;
end
$resource$;
drop trigger if exists validate_appointment_resource_capacity_trigger on appointment_resources;
create trigger validate_appointment_resource_capacity_trigger
before insert or update on appointment_resources
for each row execute function validate_appointment_resource_capacity();

-- Recheck already-linked rooms whenever an appointment moves, changes length,
-- is restored, or is inserted. Deferred execution lets the appointment and
-- its resource links be created atomically in either order, while rejecting a
-- transaction that commits an in-person appointment without a required room.
create or replace function validate_appointment_linked_resources() returns trigger
language plpgsql security definer set search_path=public as $linked_resources$
declare
  linked_resource record;
  in_use int;
begin
  if tg_op='UPDATE' and new.status='COMPLETED'
    and old.status in ('SCHEDULED','CONFIRMED')
    and new.service_id=old.service_id
    and new.location_id is not distinct from old.location_id
    and new.start_time=old.start_time and new.end_time=old.end_time
    and new.telehealth=old.telehealth then
    return new;
  end if;
  if new.status not in ('SCHEDULED','CONFIRMED','COMPLETED') or new.telehealth then
    return new;
  end if;
  if exists(
    select 1 from service_resources where service_id=new.service_id and required
  ) and not exists(
    select 1 from appointment_resources ar
    join service_resources sr on sr.resource_id=ar.resource_id
    where ar.appointment_id=new.id and sr.service_id=new.service_id and sr.required
  ) then
    raise exception 'A required room or resource is missing';
  end if;
  for linked_resource in
    select r.id,r.location_id,r.capacity,r.active
    from appointment_resources ar join resources r on r.id=ar.resource_id
    where ar.appointment_id=new.id
    order by r.id
    for update of r
  loop
    if not linked_resource.active
      or (linked_resource.location_id is not null and linked_resource.location_id is distinct from new.location_id)
      or not exists(
        select 1 from service_resources
        where service_id=new.service_id and resource_id=linked_resource.id
      ) then
      raise exception 'A linked room or resource is not valid for this appointment';
    end if;
    select count(*) into in_use
    from appointment_resources ar join appointments a on a.id=ar.appointment_id
    where ar.resource_id=linked_resource.id and a.id<>new.id
      and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
      and tstzrange(a.start_time,a.end_time,'[)') && tstzrange(new.start_time,new.end_time,'[)');
    if in_use>=linked_resource.capacity then
      raise exception 'A linked room or resource reached capacity';
    end if;
  end loop;
  return new;
end
$linked_resources$;
drop trigger if exists validate_appointment_linked_resources_trigger on appointments;
create constraint trigger validate_appointment_linked_resources_trigger
after insert or update of service_id,location_id,start_time,end_time,status,telehealth on appointments
deferrable initially deferred
for each row execute function validate_appointment_linked_resources();

create or replace function validate_resource_link_removal() returns trigger
language plpgsql security definer set search_path=public as $resource_removal$
declare target appointments%rowtype;
begin
  select * into target from appointments where id=old.appointment_id;
  if not found or target.status not in ('SCHEDULED','CONFIRMED','COMPLETED') or target.telehealth then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if exists(
    select 1 from service_resources where service_id=target.service_id and required
  ) and not exists(
    select 1 from appointment_resources ar
    join service_resources sr on sr.resource_id=ar.resource_id
    where ar.appointment_id=target.id and sr.service_id=target.service_id and sr.required
  ) then
    raise exception 'The required room or resource cannot be removed from an active appointment';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end
$resource_removal$;
drop trigger if exists validate_resource_link_removal_trigger on appointment_resources;
create constraint trigger validate_resource_link_removal_trigger
after delete or update on appointment_resources
deferrable initially deferred
for each row execute function validate_resource_link_removal();

-- Audit rows must not become a side channel around patient/contact RLS. Keep
-- operational facts while removing direct identifiers and contact details.
create or replace function redact_audit_row(table_name text, row_data jsonb)
returns jsonb language sql immutable as $redact$
  select case table_name
    when 'patients' then jsonb_build_object(
      'id',row_data->'id','status',row_data->'status',
      'primary_location_id',row_data->'primary_location_id','timezone',row_data->'timezone'
    )
    when 'patient_contacts' then jsonb_build_object(
      'id',row_data->'id','patient_id',row_data->'patient_id',
      'relationship',row_data->'relationship','is_primary',row_data->'is_primary',
      'authorized_to_receive_information',row_data->'authorized_to_receive_information'
    )
    when 'authorizations' then row_data-'authorization_number'-'payer'
    else row_data
  end
$redact$;

create or replace function audit_domain_change() returns trigger
language plpgsql security definer set search_path=public as $domain_audit$
declare before_row jsonb; after_row jsonb; target_patient uuid;
begin
  before_row := case when tg_op='INSERT' then null else redact_audit_row(tg_table_name,to_jsonb(old)) end;
  after_row := case when tg_op='DELETE' then null else redact_audit_row(tg_table_name,to_jsonb(new)) end;
  target_patient := nullif(coalesce(after_row->>'patient_id',before_row->>'patient_id'),'')::uuid;
  insert into audit_log(user_id,action,patient_id,old_values,new_values)
  values(auth.uid(),upper(tg_table_name)||'_'||tg_op,target_patient,before_row,after_row);
  return case when tg_op='DELETE' then old else new end;
end
$domain_audit$;

drop policy if exists "oversight reads audit" on audit_log;
create policy "minimum necessary audit read" on audit_log for select to authenticated using (
  has_app_role(array['COMPLIANCE','OPERATIONS']::app_role[])
  or (current_app_role()='CLINICAL' and (patient_id is null or can_access_patient(patient_id)))
  or (current_app_role()='ADMIN' and patient_id is null)
);

-- A plan is compiled by the server, then submitted here as canonical JSON.
-- This function does not trust the JSON: it serializes approvals by patient,
-- locks every affected record, rechecks live constraints, inserts the whole
-- plan and its audit/change history, and rolls back on the first failure.
create or replace function approve_optimization_plan(
  p_patient_id uuid,
  p_date_start date,
  p_date_end date,
  p_plan_key text,
  p_plan jsonb,
  p_summary jsonb default '{}'::jsonb,
  p_reason text default 'Approved multi-service schedule'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_actor uuid := auth.uid();
  v_role app_role := current_app_role();
  v_request_id uuid;
  v_result_id uuid;
  v_item jsonb;
  v_appointment_id uuid;
  v_service_id uuid;
  v_provider_id uuid;
  v_authorization_id uuid;
  v_location_id uuid;
  v_resource_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_duration numeric;
  v_timezone text;
  v_local_start timestamp;
  v_local_end timestamp;
  v_authorized_hours numeric;
  v_used_hours numeric;
  v_capacity int;
  v_in_use int;
  v_count int := 0;
  v_total_added numeric := 0;
  v_telehealth boolean;
  v_max_hours numeric;
  v_max_sessions int;
  v_week_hours numeric;
  v_week_sessions int;
  v_required_met boolean;
begin
  if v_actor is null or v_role is null or v_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to approve schedules';
  end if;
  if not can_access_patient(p_patient_id) then
    raise exception 'The patient is outside your permitted caseload';
  end if;
  if p_date_end <> p_date_start + 6 or extract(isodow from p_date_start) <> 1 then
    raise exception 'Optimization must cover one Monday-through-Sunday week';
  end if;
  if p_plan_key is null or length(p_plan_key) < 8 then
    raise exception 'Plan identity is missing';
  end if;
  if length(trim(coalesce(p_reason,''))) < 3 then
    raise exception 'A meaningful approval reason is required';
  end if;
  if jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) = 0 or jsonb_array_length(p_plan) > 100 then
    raise exception 'Plan must contain between 1 and 100 appointments';
  end if;
  if pg_column_size(p_plan) > 1048576 or pg_column_size(p_summary) > 262144 then
    raise exception 'Plan payload is too large';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_plan_key, 1));
  select id into v_request_id
  from optimization_requests
  where idempotency_key = p_plan_key
  limit 1;
  if v_request_id is not null then
    return jsonb_build_object('request_id', v_request_id, 'already_committed', true);
  end if;

  -- Prevent another optimizer/manual write for this patient-week from passing
  -- validation between our check and insert.
  perform pg_advisory_xact_lock(hashtextextended(p_patient_id::text || ':' || p_date_start::text, 0));
  select timezone into v_timezone from patients where id = p_patient_id and status = 'ACTIVE' for update;
  if not found then raise exception 'Patient is not active'; end if;

  -- Lock every provider, authorization and resource in a stable order.
  perform 1 from providers
  where id in (select distinct (x->>'provider_id')::uuid from jsonb_array_elements(p_plan) x)
  order by id for update;
  perform 1 from authorizations
  where id in (
    select distinct nullif(x->>'authorization_id','')::uuid
    from jsonb_array_elements(p_plan) x
    where nullif(x->>'authorization_id','') is not null
  ) order by id for update;
  perform 1 from resources
  where id in (
    select distinct jsonb_array_elements_text(coalesce(x->'resource_ids','[]'::jsonb))::uuid
    from jsonb_array_elements(p_plan) x
  ) order by id for update;

  -- Configuration used by validation is locked for the transaction so an
  -- eligibility, credential, availability, clinical, or room edit cannot
  -- race the approval after it has been checked.
  perform 1 from services
  where id in (select distinct (x->>'service_id')::uuid from jsonb_array_elements(p_plan) x)
  order by id for share;
  perform 1 from service_durations
  where service_id in (select distinct (x->>'service_id')::uuid from jsonb_array_elements(p_plan) x)
  order by id for share;
  perform 1 from service_resources
  where service_id in (select distinct (x->>'service_id')::uuid from jsonb_array_elements(p_plan) x)
  order by id for share;
  perform 1 from provider_services
  where provider_id in (select distinct (x->>'provider_id')::uuid from jsonb_array_elements(p_plan) x)
  order by id for share;
  perform 1 from provider_credentials
  where provider_id in (select distinct (x->>'provider_id')::uuid from jsonb_array_elements(p_plan) x)
  order by id for share;
  perform 1 from provider_availability
  where provider_id in (select distinct (x->>'provider_id')::uuid from jsonb_array_elements(p_plan) x)
  order by id for share;
  perform 1 from patient_availability where patient_id=p_patient_id order by id for share;
  perform 1 from patient_restrictions where patient_id=p_patient_id order by id for share;
  perform 1 from patient_preferences where patient_id=p_patient_id order by id for share;
  perform 1 from patient_service_requirements where patient_id=p_patient_id order by id for share;

  insert into optimization_requests(
    requested_by, mode, patient_id, date_start, date_end, objective,
    allow_moves, allow_provider_changes, allow_location_changes,
    max_solutions, status, solver_status, runtime_ms, request_payload,
    completed_at, approved_by, approved_at, decision_reason, idempotency_key
  ) values (
    v_actor, 'OPTIMIZE_PATIENT', p_patient_id, p_date_start, p_date_end,
    'MULTI_SERVICE_CLINICAL_COVERAGE', false, true, false,
    1, 'COMPLETE',
    case when coalesce((p_summary->>'bounded')::boolean, false) then 'TIME_LIMIT'::solver_status else 'FEASIBLE'::solver_status end,
    nullif(p_summary->>'runtime_ms','')::int,
    jsonb_build_object('approved_plan', p_plan, 'summary', p_summary),
    now(), v_actor, now(), nullif(trim(p_reason),''), p_plan_key
  ) returning id into v_request_id;

  insert into optimization_results(
    optimization_request_id, rank, objective_score, service_metrics_json,
    required_services_completed, appointments_added, provider_changes, selected
  ) values (
    v_request_id, 1, coalesce((p_summary->>'added_hours')::numeric, 0),
    coalesce(p_summary->'service_metrics','{}'::jsonb),
    coalesce((p_summary->>'required_services_met')::boolean, false),
    jsonb_array_length(p_plan), coalesce((p_summary->>'provider_changes')::int, 0), true
  ) returning id into v_result_id;

  for v_item in select value from jsonb_array_elements(p_plan)
  loop
    v_service_id := (v_item->>'service_id')::uuid;
    v_provider_id := (v_item->>'provider_id')::uuid;
    v_authorization_id := nullif(v_item->>'authorization_id','')::uuid;
    v_location_id := nullif(v_item->>'location_id','')::uuid;
    v_start := (v_item->>'start_time')::timestamptz;
    v_end := (v_item->>'end_time')::timestamptz;
    v_telehealth := coalesce((v_item->>'telehealth')::boolean, false);
    v_duration := extract(epoch from (v_end - v_start)) / 60;
    v_local_start := v_start at time zone v_timezone;
    v_local_end := v_end at time zone v_timezone;

    if v_end <= v_start or v_local_start::date <> v_local_end::date then
      raise exception 'Appointments must start and end on the same local day';
    end if;
    if extract(second from v_local_start) <> 0 or extract(second from v_local_end) <> 0
      or mod(extract(minute from v_local_start)::int,15) <> 0
      or mod(extract(minute from v_local_end)::int,15) <> 0 then
      raise exception 'Appointments must use 15-minute boundaries';
    end if;
    if v_local_start::date < p_date_start or v_local_start::date > p_date_end then
      raise exception 'Appointment falls outside the approved week';
    end if;
    if not exists(
      select 1 from services s
      where s.id=v_service_id and s.active
        and ((s.in_person_allowed and not v_telehealth) or (s.telehealth_allowed and v_telehealth))
    ) then raise exception 'Service or delivery mode is unavailable'; end if;
    if not v_telehealth and (v_location_id is null or not exists(
      select 1 from locations where id=v_location_id and active
    )) then raise exception 'An active location is required for in-person care'; end if;
    if not exists(
      select 1 from services s
      where s.id=v_service_id and (
        exists(
          select 1 from service_durations d
          where d.service_id=s.id and d.active and d.duration_minutes=v_duration
        ) or (
          not exists(select 1 from service_durations d where d.service_id=s.id and d.active)
          and s.default_duration_minutes=v_duration
        )
      )
    ) then raise exception 'Appointment duration is not configured for the service'; end if;
    if not exists(
      select 1 from providers p join provider_services ps on ps.provider_id=p.id
      where p.id=v_provider_id and p.status='ACTIVE' and ps.service_id=v_service_id and ps.eligible
        and (ps.effective_start is null or ps.effective_start <= v_local_start::date)
        and (ps.effective_end is null or ps.effective_end >= v_local_start::date)
    ) then raise exception 'Clinician is not eligible for the service'; end if;

    -- If credentials are tracked for this clinician, at least one must cover
    -- the whole visit. This mirrors the current engine's fail-open policy for
    -- providers whose credential catalogue has not yet been configured.
    if exists(select 1 from provider_credentials where provider_id=v_provider_id)
      and not exists(
        select 1 from provider_credentials c
        where c.provider_id=v_provider_id and c.status='ACTIVE'
          and (c.issue_date is null or c.issue_date <= v_local_start::date)
          and (c.expiration_date is null or c.expiration_date >= v_local_end::date)
      ) then raise exception 'Clinician credential is not valid for the appointment'; end if;

    if not exists(
      select 1 from patient_availability a
      where a.patient_id=p_patient_id and a.availability_type in ('AVAILABLE','PREFERRED')
        and a.day_of_week=extract(dow from v_local_start)::int
        and a.start_time <= v_local_start::time and a.end_time >= v_local_end::time
        and (a.effective_start is null or a.effective_start <= v_local_start::date)
        and (a.effective_end is null or a.effective_end >= v_local_start::date)
    ) then raise exception 'Patient is not available for the appointment'; end if;
    if exists(
      select 1 from patient_availability a
      where a.patient_id=p_patient_id and a.availability_type='HARD_UNAVAILABLE'
        and a.day_of_week=extract(dow from v_local_start)::int
        and a.start_time < v_local_end::time and a.end_time > v_local_start::time
        and (a.effective_start is null or a.effective_start <= v_local_start::date)
        and (a.effective_end is null or a.effective_end >= v_local_start::date)
    ) then raise exception 'Patient is unavailable for the appointment'; end if;
    if exists(
      select 1 from patient_restrictions r
      where r.patient_id=p_patient_id
        and r.day_of_week=extract(dow from v_local_start)::int
        and r.start_time < v_local_end::time and r.end_time > v_local_start::time
        and (r.service_allowed is null or r.service_allowed <> v_service_id)
        and (r.effective_start is null or r.effective_start <= v_local_start::date)
        and (r.effective_end is null or r.effective_end >= v_local_start::date)
    ) then raise exception 'Appointment conflicts with a patient restriction'; end if;
    if exists(
      select 1 from patient_preferences p
      where p.patient_id=p_patient_id and p.is_hard_constraint
        and (p.preferred_service_id is null or p.preferred_service_id=v_service_id)
        and (
          (p.preferred_provider_id is not null and p.preferred_provider_id<>v_provider_id)
          or (p.preferred_location_id is not null and p.preferred_location_id is distinct from v_location_id)
          or (p.preferred_day is not null and p.preferred_day<>extract(dow from v_local_start)::int)
          or (
            p.preferred_start_time is not null and p.preferred_end_time is not null
            and (p.preferred_start_time>v_local_start::time or p.preferred_end_time<v_local_end::time)
          )
        )
    ) then raise exception 'Appointment violates a required patient preference'; end if;
    if not exists(
      select 1 from provider_availability a
      where a.provider_id=v_provider_id and a.availability_type in ('CLINICAL','PREFERRED')
        and a.day_of_week=extract(dow from v_local_start)::int
        and a.start_time <= v_local_start::time and a.end_time >= v_local_end::time
        and (v_telehealth or a.location_id is null or a.location_id=v_location_id)
        and (a.effective_start is null or a.effective_start <= v_local_start::date)
        and (a.effective_end is null or a.effective_end >= v_local_start::date)
    ) then raise exception 'Clinician is not available for the appointment'; end if;
    if exists(
      select 1 from provider_availability a
      where a.provider_id=v_provider_id and a.availability_type in ('HARD_UNAVAILABLE','PTO')
        and a.day_of_week=extract(dow from v_local_start)::int
        and a.start_time < v_local_end::time and a.end_time > v_local_start::time
        and (a.effective_start is null or a.effective_start <= v_local_start::date)
        and (a.effective_end is null or a.effective_end >= v_local_start::date)
    ) then raise exception 'Clinician is unavailable for the appointment'; end if;

    if exists(
      select 1 from appointments a
      where a.patient_id=p_patient_id and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
        and tstzrange(a.start_time,a.end_time,'[)') && tstzrange(v_start,v_end,'[)')
    ) then raise exception 'The patient was booked while this plan was being reviewed'; end if;
    if exists(
      select 1 from appointments a
      where a.provider_id=v_provider_id and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
        and tstzrange(a.start_time,a.end_time,'[)') && tstzrange(v_start,v_end,'[)')
    ) then raise exception 'The clinician was booked while this plan was being reviewed'; end if;

    -- The application uses a 30-minute default between distinct physical
    -- locations. Recheck it here against both pre-existing and earlier rows in
    -- this transaction so direct RPC calls cannot bypass travel safety.
    if not v_telehealth and exists(
      select 1 from appointments a
      where a.provider_id=v_provider_id and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
        and a.location_id is not null and a.location_id <> v_location_id
        and (
          (a.end_time <= v_start and v_start-a.end_time < interval '30 minutes')
          or (a.start_time >= v_end and a.start_time-v_end < interval '30 minutes')
        )
    ) then raise exception 'There is not enough travel time between locations'; end if;

    if v_authorization_id is not null then
      select case
        when authorized_hours is not null then authorized_hours
        when authorized_units is not null and units_per_hour > 0 then authorized_units / units_per_hour
        else null end
      into v_authorized_hours
      from authorizations
      where id=v_authorization_id and patient_id=p_patient_id and service_id=v_service_id
        and status='ACTIVE' and start_date <= v_local_start::date and end_date >= v_local_end::date;
      if not found then raise exception 'Authorization is no longer valid'; end if;
      if v_authorized_hours is not null then
        select coalesce(sum(extract(epoch from (a.end_time-a.start_time))/3600),0)
        into v_used_hours from appointments a
        where a.authorization_id=v_authorization_id and a.status in ('SCHEDULED','CONFIRMED','COMPLETED');
        if v_used_hours + v_duration/60 > v_authorized_hours + 0.0001 then
          raise exception 'Authorization no longer has enough hours';
        end if;
      end if;
    elsif exists(select 1 from services where id=v_service_id and requires_authorization) then
      raise exception 'This service requires an authorization';
    end if;

    select maximum_hours_per_week, maximum_sessions_per_week
    into v_max_hours, v_max_sessions
    from patient_service_requirements
    where patient_id=p_patient_id and service_id=v_service_id
      and effective_start <= v_local_start::date
      and (effective_end is null or effective_end >= v_local_start::date)
    order by effective_start desc, created_at desc limit 1;
    if v_max_hours is not null then
      select coalesce(sum(extract(epoch from (a.end_time-a.start_time))/3600),0)
      into v_week_hours from appointments a
      where a.patient_id=p_patient_id and a.service_id=v_service_id
        and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
        and (a.start_time at time zone v_timezone)::date between p_date_start and p_date_end;
      if v_week_hours + v_duration/60 > v_max_hours + 0.0001 then
        raise exception 'Plan would exceed the clinical weekly maximum';
      end if;
    end if;
    if v_max_sessions is not null then
      select count(*) into v_week_sessions from appointments a
      where a.patient_id=p_patient_id and a.service_id=v_service_id
        and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
        and (a.start_time at time zone v_timezone)::date between p_date_start and p_date_end;
      if v_week_sessions + 1 > v_max_sessions then
        raise exception 'Plan would exceed the clinical weekly session maximum';
      end if;
    end if;

    if not v_telehealth and exists(
      select 1 from service_resources sr where sr.service_id=v_service_id and sr.required
    ) and not exists(
      select 1 from service_resources sr
      where sr.service_id=v_service_id and sr.required
        and sr.resource_id in (
          select jsonb_array_elements_text(coalesce(v_item->'resource_ids','[]'::jsonb))::uuid
        )
    ) then raise exception 'A required room or resource is missing'; end if;

    for v_resource_id in
      select jsonb_array_elements_text(coalesce(v_item->'resource_ids','[]'::jsonb))::uuid
    loop
      select capacity into v_capacity from resources
      where id=v_resource_id and active and (location_id is null or location_id=v_location_id);
      if not found then raise exception 'A room or resource is unavailable at this location'; end if;
      select count(*) into v_in_use
      from appointment_resources ar join appointments a on a.id=ar.appointment_id
      where ar.resource_id=v_resource_id and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
        and tstzrange(a.start_time,a.end_time,'[)') && tstzrange(v_start,v_end,'[)');
      if v_in_use >= v_capacity then raise exception 'A required room or resource reached capacity'; end if;
    end loop;

    insert into appointments(
      patient_id,service_id,provider_id,authorization_id,location_id,
      start_time,end_time,status,scheduling_flexibility,telehealth,notes,created_by
    ) values (
      p_patient_id,v_service_id,v_provider_id,v_authorization_id,v_location_id,
      v_start,v_end,'SCHEDULED','FLEXIBLE',v_telehealth,
      'Approved optimizer plan ' || v_request_id::text,v_actor
    ) returning id into v_appointment_id;

    insert into appointment_resources(appointment_id,resource_id)
    select v_appointment_id, jsonb_array_elements_text(coalesce(v_item->'resource_ids','[]'::jsonb))::uuid;

    insert into optimization_changes(
      optimization_result_id,appointment_id,action,service_id,new_start,new_end,
      new_provider_id,new_location_id
    ) values (
      v_result_id,v_appointment_id,'ADD',v_service_id,v_start,v_end,v_provider_id,v_location_id
    );
    v_count := v_count + 1;
    v_total_added := v_total_added + v_duration/60;
  end loop;

  select not exists(
    select 1
    from patient_service_requirements r
    where r.patient_id=p_patient_id and r.required
      and r.effective_start <= p_date_end
      and (r.effective_end is null or r.effective_end >= p_date_start)
      and (
        (r.minimum_hours_per_week is not null and r.minimum_hours_per_week > (
          select coalesce(sum(extract(epoch from (a.end_time-a.start_time))/3600),0)
          from appointments a where a.patient_id=p_patient_id and a.service_id=r.service_id
            and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
            and (a.start_time at time zone v_timezone)::date between p_date_start and p_date_end
        ))
        or (r.minimum_sessions_per_week is not null and r.minimum_sessions_per_week > (
          select count(*) from appointments a where a.patient_id=p_patient_id and a.service_id=r.service_id
            and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
            and (a.start_time at time zone v_timezone)::date between p_date_start and p_date_end
        ))
      )
  ) into v_required_met;
  if not v_required_met then
    raise exception 'Plan does not preserve every required clinical minimum';
  end if;
  update optimization_results
  set required_services_completed=v_required_met,
      appointments_added=v_count,
      objective_score=v_total_added
  where id=v_result_id;

  insert into audit_log(user_id,action,patient_id,optimization_request_id,new_values,override_reason)
  values(
    v_actor,'OPTIMIZATION_APPROVED',p_patient_id,v_request_id,
    jsonb_build_object('result_id',v_result_id,'appointments_added',v_count,'added_hours',v_total_added,'required_services_completed',v_required_met),
    nullif(trim(p_reason),'')
  );

  return jsonb_build_object(
    'request_id',v_request_id,'result_id',v_result_id,
    'appointments_added',v_count,'already_committed',false
  );
end
$fn$;

revoke all on function approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text) from public;
grant execute on function approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text) to authenticated;

-- Manual and recurring bookings need the appointment rows and their room
-- links to share one transaction. The deferred required-resource trigger then
-- validates the final batch and a late failure rolls the entire series back.
create or replace function create_appointment_series(
  p_items jsonb,
  p_reason text default 'Manual booking'
)
returns jsonb
language plpgsql
security definer
set search_path=public,extensions
as $series$
declare
  actor uuid:=auth.uid();
  item jsonb;
  new_appointment_id uuid;
  patient_id uuid;
  appointment_ids jsonb:='[]'::jsonb;
begin
  if actor is null or current_app_role() is null or current_app_role() not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to book appointments';
  end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>52 then
    raise exception 'A booking series must contain between 1 and 52 appointments';
  end if;
  if pg_column_size(p_items)>1048576 then raise exception 'Booking payload is too large'; end if;
  for item in select value from jsonb_array_elements(p_items)
  loop
    patient_id:=(item->>'patient_id')::uuid;
    if not can_access_patient(patient_id) then raise exception 'Patient is outside your permitted caseload'; end if;
    if jsonb_typeof(coalesce(item->'resource_ids','[]'::jsonb))<>'array' then
      raise exception 'Resource assignments are invalid';
    end if;
    insert into appointments(
      patient_id,service_id,provider_id,authorization_id,location_id,
      start_time,end_time,status,scheduling_flexibility,telehealth,notes,
      recurrence_group_id,created_by,last_change_reason
    ) values (
      patient_id,(item->>'service_id')::uuid,nullif(item->>'provider_id','')::uuid,
      nullif(item->>'authorization_id','')::uuid,nullif(item->>'location_id','')::uuid,
      (item->>'start_time')::timestamptz,(item->>'end_time')::timestamptz,
      'SCHEDULED',coalesce(nullif(item->>'scheduling_flexibility',''),'FLEXIBLE')::scheduling_flexibility,
      coalesce((item->>'telehealth')::boolean,false),nullif(item->>'notes',''),
      nullif(item->>'recurrence_group_id','')::uuid,actor,nullif(trim(p_reason),'')
    ) returning id into new_appointment_id;
    insert into appointment_resources(appointment_id,resource_id)
    select new_appointment_id,jsonb_array_elements_text(coalesce(item->'resource_ids','[]'::jsonb))::uuid;
    appointment_ids:=appointment_ids||jsonb_build_array(new_appointment_id);
  end loop;
  return jsonb_build_object('appointment_ids',appointment_ids,'appointments_added',jsonb_array_length(appointment_ids));
end
$series$;
revoke all on function create_appointment_series(jsonb,text) from public;
grant execute on function create_appointment_series(jsonb,text) to authenticated;

create or replace function update_appointment_booking(
  p_appointment_id uuid,
  p_provider_id uuid,
  p_location_id uuid,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_status appointment_status,
  p_flexibility scheduling_flexibility,
  p_resource_ids jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path=public,extensions
as $update_booking$
declare
  target appointments%rowtype;
  existing_resources jsonb;
  requested_resources jsonb;
begin
  if auth.uid() is null or current_app_role() is null or current_app_role() not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to update appointments';
  end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'A change reason is required'; end if;
  if jsonb_typeof(coalesce(p_resource_ids,'[]'::jsonb))<>'array' then
    raise exception 'Resource assignments are invalid';
  end if;
  select * into target from appointments where id=p_appointment_id for update;
  if not found then raise exception 'Appointment no longer exists'; end if;
  if not can_access_patient(target.patient_id) then raise exception 'Patient is outside your permitted caseload'; end if;

  select coalesce(jsonb_agg(resource_id::text order by resource_id::text),'[]'::jsonb)
  into existing_resources from appointment_resources where appointment_id=p_appointment_id;
  select coalesce(jsonb_agg(resource_id order by resource_id),'[]'::jsonb)
  into requested_resources
  from jsonb_array_elements_text(coalesce(p_resource_ids,'[]'::jsonb)) as ids(resource_id);

  update appointments set
    provider_id=p_provider_id,location_id=p_location_id,start_time=p_start_time,end_time=p_end_time,
    status=p_status,scheduling_flexibility=p_flexibility,last_change_reason=trim(p_reason)
  where id=p_appointment_id;

  if p_status in ('SCHEDULED','CONFIRMED','COMPLETED')
    and existing_resources is distinct from requested_resources then
    delete from appointment_resources where appointment_id=p_appointment_id;
    insert into appointment_resources(appointment_id,resource_id)
    select p_appointment_id,value::uuid from jsonb_array_elements_text(requested_resources);
  end if;
  return jsonb_build_object('appointment_id',p_appointment_id,'updated',true);
end
$update_booking$;
revoke all on function update_appointment_booking(uuid,uuid,uuid,timestamptz,timestamptz,appointment_status,scheduling_flexibility,jsonb,text) from public;
grant execute on function update_appointment_booking(uuid,uuid,uuid,timestamptz,timestamptz,appointment_status,scheduling_flexibility,jsonb,text) to authenticated;

-- Clinical supervisors can optimize only their caseload, but shared clinicians
-- and rooms may be occupied by another caseload. Return only opaque busy
-- intervals: no patient identity, authorization, notes, or contact data.
create or replace function optimization_busy_intervals(
  p_start timestamptz,
  p_end timestamptz
)
returns table(
  opaque_id text,
  service_id uuid,
  provider_id uuid,
  location_id uuid,
  start_time timestamptz,
  end_time timestamptz,
  telehealth boolean,
  resource_ids uuid[]
)
language plpgsql
security definer
set search_path=public,extensions
as $busy$
begin
  if auth.uid() is null or current_app_role() is null or current_app_role() not in ('SCHEDULER','CLINICAL','PROVIDER','OPERATIONS') then
    raise exception 'Scheduling access required';
  end if;
  if p_end<=p_start or p_end>p_start+interval '370 days' then
    raise exception 'Busy-interval range is invalid';
  end if;
  return query
  select
    'busy:'||md5(a.id::text),a.service_id,a.provider_id,a.location_id,
    a.start_time,a.end_time,a.telehealth,
    coalesce(array_agg(ar.resource_id order by ar.resource_id) filter(where ar.resource_id is not null),'{}'::uuid[])
  from appointments a
  left join appointment_resources ar on ar.appointment_id=a.id
  where a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
    and a.start_time<p_end and a.end_time>p_start
    and not can_access_patient(a.patient_id)
  group by a.id;
end
$busy$;
revoke all on function optimization_busy_intervals(timestamptz,timestamptz) from public;
grant execute on function optimization_busy_intervals(timestamptz,timestamptz) to authenticated;

-- PHI-free practice counts for oversight dashboards. Admin/compliance should
-- not need patient rows merely to know whether the system is active.
create or replace function oversight_metrics(p_date_start date, p_date_end date)
returns jsonb language plpgsql security definer set search_path=public as $metrics$
begin
  if current_app_role() is null or current_app_role() not in ('CLINICAL','OPERATIONS','ADMIN','COMPLIANCE') then
    raise exception 'Oversight access required';
  end if;
  return jsonb_build_object(
    'appointments', (select count(*) from appointments where status in ('SCHEDULED','CONFIRMED','COMPLETED') and start_time::date between p_date_start and p_date_end),
    'services', (select count(*) from services where active),
    'locations', (select count(*) from locations where active),
    'overrides', (select count(*) from audit_log where override_reason is not null and created_at::date between p_date_start and p_date_end),
    'audit_entries', (select count(*) from audit_log)
  );
end
$metrics$;
revoke all on function oversight_metrics(date,date) from public;
grant execute on function oversight_metrics(date,date) to authenticated;

-- The deployment health check calls this through the anonymous REST API. Its
-- presence proves this transactional migration completed; it exposes no
-- tenant or patient data.
create or replace function app_schema_status()
returns jsonb
language sql
stable
security definer
set search_path=public,pg_catalog
as $status$
  select jsonb_build_object(
    'ready', true,
    'version', '20261011030900',
    'optimizer_approval', to_regprocedure('public.approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text)') is not null,
    'atomic_booking', to_regprocedure('public.create_appointment_series(jsonb,text)') is not null,
    'opaque_conflicts', to_regprocedure('public.optimization_busy_intervals(timestamp with time zone,timestamp with time zone)') is not null
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
