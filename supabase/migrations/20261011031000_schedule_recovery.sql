begin;

-- Mobile-first schedule recovery. Disruptions are the immutable operational
-- event, cases are the affected visits, and offers are typed replacement
-- proposals. All writes use the RPCs below; clients receive scoped reads only.

create table schedule_disruptions (
  id uuid primary key default gen_random_uuid(),
  disruption_type text not null check (disruption_type in ('PROVIDER_CALLOUT','PATIENT_CANCELLATION')),
  provider_id uuid references providers(id) on delete restrict,
  patient_id uuid references patients(id) on delete restrict,
  source_appointment_id uuid references appointments(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'OPEN' check (status in ('OPEN','RESOLVED','CANCELLED','WITHDRAWN')),
  reason_category text not null,
  operational_note text,
  reported_by uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null,
  version int not null default 1 check (version > 0),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < ends_at),
  check (length(idempotency_key) between 8 and 200),
  check (length(reason_category) between 2 and 80),
  check (operational_note is null or length(operational_note) <= 2000),
  check (
    (disruption_type='PROVIDER_CALLOUT' and provider_id is not null and patient_id is null and source_appointment_id is null)
    or
    (disruption_type='PATIENT_CANCELLATION' and provider_id is null and patient_id is not null and source_appointment_id is not null)
  ),
  check (
    (status='OPEN' and resolved_at is null and resolved_by is null)
    or (status in ('RESOLVED','CANCELLED','WITHDRAWN') and resolved_at is not null and resolved_by is not null)
  )
);
create index schedule_disruptions_idempotency_idx
  on schedule_disruptions(reported_by,disruption_type,idempotency_key);
alter table schedule_disruptions add constraint schedule_disruptions_provider_no_overlap
exclude using gist (
  provider_id with =, tstzrange(starts_at,ends_at,'[)') with &&
) where (
  disruption_type='PROVIDER_CALLOUT' and provider_id is not null
  and status not in ('CANCELLED','WITHDRAWN')
);
create index schedule_disruptions_provider_window_idx
  on schedule_disruptions(provider_id,starts_at,ends_at)
  where disruption_type='PROVIDER_CALLOUT' and status not in ('CANCELLED','WITHDRAWN');
create index schedule_disruptions_patient_idx
  on schedule_disruptions(patient_id,created_at desc) where patient_id is not null;

create table recovery_cases (
  id uuid primary key default gen_random_uuid(),
  disruption_id uuid not null references schedule_disruptions(id) on delete restrict,
  original_appointment_id uuid not null references appointments(id) on delete restrict,
  patient_id uuid not null references patients(id) on delete restrict,
  status text not null default 'OPEN' check (status in ('OPEN','OFFERED','DEFERRED','RESOLVED','CLOSED')),
  priority text not null default 'NORMAL' check (priority in ('CRITICAL','HIGH','NORMAL')),
  requires_clinical_review boolean not null default false,
  locked_override_approved boolean not null default false,
  version int not null default 1 check (version > 0),
  original_status appointment_status not null,
  original_flexibility scheduling_flexibility not null,
  original_provider_id uuid references providers(id) on delete set null,
  original_location_id uuid references locations(id) on delete set null,
  original_start_time timestamptz not null,
  original_end_time timestamptz not null,
  deferred_until timestamptz,
  resolution_code text,
  replacement_appointment_id uuid references appointments(id) on delete restrict,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete restrict,
  decision_reason text,
  last_changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(disruption_id,original_appointment_id),
  check (original_start_time < original_end_time),
  check (decision_reason is null or length(decision_reason) <= 1000),
  check (not locked_override_approved or original_flexibility='LOCKED'),
  check (
    (status in ('OPEN','OFFERED','DEFERRED') and resolved_at is null and resolved_by is null
      and resolution_code is null and replacement_appointment_id is null)
    or (status in ('RESOLVED','CLOSED') and resolved_at is not null and resolved_by is not null
      and resolution_code is not null)
  )
);
create unique index recovery_cases_one_active_appointment_idx
  on recovery_cases(original_appointment_id)
  where status in ('OPEN','OFFERED','DEFERRED');
create index recovery_cases_queue_idx on recovery_cases(status,deferred_until,created_at);
create index recovery_cases_patient_idx on recovery_cases(patient_id,created_at desc);

create table recovery_offers (
  id uuid primary key default gen_random_uuid(),
  recovery_case_id uuid not null references recovery_cases(id) on delete restrict,
  candidate_key text not null,
  proposed_provider_id uuid not null references providers(id) on delete restrict,
  proposed_location_id uuid references locations(id) on delete restrict,
  proposed_start_time timestamptz not null,
  proposed_end_time timestamptz not null,
  proposed_telehealth boolean not null default false,
  proposed_authorization_id uuid references authorizations(id) on delete restrict,
  proposed_resource_ids jsonb not null default '[]'::jsonb,
  source_appointment_updated_at timestamptz not null,
  status text not null default 'PENDING' check (status in (
    'PENDING','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN'
  )),
  version int not null default 1 check (version > 0),
  expires_at timestamptz not null,
  created_reason text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  responded_at timestamptz,
  responded_by uuid references auth.users(id) on delete restrict,
  response_reason text,
  committed_appointment_id uuid references appointments(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(candidate_key) between 8 and 500),
  check (proposed_start_time < proposed_end_time),
  check (jsonb_typeof(proposed_resource_ids)='array'),
  check (length(created_reason) between 3 and 1000),
  check (response_reason is null or length(response_reason) <= 1000),
  check (
    (status='PENDING' and responded_at is null and responded_by is null
      and response_reason is null and committed_appointment_id is null)
    or (status='ACCEPTED' and responded_at is not null and responded_by is not null
      and response_reason is not null and committed_appointment_id is not null)
    or (status in ('DECLINED','EXPIRED','WITHDRAWN') and responded_at is not null
      and responded_by is not null and response_reason is not null
      and committed_appointment_id is null)
  )
);
create unique index recovery_offers_one_committed_per_case_idx
  on recovery_offers(recovery_case_id) where status='ACCEPTED';
create unique index recovery_offers_one_pending_candidate_idx
  on recovery_offers(recovery_case_id,candidate_key) where status='PENDING';
create unique index recovery_offers_one_committed_case_idx
  on recovery_offers(recovery_case_id) where committed_appointment_id is not null;
create unique index recovery_offers_committed_appointment_idx
  on recovery_offers(committed_appointment_id) where committed_appointment_id is not null;
create index recovery_offers_active_idx on recovery_offers(recovery_case_id,status,expires_at);
create index recovery_offers_provider_idx on recovery_offers(proposed_provider_id,status,expires_at);

-- One generic replay ledger protects every mobile command carrying a retry key.
-- It contains operational IDs/status only and is never directly readable.
create table recovery_idempotency (
  actor_id uuid not null references auth.users(id) on delete cascade,
  operation text not null,
  idempotency_key text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_id,operation,idempotency_key),
  check (length(operation) between 3 and 80),
  check (length(idempotency_key) between 8 and 200)
);

-- Role notifications need user-specific read state. The legacy read_at column
-- remains usable for notifications already addressed to exactly one user.
create table notification_receipts (
  notification_id uuid not null references notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(notification_id,user_id)
);

create trigger schedule_disruptions_set_updated_at before update on schedule_disruptions
for each row execute function set_updated_at();
create trigger recovery_cases_set_updated_at before update on recovery_cases
for each row execute function set_updated_at();
create trigger recovery_offers_set_updated_at before update on recovery_offers
for each row execute function set_updated_at();
create trigger notification_receipts_set_updated_at before update on notification_receipts
for each row execute function set_updated_at();

alter table schedule_disruptions enable row level security;
alter table recovery_cases enable row level security;
alter table recovery_offers enable row level security;
alter table recovery_idempotency enable row level security;
alter table notification_receipts enable row level security;

create or replace function can_access_recovery_case(target_case uuid)
returns boolean language sql stable security definer set search_path=public as $access$
  select exists(
    select 1 from recovery_cases rc
    where rc.id=target_case and (
      current_app_role()='SCHEDULER'
      or (current_app_role()='CLINICAL' and can_access_patient(rc.patient_id))
    )
  )
$access$;

create or replace function can_access_schedule_disruption(target_disruption uuid)
returns boolean language sql stable security definer set search_path=public as $access$
  select exists(
    select 1 from schedule_disruptions sd
    where sd.id=target_disruption and (
      current_app_role()='SCHEDULER'
      or (current_app_role()='PROVIDER' and sd.provider_id=current_provider_id())
      or (current_app_role()='CLINICAL' and (
        sd.provider_id=current_provider_id() or exists(
          select 1 from recovery_cases rc
          where rc.disruption_id=sd.id and can_access_patient(rc.patient_id)
        )
      ))
    )
  )
$access$;

create or replace function can_access_recovery_offer(target_offer uuid)
returns boolean language sql stable security definer set search_path=public as $access$
  select exists(
    select 1 from recovery_offers ro join recovery_cases rc on rc.id=ro.recovery_case_id
    where ro.id=target_offer and (
      current_app_role()='SCHEDULER'
      or (current_app_role()='CLINICAL' and can_access_patient(rc.patient_id))
    )
  )
$access$;

revoke all on function can_access_recovery_case(uuid) from public;
revoke all on function can_access_schedule_disruption(uuid) from public;
revoke all on function can_access_recovery_offer(uuid) from public;
grant execute on function can_access_recovery_case(uuid),can_access_schedule_disruption(uuid),can_access_recovery_offer(uuid) to authenticated;

create policy "scoped disruption read" on schedule_disruptions for select to authenticated
using (can_access_schedule_disruption(id));
create policy "scoped recovery case read" on recovery_cases for select to authenticated
using (can_access_recovery_case(id));
create policy "scoped recovery offer read" on recovery_offers for select to authenticated
using (can_access_recovery_offer(id));

create policy "own notification receipts read" on notification_receipts for select to authenticated
using (user_id=auth.uid());
create policy "own notification receipts insert" on notification_receipts for insert to authenticated
with check (
  user_id=auth.uid() and exists(
    select 1 from notifications n where n.id=notification_id
      and (n.user_id=auth.uid() or n.role=current_app_role())
  )
);
create policy "own notification receipts update" on notification_receipts for update to authenticated
using (user_id=auth.uid())
with check (
  user_id=auth.uid() and exists(
    select 1 from notifications n where n.id=notification_id
      and (n.user_id=auth.uid() or n.role=current_app_role())
  )
);

revoke all on schedule_disruptions,recovery_cases,recovery_offers,recovery_idempotency,notification_receipts from anon,authenticated;
grant select on schedule_disruptions,recovery_cases,recovery_offers to authenticated;
grant select,insert on notification_receipts to authenticated;
grant update(read_at,dismissed_at) on notification_receipts to authenticated;

