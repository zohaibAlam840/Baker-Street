begin;

create type guardian_portal_access_status as enum ('PENDING','ACTIVE','REVOKED');
create type guardian_portal_event_action as enum ('GRANTED','CLAIMED','REVOKED','AUTO_REVOKED');

create table guardian_portal_access (
  id uuid primary key default gen_random_uuid(),
  patient_contact_id uuid not null unique references patient_contacts(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  status guardian_portal_access_status not null default 'PENDING',
  granted_by uuid not null references auth.users(id) on delete restrict,
  granted_at timestamptz not null default now(),
  claimed_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  reason text not null,
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guardian_portal_claim_state check (
    (status='PENDING' and auth_user_id is null and claimed_at is null and revoked_at is null)
    or (status='ACTIVE' and auth_user_id is not null and claimed_at is not null and revoked_at is null)
    or (status='REVOKED' and revoked_at is not null)
  ),
  constraint guardian_portal_reason_length check (length(trim(reason)) between 3 and 500)
);
create index guardian_portal_access_user_idx on guardian_portal_access(auth_user_id)
where auth_user_id is not null and status='ACTIVE';
create trigger guardian_portal_access_set_updated_at before update on guardian_portal_access
for each row execute function set_updated_at();

create table guardian_portal_access_events (
  id uuid primary key default gen_random_uuid(),
  access_id uuid not null references guardian_portal_access(id) on delete cascade,
  patient_contact_id uuid not null references patient_contacts(id) on delete cascade,
  action guardian_portal_event_action not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  reason text not null,
  occurred_at timestamptz not null default now(),
  constraint guardian_portal_event_reason_length check (length(trim(reason)) between 3 and 500)
);
create index guardian_portal_events_access_idx on guardian_portal_access_events(access_id,occurred_at desc);

alter table guardian_portal_access enable row level security;
alter table guardian_portal_access_events enable row level security;

create policy "guardian reads own portal access" on guardian_portal_access
for select to authenticated using (
  auth_user_id=auth.uid() or current_app_role() in ('SCHEDULER','COMPLIANCE')
);
create policy "staff reads guardian portal events" on guardian_portal_access_events
for select to authenticated using (current_app_role() in ('SCHEDULER','COMPLIANCE'));

revoke all on guardian_portal_access,guardian_portal_access_events from public,anon,authenticated;
grant select on guardian_portal_access,guardian_portal_access_events to authenticated;

create function manage_guardian_portal_access(
  p_contact_id uuid,
  p_enable boolean,
  p_expected_version int,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $manage$
declare
  v_actor uuid:=auth.uid();
  v_contact patient_contacts%rowtype;
  v_access guardian_portal_access%rowtype;
  v_action guardian_portal_event_action;
begin
  if v_actor is null or current_app_role()<>'SCHEDULER' then
    raise exception 'Only schedulers may manage guardian portal access';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 500 then
    raise exception 'A reason between 3 and 500 characters is required';
  end if;
  select * into v_contact from patient_contacts where id=p_contact_id for update;
  if not found then raise exception 'Contact not found'; end if;
  select * into v_access from guardian_portal_access where patient_contact_id=p_contact_id for update;

  if p_enable then
    if not v_contact.active or not v_contact.is_legal_guardian
      or not v_contact.authorized_to_receive_information or v_contact.email is null then
      raise exception 'Portal access requires an active authorized legal guardian with email';
    end if;
    if v_access.id is null then
      if p_expected_version<>0 then raise exception 'Portal access changed; refresh and try again'; end if;
      insert into guardian_portal_access(patient_contact_id,status,granted_by,reason)
      values(p_contact_id,'PENDING',v_actor,trim(p_reason)) returning * into v_access;
    else
      if v_access.version<>p_expected_version then raise exception 'Portal access changed; refresh and try again'; end if;
      update guardian_portal_access set
        auth_user_id=null,status='PENDING',granted_by=v_actor,granted_at=clock_timestamp(),
        claimed_at=null,revoked_by=null,revoked_at=null,reason=trim(p_reason),version=version+1
      where id=v_access.id returning * into v_access;
    end if;
    v_action:='GRANTED';
  else
    if v_access.id is null or v_access.version<>p_expected_version then
      raise exception 'Portal access changed; refresh and try again';
    end if;
    update guardian_portal_access set
      status='REVOKED',revoked_by=v_actor,revoked_at=clock_timestamp(),
      reason=trim(p_reason),version=version+1
    where id=v_access.id returning * into v_access;
    v_action:='REVOKED';
  end if;

  insert into guardian_portal_access_events(access_id,patient_contact_id,action,actor_user_id,reason)
  values(v_access.id,p_contact_id,v_action,v_actor,trim(p_reason));
  return jsonb_build_object('id',v_access.id,'status',v_access.status,'version',v_access.version);
end
$manage$;

create function claim_guardian_portal_access() returns int
language plpgsql security definer set search_path=public,auth,pg_catalog as $claim$
declare
  v_actor uuid:=auth.uid();
  v_email text:=lower(trim(coalesce(auth.jwt()->>'email','')));
  v_access record;
  v_count int:=0;
begin
  if v_actor is null or v_email='' then return 0; end if;
  for v_access in
    select g.id,g.patient_contact_id
    from public.guardian_portal_access g
    join public.patient_contacts c on c.id=g.patient_contact_id
    where g.status='PENDING' and g.auth_user_id is null
      and c.active and c.is_legal_guardian and c.authorized_to_receive_information
      and lower(c.email)=v_email
    for update of g
  loop
    update public.guardian_portal_access set
      auth_user_id=v_actor,status='ACTIVE',claimed_at=clock_timestamp(),version=version+1
    where id=v_access.id;
    insert into public.guardian_portal_access_events(
      access_id,patient_contact_id,action,actor_user_id,reason
    ) values(v_access.id,v_access.patient_contact_id,'CLAIMED',v_actor,'Guardian verified the approved email address');
    v_count:=v_count+1;
  end loop;
  return v_count;
end
$claim$;

create function guardian_portal_snapshot() returns jsonb
language sql stable security definer set search_path=public,pg_catalog as $snapshot$
  with permitted as (
    select distinct c.patient_id,c.id as contact_id,c.name as contact_name,c.relationship,g.version
    from guardian_portal_access g
    join patient_contacts c on c.id=g.patient_contact_id
    where g.auth_user_id=auth.uid() and g.status='ACTIVE'
      and c.active and c.is_legal_guardian and c.authorized_to_receive_information
  ), patient_rows as (
    select p.id,p.first_name,p.last_name,p.timezone,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',a.id,'start_time',a.start_time,'end_time',a.end_time,'status',a.status,
          'telehealth',a.telehealth,'service_name',s.service_name,
          'provider_name',case when pr.id is null then null else concat_ws(' ',pr.first_name,pr.last_name) end,
          'location_name',l.name
        ) order by a.start_time)
        from appointments a
        join services s on s.id=a.service_id
        left join providers pr on pr.id=a.provider_id
        left join locations l on l.id=a.location_id
        where a.patient_id=p.id and a.status in ('SCHEDULED','CONFIRMED')
          and a.end_time>=clock_timestamp() and a.start_time<clock_timestamp()+interval '90 days'
      ),'[]'::jsonb) as appointments
    from patients p join (select distinct patient_id from permitted) allowed on allowed.patient_id=p.id
  )
  select jsonb_build_object(
    'access',coalesce((select jsonb_agg(jsonb_build_object(
      'patient_id',patient_id,'contact_id',contact_id,'contact_name',contact_name,
      'relationship',relationship,'version',version
    ) order by patient_id) from permitted),'[]'::jsonb),
    'patients',coalesce((select jsonb_agg(jsonb_build_object(
      'id',id,'first_name',first_name,'last_name',last_name,'timezone',timezone,
      'appointments',appointments
    ) order by last_name,first_name) from patient_rows),'[]'::jsonb)
  )