-- Appointment lifecycle changes are command-only. Read policies remain, but
-- direct REST writes can no longer bypass recovery/audit invariants.
drop policy if exists "schedulers insert appointments" on appointments;
drop policy if exists "schedulers update appointments" on appointments;
drop policy if exists "schedulers delete appointments" on appointments;
drop policy if exists "appointment resource write" on appointment_resources;
revoke all on appointments,appointment_resources from authenticated;
grant select on appointments,appointment_resources to authenticated;

-- Remove the broad policies that allowed a staff member to manufacture an
-- alert for any user/role or alter the content of a shared role alert.
drop policy if exists "system notifications insert" on notifications;
drop policy if exists "own notifications update" on notifications;
revoke all on notifications from authenticated;
grant select on notifications to authenticated;
grant update(read_at) on notifications to authenticated;
create policy "targeted notification read receipt update" on notifications
for update to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());

create or replace function mark_notification_read(p_notification_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $mark$
declare actor uuid:=auth.uid();
begin
  if actor is null then raise exception 'Authentication required'; end if;
  if not exists(
    select 1 from notifications n where n.id=p_notification_id
      and (n.user_id=actor or n.role=current_app_role())
  ) then raise exception 'Notification is not available'; end if;
  insert into notification_receipts(notification_id,user_id,read_at)
  values(p_notification_id,actor,now())
  on conflict(notification_id,user_id) do update set read_at=excluded.read_at,dismissed_at=null;
  update notifications set read_at=now() where id=p_notification_id and user_id=actor;
  return jsonb_build_object('notification_id',p_notification_id,'read',true);
end
$mark$;
revoke all on function mark_notification_read(uuid) from public;
grant execute on function mark_notification_read(uuid) to authenticated;

-- A callout is a hard, timestamp-based block. The provider row lock makes a
-- concurrent booking and callout serialize; whichever commits second sees the
-- first operation and either records an affected case or rejects the booking.
create or replace function validate_provider_callout_guard() returns trigger
language plpgsql security definer set search_path=public as $guard$
begin
  if tg_op='UPDATE' and new.status='COMPLETED' and old.status in ('SCHEDULED','CONFIRMED')
    and new.provider_id is not distinct from old.provider_id
    and new.start_time=old.start_time and new.end_time=old.end_time then
    return new;
  end if;
  if new.provider_id is null or new.status not in ('SCHEDULED','CONFIRMED','COMPLETED') then return new; end if;
  perform 1 from providers where id=new.provider_id for update;
  if exists(
    select 1 from schedule_disruptions sd
    where sd.disruption_type='PROVIDER_CALLOUT' and sd.status not in ('CANCELLED','WITHDRAWN')
      and sd.provider_id=new.provider_id
      and tstzrange(sd.starts_at,sd.ends_at,'[)') && tstzrange(new.start_time,new.end_time,'[)')
  ) then raise exception 'Clinician is unavailable because of an active callout'; end if;
  return new;
end
$guard$;
drop trigger if exists validate_provider_callout_guard_trigger on appointments;
create trigger validate_provider_callout_guard_trigger
before insert or update of provider_id,start_time,end_time,status on appointments
for each row execute function validate_provider_callout_guard();

create or replace function finish_recovery_disruption(target_disruption uuid,target_actor uuid)
returns void language plpgsql security definer set search_path=public as $finish$
begin
  if exists(
    select 1 from recovery_cases rc where rc.disruption_id=target_disruption
      and rc.status in ('OPEN','OFFERED','DEFERRED')
  ) then
    update schedule_disruptions set status='OPEN',resolved_at=null,resolved_by=null,version=version+1
    where id=target_disruption and status not in ('CANCELLED','WITHDRAWN');
  else
    update schedule_disruptions set status='RESOLVED',resolved_at=coalesce(resolved_at,now()),
      resolved_by=coalesce(resolved_by,target_actor),version=version+1
    where id=target_disruption and status not in ('CANCELLED','WITHDRAWN');
  end if;
end
$finish$;
revoke all on function finish_recovery_disruption(uuid,uuid) from public,authenticated;

create or replace function report_provider_callout(
  p_provider_id uuid,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_reason_category text,
  p_operational_note text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $callout$
declare
  actor uuid:=auth.uid();
  actor_role app_role:=current_app_role();
  prior_result jsonb;
  result jsonb;
  v_disruption_id uuid;
  affected_count int:=0;
  category text;
begin
  if actor is null or actor_role is null then raise exception 'Authentication required'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;
  if p_start_time is null or p_end_time is null or p_end_time<=p_start_time
    or p_end_time<=now() or p_end_time>p_start_time+interval '14 days' then
    raise exception 'Callout window is invalid';
  end if;
  category:=upper(regexp_replace(trim(coalesce(p_reason_category,'')),'\s+','_','g'));
  if category not in ('ILLNESS','EMERGENCY','PTO','TRAINING','OTHER') then
    raise exception 'Callout reason category is not supported';
  end if;
  if length(coalesce(p_operational_note,''))>2000 then raise exception 'Operational note is too long'; end if;

  perform pg_advisory_xact_lock(hashtextextended(actor::text||':PROVIDER_CALLOUT:'||trim(p_idempotency_key),0));
  select ri.result into prior_result from recovery_idempotency ri
  where ri.actor_id=actor and ri.operation='REPORT_PROVIDER_CALLOUT'
    and ri.idempotency_key=trim(p_idempotency_key);
  if found then return prior_result||jsonb_build_object('already_applied',true); end if;

  if actor_role not in ('PROVIDER','SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to report a provider callout';
  end if;
  if actor_role in ('PROVIDER','CLINICAL')
    and (current_provider_id() is null or current_provider_id() is distinct from p_provider_id) then
    raise exception 'Providers and clinical supervisors may only report their own linked callout';
  end if;
  -- Existing appointment updates lock appointment before provider. Match that
  -- order, then re-scan after the provider lock to catch a concurrent insert.
  perform 1 from appointments a
  where a.provider_id=p_provider_id and a.status in ('SCHEDULED','CONFIRMED')
    and tstzrange(a.start_time,a.end_time,'[)') && tstzrange(p_start_time,p_end_time,'[)')
  order by a.id for update;
  perform 1 from providers p where p.id=p_provider_id and p.status='ACTIVE' for update;
  if not found then raise exception 'Active clinician was not found'; end if;
  if exists(
    select 1 from schedule_disruptions sd
    where sd.disruption_type='PROVIDER_CALLOUT'
      and sd.status not in ('CANCELLED','WITHDRAWN') and sd.provider_id=p_provider_id
      and tstzrange(sd.starts_at,sd.ends_at,'[)') && tstzrange(p_start_time,p_end_time,'[)')
  ) then raise exception 'This clinician already has an overlapping callout'; end if;
  perform 1 from appointments a
  where a.provider_id=p_provider_id and a.status in ('SCHEDULED','CONFIRMED')
    and tstzrange(a.start_time,a.end_time,'[)') && tstzrange(p_start_time,p_end_time,'[)')
  order by a.id for update;

  insert into schedule_disruptions(
    disruption_type,provider_id,starts_at,ends_at,status,reason_category,operational_note,reported_by,idempotency_key
  ) values(
    'PROVIDER_CALLOUT',p_provider_id,p_start_time,p_end_time,'OPEN',category,
    nullif(trim(coalesce(p_operational_note,'')),''),actor,trim(p_idempotency_key)
  ) returning id into v_disruption_id;

  insert into recovery_cases(
    disruption_id,original_appointment_id,patient_id,status,priority,requires_clinical_review,
    original_status,original_flexibility,
    original_provider_id,original_location_id,original_start_time,original_end_time,
    decision_reason,last_changed_by
  )
  select v_disruption_id,a.id,a.patient_id,'OPEN',
    case when a.start_time<=now()+interval '24 hours' then 'CRITICAL'
         when a.start_time<=now()+interval '72 hours' then 'HIGH' else 'NORMAL' end,
    (
      a.scheduling_flexibility in ('LOCKED','PROTECTED')
      or exists(
        select 1 from patient_service_requirements psr
        join patients p on p.id=a.patient_id
        where psr.patient_id=a.patient_id and psr.service_id=a.service_id and psr.required
          and psr.effective_start<=(a.start_time at time zone p.timezone)::date
          and (psr.effective_end is null or psr.effective_end>=(a.start_time at time zone p.timezone)::date)
      )
    ),a.status,a.scheduling_flexibility,
    a.provider_id,a.location_id,a.start_time,a.end_time,category,actor
  from appointments a
  where a.provider_id=p_provider_id and a.status in ('SCHEDULED','CONFIRMED')
    and tstzrange(a.start_time,a.end_time,'[)') && tstzrange(p_start_time,p_end_time,'[)')
  order by a.id
  on conflict do nothing;
  get diagnostics affected_count=row_count;

  -- Remove every affected visit from the live schedule in the same commit.
  -- Its original state is retained on the case for recovery or withdrawal.
  update appointments a set
    status='CANCELLED',
    cancellation_reason='Provider unavailable',
    last_change_reason='Provider callout created schedule recovery work'
  from recovery_cases rc
  where rc.disruption_id=v_disruption_id and rc.original_appointment_id=a.id
    and a.status in ('SCHEDULED','CONFIRMED');

  insert into audit_log(user_id,action,new_values,override_reason)
  values(actor,'PROVIDER_CALLOUT_REPORTED',jsonb_build_object(
    'disruption_id',v_disruption_id,'provider_id',p_provider_id,'starts_at',p_start_time,
    'ends_at',p_end_time,'affected_appointments',affected_count,'reason_category',category
  ),category);
  insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
  select actor,'RECOVERY_CASE_OPENED',rc.patient_id,rc.original_appointment_id,
    jsonb_build_object('case_id',rc.id,'disruption_id',v_disruption_id,'flexibility',rc.original_flexibility),category
  from recovery_cases rc where rc.disruption_id=v_disruption_id;

  insert into notifications(user_id,kind,title,body,href,severity,dedupe_key,expires_at)
  select up.user_id,'SCHEDULE_RECOVERY','Schedule recovery needs review',
    affected_count::text||case when affected_count=1 then ' visit is' else ' visits are' end||' affected by a staff callout.',
    '/recovery?disruption='||v_disruption_id,'CRITICAL','recovery-callout-'||v_disruption_id,
    greatest(p_end_time,now()+interval '1 day')
  from user_profiles up where up.active and up.role='SCHEDULER'
  on conflict(user_id,dedupe_key) where user_id is not null and dedupe_key is not null do nothing;

  result:=jsonb_build_object(
    'disruption_id',v_disruption_id,'affected_count',affected_count,'status','OPEN','already_applied',false
  );
  insert into recovery_idempotency(actor_id,operation,idempotency_key,result)
  values(actor,'REPORT_PROVIDER_CALLOUT',trim(p_idempotency_key),result);
  return result;
end
$callout$;
revoke all on function report_provider_callout(uuid,timestamptz,timestamptz,text,text,text) from public;
grant execute on function report_provider_callout(uuid,timestamptz,timestamptz,text,text,text) to authenticated;

create or replace function report_patient_cancellation(
  p_appointment_id uuid,
  p_reason text,
  p_create_recovery boolean,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $cancellation$
declare
  v_actor uuid:=auth.uid();
  v_actor_role app_role:=current_app_role();
  v_target appointments%rowtype;
  v_prior_case recovery_cases%rowtype;
  v_prior_result jsonb;
  v_result jsonb;
  v_disruption_id uuid;
  v_case_id uuid;
  v_existing_disruption_id uuid;
  v_existing_case_id uuid;
  v_existing_recovery_requested boolean;
  v_old_disruption uuid;
  v_original_status appointment_status;
  v_original_flexibility scheduling_flexibility;
  v_original_provider_id uuid;
  v_original_location_id uuid;
  v_original_start_time timestamptz;
  v_original_end_time timestamptz;
  v_requires_clinical_review boolean;
begin
  if v_actor is null or v_actor_role is null then raise exception 'Authentication required'; end if;
  if v_actor_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to record a patient cancellation';
  end if;
  if length(trim(coalesce(p_reason,'')))<3 or length(p_reason)>1000 then
    raise exception 'A cancellation reason between 3 and 1000 characters is required';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':PATIENT_CANCELLATION:'||trim(p_idempotency_key),0));
  select ri.result into v_prior_result from recovery_idempotency ri
  where ri.actor_id=v_actor and ri.operation='REPORT_PATIENT_CANCELLATION'
    and ri.idempotency_key=trim(p_idempotency_key);

  select * into v_target from appointments a where a.id=p_appointment_id for update;
  if not found then raise exception 'Appointment was not found'; end if;
  if not can_access_patient(v_target.patient_id) then raise exception 'Patient is outside your permitted caseload'; end if;
  if v_prior_result is not null then
    return v_prior_result||jsonb_build_object('already_applied',true);
  end if;

  select sd.id,rc.id,
    case when rc.id is null then sd.status='OPEN'
         else rc.resolution_code is distinct from 'CANCELLATION_NO_RECOVERY' end
  into v_existing_disruption_id,v_existing_case_id,v_existing_recovery_requested
  from schedule_disruptions sd
  left join recovery_cases rc on rc.disruption_id=sd.id
  where sd.disruption_type='PATIENT_CANCELLATION'
    and sd.source_appointment_id=p_appointment_id
    and sd.created_at>=v_target.updated_at
  order by sd.created_at desc limit 1;

  -- A cancelled row is idempotent only when it already has an actual patient
  -- cancellation event. A provider callout cancellation must be superseded.
  if v_target.status='CANCELLED' and v_existing_disruption_id is not null then
    v_result:=jsonb_build_object(
      'disruption_id',v_existing_disruption_id,'case_id',v_existing_case_id,'appointment_id',p_appointment_id,
      'status','CANCELLED','recovery_requested',coalesce(v_existing_recovery_requested,false),
      'already_applied',true
    );
    insert into recovery_idempotency(actor_id,operation,idempotency_key,result)
    values(v_actor,'REPORT_PATIENT_CANCELLATION',trim(p_idempotency_key),v_result)
    on conflict(actor_id,operation,idempotency_key) do update set result=excluded.result;
    return v_result;
  end if;

  if v_target.status in ('SCHEDULED','CONFIRMED') then
    v_original_status:=v_target.status;
    v_original_flexibility:=v_target.scheduling_flexibility;
    v_original_provider_id:=v_target.provider_id;
    v_original_location_id:=v_target.location_id;
    v_original_start_time:=v_target.start_time;
    v_original_end_time:=v_target.end_time;
    select v_target.scheduling_flexibility in ('LOCKED','PROTECTED') or exists(
      select 1 from patient_service_requirements psr
      join patients p on p.id=v_target.patient_id
      where psr.patient_id=v_target.patient_id and psr.service_id=v_target.service_id and psr.required
        and psr.effective_start<=(v_target.start_time at time zone p.timezone)::date
        and (psr.effective_end is null or psr.effective_end>=(v_target.start_time at time zone p.timezone)::date)
    ) into v_requires_clinical_review;
  elsif v_target.status='CANCELLED' then
    select * into v_prior_case from recovery_cases rc
    where rc.original_appointment_id=p_appointment_id
      and rc.status in ('OPEN','OFFERED','DEFERRED')
    order by rc.created_at desc limit 1 for update;
    if not found then
      raise exception 'Cancelled appointment has no active recovery case to supersede';
    end if;
    v_original_status:=v_prior_case.original_status;
    v_original_flexibility:=v_prior_case.original_flexibility;
    v_original_provider_id:=v_prior_case.original_provider_id;
    v_original_location_id:=v_prior_case.original_location_id;
    v_original_start_time:=v_prior_case.original_start_time;
    v_original_end_time:=v_prior_case.original_end_time;
    v_requires_clinical_review:=v_prior_case.requires_clinical_review;
  else
    raise exception 'Only scheduled or confirmed appointments can be cancelled';
  end if;

  for v_old_disruption in
    select rc.disruption_id from recovery_cases rc
    where rc.original_appointment_id=p_appointment_id and rc.status in ('OPEN','OFFERED','DEFERRED')
    order by rc.disruption_id for update of rc
  loop
    update recovery_offers set status='WITHDRAWN',version=version+1,responded_at=now(),
      responded_by=v_actor,response_reason='Superseded by patient cancellation'
    where recovery_case_id in(
      select id from recovery_cases
      where disruption_id=v_old_disruption and original_appointment_id=p_appointment_id
    ) and status='PENDING';
    update recovery_cases set status='CLOSED',resolution_code='SUPERSEDED_BY_PATIENT_CANCELLATION',
      resolved_at=now(),resolved_by=v_actor,decision_reason=trim(p_reason),last_changed_by=v_actor,version=version+1
    where disruption_id=v_old_disruption and original_appointment_id=p_appointment_id
      and status in ('OPEN','OFFERED','DEFERRED');
    perform finish_recovery_disruption(v_old_disruption,v_actor);
  end loop;

  update appointments set status='CANCELLED',cancellation_reason=trim(p_reason),
    last_change_reason='Patient cancellation reported for schedule recovery'
  where id=p_appointment_id;

  insert into schedule_disruptions(
    disruption_type,patient_id,source_appointment_id,starts_at,ends_at,status,reason_category,
    operational_note,reported_by,idempotency_key,resolved_at,resolved_by
  ) values(
    'PATIENT_CANCELLATION',v_target.patient_id,p_appointment_id,v_original_start_time,v_original_end_time,
    case when coalesce(p_create_recovery,false) then 'OPEN' else 'RESOLVED' end,
    'PATIENT_CANCELLATION',trim(p_reason),v_actor,trim(p_idempotency_key),
    case when coalesce(p_create_recovery,false) then null else now() end,
    case when coalesce(p_create_recovery,false) then null else v_actor end
  ) returning id into v_disruption_id;

  insert into recovery_cases(
    disruption_id,original_appointment_id,patient_id,status,priority,requires_clinical_review,
    original_status,original_flexibility,
    original_provider_id,original_location_id,original_start_time,original_end_time,
    resolution_code,resolved_at,resolved_by,decision_reason,last_changed_by
  ) values(
    v_disruption_id,p_appointment_id,v_target.patient_id,
    case when coalesce(p_create_recovery,false) then 'OPEN' else 'CLOSED' end,
    case when v_original_start_time<=now()+interval '24 hours' then 'CRITICAL'
         when v_original_start_time<=now()+interval '72 hours' then 'HIGH' else 'NORMAL' end,
    v_requires_clinical_review,
    v_original_status,v_original_flexibility,v_original_provider_id,v_original_location_id,
    v_original_start_time,v_original_end_time,
    case when coalesce(p_create_recovery,false) then null else 'CANCELLATION_NO_RECOVERY' end,
    case when coalesce(p_create_recovery,false) then null else now() end,
    case when coalesce(p_create_recovery,false) then null else v_actor end,
    trim(p_reason),v_actor
  ) returning id into v_case_id;

  insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
  values(v_actor,'PATIENT_CANCELLATION_REPORTED',v_target.patient_id,p_appointment_id,
    jsonb_build_object('disruption_id',v_disruption_id,'case_id',v_case_id,'recovery_requested',coalesce(p_create_recovery,false)),
    trim(p_reason));

  if coalesce(p_create_recovery,false) then
    insert into notifications(user_id,kind,title,body,href,severity,dedupe_key,expires_at)
    select up.user_id,'SCHEDULE_RECOVERY','Cancelled visit needs recovery',
      'A cancelled visit is ready for replacement planning.',
      '/recovery/'||v_case_id,'WARNING','recovery-cancellation-'||v_case_id,
      greatest(v_original_end_time,now()+interval '1 day')
    from user_profiles up where up.active and up.role='SCHEDULER'
    on conflict(user_id,dedupe_key) where user_id is not null and dedupe_key is not null do nothing;
  end if;

  v_result:=jsonb_build_object(
    'disruption_id',v_disruption_id,'case_id',v_case_id,'appointment_id',p_appointment_id,
    'status','CANCELLED','recovery_requested',coalesce(p_create_recovery,false),'already_applied',false
  );
  insert into recovery_idempotency(actor_id,operation,idempotency_key,result)
  values(v_actor,'REPORT_PATIENT_CANCELLATION',trim(p_idempotency_key),v_result)
  on conflict(actor_id,operation,idempotency_key) do update set result=excluded.result;
  return v_result;
end
$cancellation$;
revoke all on function report_patient_cancellation(uuid,text,boolean,text) from public;
grant execute on function report_patient_cancellation(uuid,text,boolean,text) to authenticated;

create or replace function create_recovery_offer(
  p_case_id uuid,
  p_expected_version int,
  p_candidate_key text,
  p_provider_id uuid,
  p_location_id uuid,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_telehealth boolean,
  p_authorization_id uuid,
  p_resource_ids jsonb,
  p_expires_at timestamptz,
  p_reason text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $offer$
declare
  actor uuid:=auth.uid();
  actor_role app_role:=current_app_role();
  target_case recovery_cases%rowtype;
  target appointments%rowtype;
  existing_offer recovery_offers%rowtype;
  normalized_resources jsonb:='[]'::jsonb;
  v_offer_id uuid;
  patient_zone text;
  local_day date;
  expired_offer_count int:=0;
  result jsonb;
begin
  if actor is null or actor_role is null then raise exception 'Authentication required'; end if;
  if actor_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to create recovery offers';
  end if;
  if length(trim(coalesce(p_candidate_key,''))) not between 8 and 500 then
    raise exception 'Candidate identity is invalid';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'An offer reason between 3 and 1000 characters is required';
  end if;
  if p_start_time is null or p_end_time is null or p_start_time<=now() or p_end_time<=p_start_time then
    raise exception 'Proposed appointment window is invalid';
  end if;
  if p_expires_at is null or p_expires_at<=now()+interval '1 minute'
    or p_expires_at>now()+interval '7 days' or p_expires_at>=p_start_time then
    raise exception 'Offer expiration must be between one minute and seven days from now';
  end if;
  if jsonb_typeof(coalesce(p_resource_ids,'[]'::jsonb))<>'array'
    or jsonb_array_length(coalesce(p_resource_ids,'[]'::jsonb))>20 then
    raise exception 'Resource assignments are invalid';
  end if;
  select coalesce(jsonb_agg(to_jsonb(r.resource_id::text) order by r.resource_id::text),'[]'::jsonb)
  into normalized_resources
  from (
    select distinct value::uuid resource_id
    from jsonb_array_elements_text(coalesce(p_resource_ids,'[]'::jsonb)) values_list(value)
  ) r;

  select * into target_case from recovery_cases rc where rc.id=p_case_id;
  if not found then raise exception 'Recovery case was not found'; end if;
  if not can_access_patient(target_case.patient_id) then raise exception 'Patient is outside your permitted caseload'; end if;

  -- Appointment -> provider -> case matches the existing booking write gate.
  select * into target from appointments a
  where a.id=target_case.original_appointment_id for update;
  if not found then raise exception 'Affected appointment was not found'; end if;
  select * into target_case from recovery_cases rc where rc.id=p_case_id for update;
  if not found then raise exception 'Recovery case was not found'; end if;

  update recovery_offers set status='EXPIRED',version=version+1,responded_at=now(),
    responded_by=actor,response_reason='Offer expired before a new attempt was recorded'
  where recovery_case_id=p_case_id and status='PENDING' and expires_at<=now();
  get diagnostics expired_offer_count=row_count;
  if expired_offer_count>0 then
    insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
    values(actor,'RECOVERY_OFFERS_EXPIRED',target_case.patient_id,target_case.original_appointment_id,
      jsonb_build_object('case_id',p_case_id,'expired_count',expired_offer_count),
      'Expired before a new recovery offer was recorded');
  end if;

  select * into existing_offer from recovery_offers ro
  where ro.recovery_case_id=p_case_id and ro.candidate_key=trim(p_candidate_key)
    and ro.status='PENDING' and ro.expires_at>now();
  if found then
    if existing_offer.proposed_provider_id is distinct from p_provider_id
      or existing_offer.proposed_location_id is distinct from p_location_id
      or existing_offer.proposed_start_time<>p_start_time
      or existing_offer.proposed_end_time<>p_end_time
      or existing_offer.proposed_telehealth<>coalesce(p_telehealth,false)
      or existing_offer.proposed_authorization_id is distinct from p_authorization_id
      or existing_offer.proposed_resource_ids<>normalized_resources then
      raise exception 'Candidate identity was reused with different appointment details';
    end if;
    return jsonb_build_object(
      'offer_id',existing_offer.id,'case_id',p_case_id,'status',existing_offer.status,
      'offer_version',existing_offer.version,'case_version',target_case.version,'already_applied',true
    );
  end if;

  if p_expected_version is null or target_case.version<>p_expected_version then
    raise exception 'Recovery case changed; refresh before creating an offer';
  end if;
  if target_case.status in ('RESOLVED','CLOSED') then raise exception 'Recovery case is already closed'; end if;
  if target_case.original_flexibility='LOCKED' and not target_case.locked_override_approved then
    raise exception 'Locked visits require clinical release before a recovery offer';
  end if;

  if target.status not in ('SCHEDULED','CONFIRMED','CANCELLED') then
    raise exception 'Affected appointment is no longer recoverable';
  end if;
  if p_end_time-p_start_time<>target_case.original_end_time-target_case.original_start_time then
    raise exception 'A recovery offer must preserve the visit duration';
  end if;

  select p.timezone into patient_zone from patients p where p.id=target_case.patient_id;
  patient_zone:=coalesce(patient_zone,'America/New_York');
  local_day:=(p_start_time at time zone patient_zone)::date;

  if not exists(
    select 1 from providers p join provider_services ps on ps.provider_id=p.id
    where p.id=p_provider_id and p.status='ACTIVE' and ps.service_id=target.service_id and ps.eligible
      and (ps.effective_start is null or ps.effective_start<=local_day)
      and (ps.effective_end is null or ps.effective_end>=local_day)
  ) then raise exception 'Proposed clinician is not eligible for this service'; end if;
  if coalesce(p_telehealth,false) and not exists(
    select 1 from services s where s.id=target.service_id and s.active and s.telehealth_allowed
  ) then raise exception 'Service does not allow telehealth'; end if;
  if not coalesce(p_telehealth,false) and (
    p_location_id is null or not exists(select 1 from locations l where l.id=p_location_id and l.active)
    or not exists(select 1 from services s where s.id=target.service_id and s.active and s.in_person_allowed)
  ) then raise exception 'An active permitted location is required for in-person care'; end if;
  if p_authorization_id is not null and not exists(
    select 1 from authorizations a where a.id=p_authorization_id
      and a.patient_id=target.patient_id and a.service_id=target.service_id
      and a.status='ACTIVE' and a.start_date<=local_day and a.end_date>=local_day
  ) then raise exception 'Proposed authorization is not valid for this appointment'; end if;
  if p_authorization_id is null and exists(
    select 1 from services s where s.id=target.service_id and s.requires_authorization
  ) then raise exception 'This service requires an authorization'; end if;
  if exists(
    select 1 from jsonb_array_elements_text(normalized_resources) x(value)
    where not exists(
      select 1 from service_resources sr join resources r on r.id=sr.resource_id
      where sr.service_id=target.service_id and sr.resource_id=x.value::uuid and r.active
        and (r.location_id is null or r.location_id=p_location_id)
    )
  ) then raise exception 'A proposed room or resource is not valid for this service and location'; end if;
  if not coalesce(p_telehealth,false) and exists(
    select 1 from service_resources sr where sr.service_id=target.service_id and sr.required
  ) and not exists(
    select 1 from service_resources sr
    where sr.service_id=target.service_id and sr.required
      and sr.resource_id in(select value::uuid from jsonb_array_elements_text(normalized_resources) x(value))
  ) then raise exception 'A required room or resource is missing'; end if;
  if exists(
    select 1 from schedule_disruptions sd
    where sd.disruption_type='PROVIDER_CALLOUT'
      and sd.status not in ('CANCELLED','WITHDRAWN') and sd.provider_id=p_provider_id
      and tstzrange(sd.starts_at,sd.ends_at,'[)') && tstzrange(p_start_time,p_end_time,'[)')
  ) then raise exception 'Proposed clinician has an active callout during this time'; end if;

  insert into recovery_offers(
    recovery_case_id,candidate_key,proposed_provider_id,proposed_location_id,
    proposed_start_time,proposed_end_time,proposed_telehealth,proposed_authorization_id,
    proposed_resource_ids,source_appointment_updated_at,status,expires_at,created_reason,created_by
  ) values(
    p_case_id,trim(p_candidate_key),p_provider_id,p_location_id,p_start_time,p_end_time,
    coalesce(p_telehealth,false),p_authorization_id,normalized_resources,target.updated_at,
    'PENDING',p_expires_at,trim(p_reason),actor
  ) returning id into v_offer_id;

  update recovery_cases set status='OFFERED',deferred_until=null,decision_reason=trim(p_reason),
    last_changed_by=actor,version=version+1 where id=p_case_id;

  insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
  values(actor,'RECOVERY_OFFER_CREATED',target.patient_id,target.id,jsonb_build_object(
    'case_id',p_case_id,'offer_id',v_offer_id,'provider_id',p_provider_id,
    'start_time',p_start_time,'end_time',p_end_time,
    'requires_clinical_review',target_case.requires_clinical_review
  ),trim(p_reason));

  insert into notifications(user_id,kind,title,body,href,severity,dedupe_key,expires_at)
  select up.user_id,'RECOVERY_OFFER','Recovery option recorded',
    'Open the secure recovery queue to review the pending schedule option.',
    '/recovery/'||p_case_id,'WARNING','recovery-offer-'||v_offer_id,p_expires_at
  from user_profiles up
  where up.active and (
    up.role='SCHEDULER'
    or (up.role='CLINICAL' and target_case.requires_clinical_review and exists(
      select 1 from patient_care_team pct
      where pct.patient_id=target_case.patient_id and pct.provider_id=up.provider_id
        and pct.active and pct.effective_start<=current_date
        and (pct.effective_end is null or pct.effective_end>=current_date)
    ))
  )
  on conflict(user_id,dedupe_key) where user_id is not null and dedupe_key is not null do nothing;

  result:=jsonb_build_object(
    'offer_id',v_offer_id,'case_id',p_case_id,'status','PENDING','offer_version',1,
    'case_version',p_expected_version+1,'requires_clinical_review',target_case.requires_clinical_review,
    'already_applied',false
  );
  return result;
end
$offer$;
revoke all on function create_recovery_offer(uuid,int,text,uuid,uuid,timestamptz,timestamptz,boolean,uuid,jsonb,timestamptz,text) from public;
grant execute on function create_recovery_offer(uuid,int,text,uuid,uuid,timestamptz,timestamptz,boolean,uuid,jsonb,timestamptz,text) to authenticated;

create or replace function expire_recovery_offers(p_case_id uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $expire$
declare
  v_actor uuid:=auth.uid();
  v_actor_role app_role:=current_app_role();
  v_probe recovery_cases%rowtype;
  v_case recovery_cases%rowtype;
  v_expired_count int:=0;
  v_case_changed boolean:=false;
begin
  if v_actor is null or v_actor_role is null or v_actor_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to refresh recovery offers';
  end if;
  select * into v_probe from recovery_cases rc where rc.id=p_case_id;
  if not found then raise exception 'Recovery case was not found'; end if;
  if not can_access_patient(v_probe.patient_id) then
    raise exception 'Patient is outside your permitted caseload';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('RECOVERY_DISRUPTION:'||v_probe.disruption_id::text,0));
  select * into v_case from recovery_cases rc where rc.id=p_case_id for update;
  update recovery_offers set status='EXPIRED',version=version+1,responded_at=now(),
    responded_by=v_actor,response_reason='Offer expired before case refresh'
  where recovery_case_id=p_case_id and status='PENDING' and expires_at<=now();
  get diagnostics v_expired_count=row_count;

  if v_expired_count>0 and v_case.status='OFFERED' and not exists(
    select 1 from recovery_offers ro
    where ro.recovery_case_id=p_case_id and ro.status='PENDING' and ro.expires_at>now()
  ) then
    update recovery_cases set status='OPEN',deferred_until=null,
      decision_reason='All pending recovery offers expired',last_changed_by=v_actor,
      version=version+1 where id=p_case_id;
    v_case_changed:=true;
  end if;
  if v_expired_count>0 then
    insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
    values(v_actor,'RECOVERY_OFFERS_EXPIRED',v_case.patient_id,v_case.original_appointment_id,
      jsonb_build_object(
        'case_id',p_case_id,'expired_count',v_expired_count,'case_reopened',v_case_changed
      ),'Expired during recovery case refresh');
  end if;
  return jsonb_build_object(
    'case_id',p_case_id,'expired_count',v_expired_count,
    'case_version',v_case.version+case when v_case_changed then 1 else 0 end,
    'case_reopened',v_case_changed
  );
end
$expire$;
revoke all on function expire_recovery_offers(uuid) from public;
grant execute on function expire_recovery_offers(uuid) to authenticated;

-- Bounded queue maintenance for mobile clients and scheduled workers. The
-- queue keeps the same role/caseload boundary as the single-case command and
-- delegates every state transition to that command so audit/version behavior
-- cannot drift. A non-blocking disruption lock lets concurrent workers divide
-- work without processing the same disruption or deadlocking across cases.
create or replace function expire_recovery_offer_queue(p_limit int)
returns jsonb language plpgsql security definer set search_path=public,extensions as $expire_queue$
declare
  v_actor uuid:=auth.uid();
  v_actor_role app_role:=current_app_role();
  v_candidate record;
  v_case_result jsonb;
  v_processed_count int:=0;
  v_expired_count int:=0;
  v_reopened_count int:=0;
begin
  if v_actor is null or v_actor_role is null
    or v_actor_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to refresh the recovery queue';
  end if;
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'Recovery queue batch limit must be between 1 and 100';
  end if;

  for v_candidate in
    select rc.id,rc.disruption_id,
      (
        select min(ro.expires_at)
        from recovery_offers ro
        where ro.recovery_case_id=rc.id and ro.status='PENDING'
          and ro.expires_at<=now()
      ) as oldest_expiration
    from recovery_cases rc
    where rc.status='OFFERED'
      and (
        v_actor_role='SCHEDULER'
        or (v_actor_role='CLINICAL' and can_access_patient(rc.patient_id))
      )
      and exists(
        select 1 from recovery_offers ro
        where ro.recovery_case_id=rc.id and ro.status='PENDING'
          and ro.expires_at<=now()
      )
    order by oldest_expiration,rc.created_at,rc.id
    limit p_limit
  loop
    if not pg_try_advisory_xact_lock(
      hashtextextended('RECOVERY_DISRUPTION:'||v_candidate.disruption_id::text,0)
    ) then
      continue;
    end if;
    v_case_result:=expire_recovery_offers(v_candidate.id);
    v_processed_count:=v_processed_count+1;
    v_expired_count:=v_expired_count+coalesce((v_case_result->>'expired_count')::int,0);
    if coalesce((v_case_result->>'case_reopened')::boolean,false) then
      v_reopened_count:=v_reopened_count+1;
    end if;
  end loop;

  return jsonb_build_object(
    'processed_count',v_processed_count,
    'expired_count',v_expired_count,
    'reopened_count',v_reopened_count
  );
end
$expire_queue$;
revoke all on function expire_recovery_offer_queue(int) from public;
grant execute on function expire_recovery_offer_queue(int) to authenticated;

create or replace function respond_recovery_offer(
  p_offer_id uuid,
  p_expected_version int,
  p_decision text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $response$
declare
  v_actor uuid:=auth.uid();
  v_actor_role app_role:=current_app_role();
  v_decision text:=upper(trim(coalesce(p_decision,'')));
  v_offer_probe recovery_offers%rowtype;
  v_offer recovery_offers%rowtype;
  v_case_probe recovery_cases%rowtype;
  v_case recovery_cases%rowtype;
  v_original appointments%rowtype;
  v_prior_result jsonb;
  v_result jsonb;
  v_next_case_status text;
  v_replacement_id uuid;
  v_patient_zone text;
  v_replacement_day date;
  v_other_expired_count int:=0;
begin
  if v_actor is null or v_actor_role is null then raise exception 'Authentication required'; end if;
  if v_actor_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to respond to recovery offers';
  end if;
  if p_expected_version is null or p_expected_version<1 then
    raise exception 'A valid recovery case version is required';
  end if;
  if v_decision='ACCEPT' then v_decision:='ACCEPTED'; end if;
  if v_decision='DECLINE' then v_decision:='DECLINED'; end if;
  if v_decision not in ('ACCEPTED','DECLINED') then
    raise exception 'Offer decision must be ACCEPTED or DECLINED';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'A response reason between 3 and 1000 characters is required';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':RECOVERY_OFFER_RESPONSE:'||trim(p_idempotency_key),0));
  select ri.result into v_prior_result from recovery_idempotency ri
  where ri.actor_id=v_actor and ri.operation='RESPOND_RECOVERY_OFFER'
    and ri.idempotency_key=trim(p_idempotency_key);
  if found then return v_prior_result||jsonb_build_object('already_applied',true); end if;

  select * into v_offer_probe from recovery_offers ro where ro.id=p_offer_id;
  if not found then raise exception 'Recovery offer was not found'; end if;
  select * into v_case_probe from recovery_cases rc where rc.id=v_offer_probe.recovery_case_id;
  if not found then raise exception 'Recovery case was not found'; end if;
  if not can_access_patient(v_case_probe.patient_id) then
    raise exception 'Patient is outside your permitted caseload';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('RECOVERY_DISRUPTION:'||v_case_probe.disruption_id::text,0));
  select * into v_original from appointments a
  where a.id=v_case_probe.original_appointment_id for update;
  if not found then raise exception 'Original appointment was not found'; end if;
  select * into v_case from recovery_cases rc where rc.id=v_case_probe.id for update;
  select * into v_offer from recovery_offers ro where ro.id=p_offer_id for update;
  if v_offer.recovery_case_id<>v_case.id then raise exception 'Recovery offer changed; refresh and try again'; end if;
  if v_case.version<>p_expected_version then
    raise exception 'Recovery case changed; refresh before responding';
  end if;
  if v_case.status not in ('OPEN','OFFERED','DEFERRED') then
    raise exception 'Recovery case is already closed';
  end if;

  update recovery_offers set status='EXPIRED',version=version+1,responded_at=now(),
    responded_by=v_actor,response_reason='Offer expired before another response was recorded'
  where recovery_case_id=v_case.id and id<>v_offer.id and status='PENDING' and expires_at<=now();
  get diagnostics v_other_expired_count=row_count;
  if v_other_expired_count>0 then
    insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
    values(v_actor,'RECOVERY_OFFERS_EXPIRED',v_case.patient_id,v_case.original_appointment_id,
      jsonb_build_object('case_id',v_case.id,'expired_count',v_other_expired_count),
      'Expired during recovery response');
  end if;
  if v_offer.status<>'PENDING' then raise exception 'Recovery offer was already answered'; end if;

  if v_offer.expires_at<=now() then
    update recovery_offers set status='EXPIRED',version=version+1,responded_at=now(),
      responded_by=v_actor,response_reason='Offer expired before response'
    where id=v_offer.id;
    select case when exists(
      select 1 from recovery_offers ro
      where ro.recovery_case_id=v_case.id and ro.id<>v_offer.id and ro.status='PENDING'
        and ro.expires_at>now()
    ) then 'OFFERED' else 'OPEN' end into v_next_case_status;
    update recovery_cases set status=v_next_case_status,deferred_until=null,
      decision_reason='Offer expired before response',last_changed_by=v_actor,version=version+1
    where id=v_case.id;
    insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
    values(v_actor,'RECOVERY_OFFER_EXPIRED',v_case.patient_id,v_case.original_appointment_id,
      jsonb_build_object('case_id',v_case.id,'offer_id',v_offer.id),'Offer expired before response');
    v_result:=jsonb_build_object(
      'offer_id',v_offer.id,'case_id',v_case.id,'status','EXPIRED',
      'case_version',p_expected_version+1,'already_applied',false
    );
    insert into recovery_idempotency(actor_id,operation,idempotency_key,result)
    values(v_actor,'RESPOND_RECOVERY_OFFER',trim(p_idempotency_key),v_result);
    return v_result;
  end if;

  if v_decision='DECLINED' then
    update recovery_offers set status='DECLINED',version=version+1,responded_at=now(),
      responded_by=v_actor,response_reason=trim(p_reason)
    where id=v_offer.id;
    select case when exists(
      select 1 from recovery_offers ro
      where ro.recovery_case_id=v_case.id and ro.id<>v_offer.id and ro.status='PENDING'
        and ro.expires_at>now()
    ) then 'OFFERED' else 'OPEN' end into v_next_case_status;
    update recovery_cases set status=v_next_case_status,deferred_until=null,
      decision_reason=trim(p_reason),last_changed_by=v_actor,version=version+1
    where id=v_case.id;
    insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
    values(v_actor,'RECOVERY_OFFER_DECLINED',v_case.patient_id,v_case.original_appointment_id,
      jsonb_build_object('case_id',v_case.id,'offer_id',v_offer.id),trim(p_reason));
    v_result:=jsonb_build_object(
      'offer_id',v_offer.id,'case_id',v_case.id,'status','DECLINED',
      'case_version',p_expected_version+1,'already_applied',false
    );
    insert into recovery_idempotency(actor_id,operation,idempotency_key,result)
    values(v_actor,'RESPOND_RECOVERY_OFFER',trim(p_idempotency_key),v_result);
    return v_result;
  end if;

  if v_case.original_flexibility='LOCKED' and not v_case.locked_override_approved then
    raise exception 'Locked visits require clinical release before acceptance';
  end if;
  if v_case.requires_clinical_review and v_actor_role<>'CLINICAL' then
    raise exception 'Clinical approval is required for this recovery case';
  end if;
  if v_original.updated_at is distinct from v_offer.source_appointment_updated_at then
    raise exception 'Original appointment changed after this offer was created';
  end if;
  if v_original.status not in ('SCHEDULED','CONFIRMED','CANCELLED') then
    raise exception 'Original appointment is no longer recoverable';
  end if;
  if exists(
    select 1 from recovery_offers ro
    where ro.recovery_case_id=v_case.id and ro.committed_appointment_id is not null
  ) then raise exception 'A replacement has already been committed for this case'; end if;
  if exists(
    select 1 from schedule_disruptions sd where sd.id=v_case.disruption_id
      and sd.status in ('CANCELLED','WITHDRAWN')
  ) then raise exception 'The underlying disruption is no longer active'; end if;

  -- Free the original occupancy before proving and inserting its replacement.
  if v_original.status in ('SCHEDULED','CONFIRMED') then
    update appointments set status='CANCELLED',
      cancellation_reason='Replaced through schedule recovery',
      last_change_reason='Original visit replaced through schedule recovery'
    where id=v_original.id;
  end if;

  insert into appointments(
    patient_id,service_id,provider_id,authorization_id,location_id,start_time,end_time,
    status,scheduling_flexibility,telehealth,notes,recurrence_group_id,created_by,
    original_start_time,original_provider_id,original_location_id,last_change_reason
  ) values(
    v_original.patient_id,v_original.service_id,v_offer.proposed_provider_id,
    v_offer.proposed_authorization_id,v_offer.proposed_location_id,
    v_offer.proposed_start_time,v_offer.proposed_end_time,v_case.original_status,
    case when v_case.original_flexibility='LOCKED' and v_case.locked_override_approved
      then 'PROTECTED'::scheduling_flexibility else v_case.original_flexibility end,
    v_offer.proposed_telehealth,v_original.notes,
    v_original.recurrence_group_id,v_actor,v_case.original_start_time,
    v_case.original_provider_id,v_case.original_location_id,trim(p_reason)
  ) returning id into v_replacement_id;

  insert into appointment_resources(appointment_id,resource_id)
  select v_replacement_id,x.value::uuid
  from jsonb_array_elements_text(v_offer.proposed_resource_ids) x(value)
  order by x.value::uuid;

  select coalesce(p.timezone,'America/New_York') into v_patient_zone
  from patients p where p.id=v_case.patient_id;
  v_replacement_day:=(v_offer.proposed_start_time at time zone v_patient_zone)::date;
  insert into patient_care_team(
    patient_id,provider_id,relationship,effective_start,effective_end,active,created_by
  ) values(
    v_case.patient_id,v_offer.proposed_provider_id,'TREATING_PROVIDER',current_date,
    greatest(current_date,v_replacement_day),true,v_actor
  )
  on conflict(patient_id,provider_id,relationship,effective_start) do update set
    active=true,
    effective_end=case when patient_care_team.effective_end is null then null
      else greatest(patient_care_team.effective_end,excluded.effective_end) end;

  update recovery_offers set status='ACCEPTED',version=version+1,responded_at=now(),
    responded_by=v_actor,response_reason=trim(p_reason),committed_appointment_id=v_replacement_id
  where id=v_offer.id;
  update recovery_offers set status='WITHDRAWN',version=version+1,responded_at=now(),
    responded_by=v_actor,response_reason='Another recovery option was accepted'
  where recovery_case_id=v_case.id and id<>v_offer.id and status='PENDING';
  update recovery_cases set status='RESOLVED',replacement_appointment_id=v_replacement_id,
    resolution_code='RECOVERY_OFFER_ACCEPTED',deferred_until=null,resolved_at=now(),
    resolved_by=v_actor,decision_reason=trim(p_reason),last_changed_by=v_actor,version=version+1
  where id=v_case.id;
  perform finish_recovery_disruption(v_case.disruption_id,v_actor);

  insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
  values(v_actor,'RECOVERY_OFFER_ACCEPTED',v_case.patient_id,v_replacement_id,
    jsonb_build_object(
      'case_id',v_case.id,'offer_id',v_offer.id,
      'original_appointment_id',v_case.original_appointment_id,
      'replacement_appointment_id',v_replacement_id,
      'provider_id',v_offer.proposed_provider_id,
      'start_time',v_offer.proposed_start_time,'end_time',v_offer.proposed_end_time
    ),trim(p_reason));

  insert into notifications(user_id,kind,title,body,href,severity,dedupe_key,expires_at)
  select up.user_id,'RECOVERY_RESOLVED','Recovery visit scheduled',
    'A recovery case was resolved. Open the secure app for details.',
    '/appointments/'||v_replacement_id,'INFO','recovery-accepted-'||v_case.id,
    v_offer.proposed_end_time+interval '1 day'
  from user_profiles up
  where up.active and (
    up.role='SCHEDULER' or exists(
      select 1 from patient_care_team pct
      where pct.patient_id=v_case.patient_id and pct.provider_id=up.provider_id
        and pct.active and pct.effective_start<=current_date
        and (pct.effective_end is null or pct.effective_end>=current_date)
    )
  )
  on conflict(user_id,dedupe_key) where user_id is not null and dedupe_key is not null do nothing;

  v_result:=jsonb_build_object(
    'offer_id',v_offer.id,'case_id',v_case.id,'status','ACCEPTED',
    'appointment_id',v_replacement_id,'case_version',p_expected_version+1,
    'already_applied',false
  );
  insert into recovery_idempotency(actor_id,operation,idempotency_key,result)
  values(v_actor,'RESPOND_RECOVERY_OFFER',trim(p_idempotency_key),v_result);
  return v_result;
end
$response$;
revoke all on function respond_recovery_offer(uuid,int,text,text,text) from public;
grant execute on function respond_recovery_offer(uuid,int,text,text,text) to authenticated;

create or replace function set_recovery_case_state(
  p_case_id uuid,
  p_expected_version int,
  p_status text,
  p_reason text,
  p_deferred_until timestamptz
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $case_state$
declare
  v_actor uuid:=auth.uid();
  v_actor_role app_role:=current_app_role();
  v_status text:=upper(trim(coalesce(p_status,'')));
  v_probe recovery_cases%rowtype;
  v_case recovery_cases%rowtype;
  v_result jsonb;
begin
  if v_actor is null or v_actor_role is null then raise exception 'Authentication required'; end if;
  if v_actor_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to manage recovery cases';
  end if;
  if p_expected_version is null or p_expected_version<1 then
    raise exception 'A valid recovery case version is required';
  end if;
  if v_status not in ('OPEN','DEFERRED','CLOSED') then
    raise exception 'Recovery case state must be OPEN, DEFERRED, or CLOSED';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'A decision reason between 3 and 1000 characters is required';
  end if;
  if v_status='DEFERRED' and (
    p_deferred_until is null or p_deferred_until<=now()
    or p_deferred_until>now()+interval '7 days'
  ) then raise exception 'Deferred cases require a future time within seven days'; end if;
  if v_status<>'DEFERRED' and p_deferred_until is not null then
    raise exception 'Only deferred cases may include a deferred-until time';
  end if;

  select * into v_probe from recovery_cases rc where rc.id=p_case_id;
  if not found then raise exception 'Recovery case was not found'; end if;
  if not can_access_patient(v_probe.patient_id) then
    raise exception 'Patient is outside your permitted caseload';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('RECOVERY_DISRUPTION:'||v_probe.disruption_id::text,0));
  select * into v_case from recovery_cases rc where rc.id=p_case_id for update;

  -- Lost mobile responses can safely replay a just-completed transition.
  if v_case.version=p_expected_version+1 and v_case.status=v_status
    and v_case.last_changed_by=v_actor and v_case.decision_reason=trim(p_reason) then
    return jsonb_build_object(
      'case_id',v_case.id,'status',v_case.status,'case_version',v_case.version,
      'deferred_until',case when v_case.status='DEFERRED' then v_case.deferred_until else null end,
      'already_applied',true
    );
  end if;
  if v_case.version<>p_expected_version then
    raise exception 'Recovery case changed; refresh before updating it';
  end if;
  if v_case.status in ('RESOLVED','CLOSED') then raise exception 'Recovery case is already closed'; end if;
  if v_status='CLOSED' and v_case.requires_clinical_review and v_actor_role<>'CLINICAL' then
    raise exception 'Clinical approval is required to close this recovery case';
  end if;

  if v_status='CLOSED' then
    update recovery_offers set status='WITHDRAWN',version=version+1,responded_at=now(),
      responded_by=v_actor,response_reason=left('Recovery case closed: '||trim(p_reason),1000)
    where recovery_case_id=v_case.id and status='PENDING';
    update recovery_cases set status='CLOSED',deferred_until=null,
      resolution_code='MANUAL_CLOSE',resolved_at=now(),resolved_by=v_actor,
      decision_reason=trim(p_reason),last_changed_by=v_actor,version=version+1
    where id=v_case.id;
    perform finish_recovery_disruption(v_case.disruption_id,v_actor);
  elsif v_status='DEFERRED' then
    update recovery_cases set status='DEFERRED',deferred_until=p_deferred_until,
      decision_reason=trim(p_reason),last_changed_by=v_actor,version=version+1
    where id=v_case.id;
  else
    update recovery_offers set status='WITHDRAWN',version=version+1,responded_at=now(),
      responded_by=v_actor,response_reason=left('Case returned to open queue: '||trim(p_reason),1000)
    where recovery_case_id=v_case.id and status='PENDING';
    update recovery_cases set status='OPEN',deferred_until=null,
      decision_reason=trim(p_reason),last_changed_by=v_actor,version=version+1
    where id=v_case.id;
  end if;

  insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
  values(v_actor,'RECOVERY_CASE_'||v_status,v_case.patient_id,v_case.original_appointment_id,
    jsonb_build_object(
      'case_id',v_case.id,'status',v_status,
      'deferred_until',case when v_status='DEFERRED' then p_deferred_until else null end
    ),trim(p_reason));

  v_result:=jsonb_build_object(
    'case_id',v_case.id,'status',v_status,'case_version',p_expected_version+1,
    'deferred_until',case when v_status='DEFERRED' then p_deferred_until else null end,
    'already_applied',false
  );
  return v_result;
end
$case_state$;
revoke all on function set_recovery_case_state(uuid,int,text,text,timestamptz) from public;
grant execute on function set_recovery_case_state(uuid,int,text,text,timestamptz) to authenticated;

create or replace function restore_cancelled_appointment(
  p_appointment_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $restore$
declare
  v_actor uuid:=auth.uid();
  v_actor_role app_role:=current_app_role();
  v_target appointments%rowtype;
  v_case recovery_cases%rowtype;
  v_prior_result jsonb;
  v_result jsonb;
  v_disruption_id uuid;
  v_restore_status appointment_status;
  v_patient_zone text;
  v_local_day date;
  v_week_start date;
begin
  if v_actor is null or v_actor_role is null then raise exception 'Authentication required'; end if;
  if v_actor_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to restore appointments';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'A restore reason between 3 and 1000 characters is required';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':RESTORE_CANCELLED_APPOINTMENT:'||trim(p_idempotency_key),0));
  select ri.result into v_prior_result from recovery_idempotency ri
  where ri.actor_id=v_actor and ri.operation='RESTORE_CANCELLED_APPOINTMENT'
    and ri.idempotency_key=trim(p_idempotency_key);

  select * into v_target from appointments a where a.id=p_appointment_id for update;
  if not found then raise exception 'Appointment was not found'; end if;
  if not can_access_patient(v_target.patient_id) then
    raise exception 'Patient is outside your permitted caseload';
  end if;
  if v_prior_result is not null then
    return v_prior_result||jsonb_build_object('already_applied',true);
  end if;
  if v_target.status<>'CANCELLED' then
    raise exception 'Only a cancelled appointment can be restored';
  end if;
  if v_target.start_time<=now() then
    raise exception 'Past appointments cannot be restored';
  end if;

  select * into v_case from recovery_cases rc
  where rc.original_appointment_id=p_appointment_id
  order by (rc.status in ('OPEN','OFFERED','DEFERRED')) desc,rc.created_at desc
  limit 1 for update;

  if not found then
    -- Preserve a recovery/audit envelope for legacy cancellations created
    -- before direct appointment DML was removed.
    insert into schedule_disruptions(
      disruption_type,patient_id,source_appointment_id,starts_at,ends_at,status,
      reason_category,operational_note,reported_by,idempotency_key
    ) values(
      'PATIENT_CANCELLATION',v_target.patient_id,v_target.id,v_target.start_time,v_target.end_time,
      'OPEN','LEGACY_CANCELLATION','Legacy cancelled visit restored through recovery',
      v_actor,'legacy-'||left(md5(v_target.id::text||clock_timestamp()::text),26)
    ) returning id into v_disruption_id;
    insert into recovery_cases(
      disruption_id,original_appointment_id,patient_id,status,priority,requires_clinical_review,
      original_status,original_flexibility,original_provider_id,original_location_id,
      original_start_time,original_end_time,decision_reason,last_changed_by
    ) values(
      v_disruption_id,v_target.id,v_target.patient_id,'OPEN','NORMAL',
      (
        v_target.scheduling_flexibility in ('LOCKED','PROTECTED')
        or exists(
          select 1 from patient_service_requirements psr
          join patients p on p.id=v_target.patient_id
          where psr.patient_id=v_target.patient_id and psr.service_id=v_target.service_id and psr.required
            and psr.effective_start<=(v_target.start_time at time zone p.timezone)::date
            and (psr.effective_end is null or psr.effective_end>=(v_target.start_time at time zone p.timezone)::date)
        )
      ),'SCHEDULED',
      v_target.scheduling_flexibility,v_target.provider_id,v_target.location_id,
      v_target.start_time,v_target.end_time,'Legacy cancellation restore',v_actor
    ) returning * into v_case;
  end if;

  if exists(
    select 1 from recovery_offers ro join recovery_cases rc on rc.id=ro.recovery_case_id
    where rc.original_appointment_id=p_appointment_id
      and ro.committed_appointment_id is not null
  ) then raise exception 'A committed replacement exists; the original appointment cannot be restored'; end if;
  if v_case.requires_clinical_review and v_actor_role<>'CLINICAL' then
    raise exception 'Clinical approval is required to restore this appointment';
  end if;

  v_restore_status:=case when v_case.original_status in ('SCHEDULED','CONFIRMED')
    then v_case.original_status else 'SCHEDULED' end;
  select coalesce(p.timezone,'America/New_York') into v_patient_zone
  from patients p where p.id=v_target.patient_id;
  v_local_day:=(v_target.start_time at time zone v_patient_zone)::date;
  v_week_start:=v_local_day-(extract(isodow from v_local_day)::int-1);
  perform pg_advisory_xact_lock(hashtextextended(v_target.patient_id::text||':'||v_week_start::text,0));

  update appointments set status=v_restore_status,cancellation_reason=null,
    last_change_reason=trim(p_reason)
  where id=p_appointment_id;

  update recovery_offers set status='WITHDRAWN',version=version+1,responded_at=now(),
    responded_by=v_actor,response_reason=left('Original appointment restored: '||trim(p_reason),1000)
  where recovery_case_id in(
    select rc.id from recovery_cases rc
    where rc.original_appointment_id=p_appointment_id
      and rc.status in ('OPEN','OFFERED','DEFERRED')
  ) and status='PENDING';
  update recovery_cases set status='RESOLVED',replacement_appointment_id=null,
    resolution_code='ORIGINAL_APPOINTMENT_RESTORED',deferred_until=null,resolved_at=now(),
    resolved_by=v_actor,decision_reason=trim(p_reason),last_changed_by=v_actor,version=version+1
  where original_appointment_id=p_appointment_id and (
    status in ('OPEN','OFFERED','DEFERRED')
    or (id=v_case.id and status='CLOSED' and resolution_code='CANCELLATION_NO_RECOVERY')
  );
  for v_disruption_id in
    select rc.disruption_id from recovery_cases rc
    where rc.original_appointment_id=p_appointment_id
      and rc.resolution_code='ORIGINAL_APPOINTMENT_RESTORED'
      and rc.resolved_at=now() and rc.resolved_by=v_actor
    order by rc.disruption_id
  loop
    perform finish_recovery_disruption(v_disruption_id,v_actor);
  end loop;

  insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
  values(v_actor,'RECOVERY_ORIGINAL_RESTORED',v_target.patient_id,p_appointment_id,
    jsonb_build_object('case_id',v_case.id,'restored_status',v_restore_status),trim(p_reason));

  v_result:=jsonb_build_object(
    'appointment_id',p_appointment_id,'case_id',v_case.id,'status',v_restore_status,
    'already_applied',false
  );
  insert into recovery_idempotency(actor_id,operation,idempotency_key,result)
  values(v_actor,'RESTORE_CANCELLED_APPOINTMENT',trim(p_idempotency_key),v_result)
  on conflict(actor_id,operation,idempotency_key) do update set result=excluded.result;
  return v_result;
end
$restore$;
revoke all on function restore_cancelled_appointment(uuid,text,text) from public;
grant execute on function restore_cancelled_appointment(uuid,text,text) to authenticated;

create or replace function withdraw_provider_callout(
  p_disruption_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $withdraw$
declare
  v_actor uuid:=auth.uid();
  v_actor_role app_role:=current_app_role();
  v_probe schedule_disruptions%rowtype;
  v_disruption schedule_disruptions%rowtype;
  v_case record;
  v_lock_key record;
  v_prior_result jsonb;
  v_result jsonb;
  v_restored_count int:=0;
  v_past_count int:=0;
begin
  if v_actor is null or v_actor_role is null then raise exception 'Authentication required'; end if;
  if v_actor_role not in ('SCHEDULER','CLINICAL','PROVIDER') then
    raise exception 'You do not have permission to withdraw provider callouts';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'A withdrawal reason between 3 and 1000 characters is required';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':WITHDRAW_PROVIDER_CALLOUT:'||trim(p_idempotency_key),0));
  select ri.result into v_prior_result from recovery_idempotency ri
  where ri.actor_id=v_actor and ri.operation='WITHDRAW_PROVIDER_CALLOUT'
    and ri.idempotency_key=trim(p_idempotency_key);
  if found then return v_prior_result||jsonb_build_object('already_applied',true); end if;

  select * into v_probe from schedule_disruptions sd where sd.id=p_disruption_id;
  if not found or v_probe.disruption_type<>'PROVIDER_CALLOUT' then
    raise exception 'Provider callout was not found';
  end if;
  if v_actor_role in ('PROVIDER','CLINICAL') and (
    current_provider_id() is null or current_provider_id() is distinct from v_probe.provider_id
  ) then raise exception 'Providers and clinical supervisors may only withdraw their own callout'; end if;

  perform pg_advisory_xact_lock(hashtextextended('RECOVERY_DISRUPTION:'||p_disruption_id::text,0));

  -- Lock originals first, matching appointment command ordering, then cases.
  perform 1 from appointments a join recovery_cases rc on rc.original_appointment_id=a.id
  where rc.disruption_id=p_disruption_id
  order by a.id for update of a;
  perform 1 from recovery_cases rc where rc.disruption_id=p_disruption_id
  order by rc.id for update;
  select * into v_disruption from schedule_disruptions sd
  where sd.id=p_disruption_id for update;

  if v_disruption.status='WITHDRAWN' then
    v_result:=jsonb_build_object(
      'disruption_id',v_disruption.id,'status','WITHDRAWN','restored_count',0,'already_applied',true
    );
    insert into recovery_idempotency(actor_id,operation,idempotency_key,result)
    values(v_actor,'WITHDRAW_PROVIDER_CALLOUT',trim(p_idempotency_key),v_result);
    return v_result;
  end if;
  if v_disruption.status not in ('OPEN','RESOLVED') then
    raise exception 'Provider callout can no longer be withdrawn';
  end if;
  if exists(
    select 1 from recovery_offers ro join recovery_cases rc on rc.id=ro.recovery_case_id
    where rc.disruption_id=p_disruption_id and ro.committed_appointment_id is not null
  ) then raise exception 'A replacement was already committed; the callout cannot be withdrawn'; end if;

  -- Acquire the same patient-week advisory keys as appointment validation in
  -- deterministic order before restoring a batch.
  for v_lock_key in
    select distinct a.patient_id,
      (
        (a.start_time at time zone coalesce(p.timezone,'America/New_York'))::date
        - (extract(isodow from (a.start_time at time zone coalesce(p.timezone,'America/New_York'))::date)::int-1)
      )::date as week_start
    from recovery_cases rc
    join appointments a on a.id=rc.original_appointment_id
    join patients p on p.id=a.patient_id
    where rc.disruption_id=p_disruption_id
      and rc.resolution_code is distinct from 'SUPERSEDED_BY_PATIENT_CANCELLATION'
      and a.status='CANCELLED'
      and rc.original_start_time>now()
    order by a.patient_id,week_start
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key.patient_id::text||':'||v_lock_key.week_start::text,0));
  end loop;

  -- Remove the callout guard before restoration; every other live scheduling
  -- rule still executes. Any conflict rolls back this whole command.
  update schedule_disruptions set status='WITHDRAWN',resolved_at=now(),resolved_by=v_actor,
    version=version+1 where id=p_disruption_id;

  for v_case in
    select rc.*,a.status as appointment_status
    from recovery_cases rc join appointments a on a.id=rc.original_appointment_id
    where rc.disruption_id=p_disruption_id
      and rc.resolution_code is distinct from 'SUPERSEDED_BY_PATIENT_CANCELLATION'
    order by rc.original_appointment_id
  loop
    if v_case.original_start_time<=now() then
      v_past_count:=v_past_count+1;
      if v_case.appointment_status='CANCELLED' then
        insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
        values(v_actor,'RECOVERY_PAST_ORIGINAL_NOT_RESTORED',v_case.patient_id,v_case.original_appointment_id,
          jsonb_build_object('case_id',v_case.id,'disruption_id',p_disruption_id),trim(p_reason));
      end if;
    elsif v_case.appointment_status='CANCELLED' then
      update appointments set
        status=case when v_case.original_status in ('SCHEDULED','CONFIRMED')
          then v_case.original_status else 'SCHEDULED' end,
        cancellation_reason=null,
        last_change_reason=trim(p_reason)
      where id=v_case.original_appointment_id;
      v_restored_count:=v_restored_count+1;
      insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
      values(v_actor,'RECOVERY_ORIGINAL_RESTORED',v_case.patient_id,v_case.original_appointment_id,
        jsonb_build_object('case_id',v_case.id,'disruption_id',p_disruption_id),trim(p_reason));
    end if;
  end loop;

  update recovery_offers set status='WITHDRAWN',version=version+1,responded_at=now(),
    responded_by=v_actor,response_reason=left('Provider callout withdrawn: '||trim(p_reason),1000)
  where recovery_case_id in(
    select rc.id from recovery_cases rc where rc.disruption_id=p_disruption_id
  ) and status='PENDING';
  update recovery_cases set
    status=case when original_start_time<=now() then 'CLOSED' else 'RESOLVED' end,
    replacement_appointment_id=null,
    resolution_code=case when original_start_time<=now()
      then 'PROVIDER_CALLOUT_WITHDRAWN_AFTER_VISIT_START'
      else 'PROVIDER_CALLOUT_WITHDRAWN' end,
    deferred_until=null,resolved_at=now(),
    resolved_by=v_actor,decision_reason=trim(p_reason),last_changed_by=v_actor,version=version+1
  where disruption_id=p_disruption_id
    and resolution_code is distinct from 'SUPERSEDED_BY_PATIENT_CANCELLATION';

  insert into audit_log(user_id,action,new_values,override_reason)
  values(v_actor,'PROVIDER_CALLOUT_WITHDRAWN',jsonb_build_object(
    'disruption_id',p_disruption_id,'provider_id',v_disruption.provider_id,
    'restored_appointments',v_restored_count,'past_appointments_not_restored',v_past_count
  ),trim(p_reason));
  v_result:=jsonb_build_object(
    'disruption_id',p_disruption_id,'status','WITHDRAWN',
    'restored_count',v_restored_count,'past_count',v_past_count,'already_applied',false
  );
  insert into recovery_idempotency(actor_id,operation,idempotency_key,result)
  values(v_actor,'WITHDRAW_PROVIDER_CALLOUT',trim(p_idempotency_key),v_result);
  return v_result;
end
$withdraw$;
revoke all on function withdraw_provider_callout(uuid,text,text) from public;
grant execute on function withdraw_provider_callout(uuid,text,text) to authenticated;

create or replace function release_locked_recovery_case(
  p_case_id uuid,
  p_expected_version int,
  p_reason text
)
returns jsonb language plpgsql security definer set search_path=public,extensions as $release_locked$
declare
  v_actor uuid:=auth.uid();
  v_actor_role app_role:=current_app_role();
  v_probe recovery_cases%rowtype;
  v_case recovery_cases%rowtype;
begin
  if v_actor is null or v_actor_role is null or v_actor_role<>'CLINICAL' then
    raise exception 'Clinical approval is required to release a locked recovery case';
  end if;
  if p_expected_version is null or p_expected_version<1 then
    raise exception 'A valid recovery case version is required';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'An approval reason between 3 and 1000 characters is required';
  end if;
  select * into v_probe from recovery_cases rc where rc.id=p_case_id;
  if not found then raise exception 'Recovery case was not found'; end if;
  if not can_access_patient(v_probe.patient_id) then
    raise exception 'Patient is outside your permitted caseload';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('RECOVERY_DISRUPTION:'||v_probe.disruption_id::text,0));
  select * into v_case from recovery_cases rc where rc.id=p_case_id for update;

  if v_case.version=p_expected_version+1 and v_case.locked_override_approved
    and v_case.last_changed_by=v_actor and v_case.decision_reason=trim(p_reason) then
    return jsonb_build_object(
      'case_id',v_case.id,'locked_override_approved',true,
      'case_version',v_case.version,'already_applied',true
    );
  end if;
  if v_case.version<>p_expected_version then
    raise exception 'Recovery case changed; refresh before approving it';
  end if;
  if v_case.status not in ('OPEN','OFFERED','DEFERRED') then
    raise exception 'Recovery case is already closed';
  end if;
  if v_case.original_flexibility<>'LOCKED' then
    raise exception 'Only a locked recovery case needs this approval';
  end if;
  update recovery_cases set locked_override_approved=true,requires_clinical_review=true,
    decision_reason=trim(p_reason),last_changed_by=v_actor,version=version+1
  where id=v_case.id;
  insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
  values(v_actor,'LOCKED_RECOVERY_RELEASED',v_case.patient_id,v_case.original_appointment_id,
    jsonb_build_object('case_id',v_case.id,'locked_override_approved',true),trim(p_reason));
  return jsonb_build_object(
    'case_id',v_case.id,'locked_override_approved',true,
    'case_version',p_expected_version+1,'already_applied',false
  );