$snapshot$;

revoke all on function manage_guardian_portal_access(uuid,boolean,int,text) from public,anon;
revoke all on function claim_guardian_portal_access() from public,anon;
revoke all on function guardian_portal_snapshot() from public,anon;
grant execute on function manage_guardian_portal_access(uuid,boolean,int,text) to authenticated;
grant execute on function claim_guardian_portal_access() to authenticated;
grant execute on function guardian_portal_snapshot() to authenticated;

create function revoke_invalid_guardian_portal_access() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $revoke$
begin
  if (old.email is distinct from new.email) or not new.active
    or not new.is_legal_guardian or not new.authorized_to_receive_information then
    with changed as (
      update guardian_portal_access set
        status='REVOKED',revoked_by=null,revoked_at=clock_timestamp(),
        reason='Contact identity or disclosure authority changed',version=version+1
      where patient_contact_id=new.id and status<>'REVOKED'
      returning id,patient_contact_id
    )
    insert into guardian_portal_access_events(access_id,patient_contact_id,action,actor_user_id,reason)
    select id,patient_contact_id,'AUTO_REVOKED',null,'Contact identity or disclosure authority changed'
    from changed;
  end if;
  return new;
end
$revoke$;
create trigger patient_contact_guardian_portal_guard
after update of email,active,is_legal_guardian,authorized_to_receive_information on patient_contacts
for each row execute function revoke_invalid_guardian_portal_access();

alter function app_schema_status() rename to app_schema_status_20261023020000;
revoke all on function app_schema_status_20261023020000() from public,anon,authenticated;
create function app_schema_status() returns jsonb
language sql stable security definer set search_path=public,pg_catalog as $status$
  select app_schema_status_20261023020000() || jsonb_build_object(
    'version','20261024010000',
    'guardian_portal',
      to_regclass('public.guardian_portal_access') is not null
      and to_regprocedure('public.manage_guardian_portal_access(uuid,boolean,integer,text)') is not null
      and to_regprocedure('public.claim_guardian_portal_access()') is not null
      and to_regprocedure('public.guardian_portal_snapshot()') is not null
      and not has_table_privilege('authenticated','public.guardian_portal_access','INSERT,UPDATE,DELETE')
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