end
$release_locked$;
revoke all on function release_locked_recovery_case(uuid,int,text) from public;
grant execute on function release_locked_recovery_case(uuid,int,text) to authenticated;

-- PHI- and note-free availability projection for optimizer conflict checks.
create or replace function provider_callout_intervals(
  p_start timestamptz,
  p_end timestamptz
)
returns table(
  id uuid,
  provider_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  status text
)
language plpgsql security definer set search_path=public,extensions as $intervals$
declare v_role app_role:=current_app_role();
begin
  if auth.uid() is null or v_role is null then
    raise exception 'Scheduling availability access is required';
  end if;
  if p_start is null or p_end is null or p_end<=p_start
    or p_end>p_start+interval '370 days' then
    raise exception 'Callout interval range is invalid';
  end if;
  return query
  select sd.id,sd.provider_id,sd.starts_at,sd.ends_at,sd.status
  from schedule_disruptions sd
  where sd.disruption_type='PROVIDER_CALLOUT'
    and sd.status not in ('CANCELLED','WITHDRAWN')
    and sd.starts_at<p_end and sd.ends_at>p_start
    and v_role in ('SCHEDULER','CLINICAL','OPERATIONS','PROVIDER')
    and (v_role<>'PROVIDER' or sd.provider_id=current_provider_id())
  order by sd.starts_at,sd.provider_id,sd.id;
end
$intervals$;
revoke all on function provider_callout_intervals(timestamptz,timestamptz) from public;
grant execute on function provider_callout_intervals(timestamptz,timestamptz) to authenticated;

-- Preserve the established RPC signature while removing cancellation and
-- restoration transitions from the generic editor.
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
language plpgsql security definer set search_path=public,extensions as $update_booking$
declare
  v_target appointments%rowtype;
  v_existing_resources jsonb;
  v_requested_resources jsonb;
begin
  if auth.uid() is null or current_app_role() is null
    or current_app_role() not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to update appointments';
  end if;
  if p_status is null or p_status not in ('SCHEDULED','CONFIRMED','COMPLETED') then
    raise exception 'Cancellation, restoration, and no-show transitions require their dedicated workflow';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'A change reason between 3 and 1000 characters is required';
  end if;
  if jsonb_typeof(coalesce(p_resource_ids,'[]'::jsonb))<>'array'
    or jsonb_array_length(coalesce(p_resource_ids,'[]'::jsonb))>20 then
    raise exception 'Resource assignments are invalid';
  end if;
  select * into v_target from appointments a where a.id=p_appointment_id for update;
  if not found then raise exception 'Appointment no longer exists'; end if;
  if v_target.status not in ('SCHEDULED','CONFIRMED') then
    raise exception 'This appointment lifecycle state requires its dedicated workflow';
  end if;
  if not can_access_patient(v_target.patient_id) then
    raise exception 'Patient is outside your permitted caseload';
  end if;

  select coalesce(jsonb_agg(ar.resource_id::text order by ar.resource_id::text),'[]'::jsonb)
  into v_existing_resources from appointment_resources ar
  where ar.appointment_id=p_appointment_id;
  select coalesce(jsonb_agg(x.resource_id order by x.resource_id),'[]'::jsonb)
  into v_requested_resources
  from (
    select distinct value resource_id
    from jsonb_array_elements_text(coalesce(p_resource_ids,'[]'::jsonb)) values_list(value)
  ) x;

  update appointments set
    provider_id=p_provider_id,location_id=p_location_id,start_time=p_start_time,end_time=p_end_time,
    status=p_status,scheduling_flexibility=p_flexibility,last_change_reason=trim(p_reason)
  where id=p_appointment_id;

  if v_existing_resources is distinct from v_requested_resources then
    delete from appointment_resources where appointment_id=p_appointment_id;
    insert into appointment_resources(appointment_id,resource_id)
    select p_appointment_id,value::uuid
    from jsonb_array_elements_text(v_requested_resources) values_list(value)
    order by value::uuid;
  end if;
  return jsonb_build_object('appointment_id',p_appointment_id,'updated',true);
end
$update_booking$;
revoke all on function update_appointment_booking(uuid,uuid,uuid,timestamptz,timestamptz,appointment_status,scheduling_flexibility,jsonb,text) from public;
grant execute on function update_appointment_booking(uuid,uuid,uuid,timestamptz,timestamptz,appointment_status,scheduling_flexibility,jsonb,text) to authenticated;

create or replace function app_schema_status()
returns jsonb
language sql
stable
security definer
set search_path=public,pg_catalog
as $status$
  select jsonb_build_object(
    'ready',true,
    'version','20261011031000',
    'optimizer_approval',to_regprocedure('public.approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text)') is not null,
    'atomic_booking',to_regprocedure('public.create_appointment_series(jsonb,text)') is not null,
    'opaque_conflicts',to_regprocedure('public.optimization_busy_intervals(timestamp with time zone,timestamp with time zone)') is not null,
    'schedule_recovery',
      to_regclass('public.schedule_disruptions') is not null
      and to_regclass('public.recovery_cases') is not null
      and to_regclass('public.recovery_offers') is not null
      and to_regclass('public.notification_receipts') is not null
      and to_regprocedure('public.report_provider_callout(uuid,timestamp with time zone,timestamp with time zone,text,text,text)') is not null
      and to_regprocedure('public.report_patient_cancellation(uuid,text,boolean,text)') is not null
      and to_regprocedure('public.create_recovery_offer(uuid,integer,text,uuid,uuid,timestamp with time zone,timestamp with time zone,boolean,uuid,jsonb,timestamp with time zone,text)') is not null
      and to_regprocedure('public.expire_recovery_offers(uuid)') is not null
      and to_regprocedure('public.expire_recovery_offer_queue(integer)') is not null
      and to_regprocedure('public.respond_recovery_offer(uuid,integer,text,text,text)') is not null
      and to_regprocedure('public.set_recovery_case_state(uuid,integer,text,text,timestamp with time zone)') is not null
      and to_regprocedure('public.restore_cancelled_appointment(uuid,text,text)') is not null
      and to_regprocedure('public.withdraw_provider_callout(uuid,text,text)') is not null
      and to_regprocedure('public.release_locked_recovery_case(uuid,integer,text)') is not null
      and to_regprocedure('public.provider_callout_intervals(timestamp with time zone,timestamp with time zone)') is not null
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
