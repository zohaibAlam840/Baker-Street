begin;

-- Consent-aware patient communications.  Delivery is deliberately decoupled
-- from appointment writes: schedulers (or a service-role reconciler) enqueue
-- work later, so a provider outage can never make booking fail.

create type communication_channel as enum ('SMS','EMAIL','PUSH');
create type communication_consent_status as enum ('GRANTED','REVOKED');
create type guardian_authority_type as enum ('NONE','CUSTODIAL','MEDICAL','LIMITED','OTHER');
create type communication_message_type as enum (
  'APPOINTMENT_REMINDER','RECOVERY_OFFER','RECOVERY_UPDATE'
);
create type communication_job_status as enum (
  'QUEUED','PROCESSING','SENT','DELIVERED','FAILED','CANCELLED','SUPPRESSED','EXPIRED'
);
create type communication_attempt_outcome as enum (
  'ACCEPTED','DELIVERED','TEMPORARY_FAILURE','PERMANENT_FAILURE','REJECTED'
);
create type communication_receipt_type as enum (
  'ACCEPTED','DELIVERED','BOUNCED','FAILED','COMPLAINT','OPT_OUT'
);
create type communication_response_channel as enum (
  'SMS','EMAIL','PUSH','MANUAL_PHONE','IN_PERSON'
);

-- A private per-project key makes destination fingerprints unsuitable for
-- offline enumeration while still allowing destination-wide opt-out checks.
create table communication_destination_hash_keys (
  singleton boolean primary key default true check (singleton),
  key_material uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);
insert into communication_destination_hash_keys(singleton) values(true);
alter table communication_destination_hash_keys enable row level security;
revoke all on communication_destination_hash_keys from public,anon,authenticated;

create or replace function communication_destination_fingerprint(
  p_channel communication_channel,p_destination text
)
returns text language sql stable strict security definer
set search_path=pg_catalog,public as $fingerprint$
  select encode(sha256(convert_to(
    p_channel::text||':'||k.key_material::text||':'||p_destination,'UTF8'
  )),'hex')
  from public.communication_destination_hash_keys k where k.singleton
$fingerprint$;
revoke all on function communication_destination_fingerprint(communication_channel,text)
  from public,anon,authenticated;

alter table patient_contacts
  add column push_endpoint text,
  add column is_legal_guardian boolean not null default false,
  add column guardian_authority guardian_authority_type not null default 'NONE',
  add column preferred_language text not null default 'en',
  add column timezone text,
  add column quiet_hours_start time,
  add column quiet_hours_end time,
  add column active boolean not null default true,
  add column relationship_effective_start date not null default current_date,
  add column relationship_effective_end date,
  add column relationship_verified_at timestamptz,
  add column relationship_verified_by uuid references auth.users(id) on delete set null,
  add column updated_at timestamptz not null default now(),
  add column updated_by uuid references auth.users(id) on delete set null,
  add column version int not null default 1;

update patient_contacts pc
set timezone=coalesce(p.timezone,'America/New_York')
from patients p
where p.id=pc.patient_id and pc.timezone is null;
alter table patient_contacts alter column timezone set default 'America/New_York';
alter table patient_contacts alter column timezone set not null;

alter table patient_contacts
  add constraint patient_contacts_version_positive check (version>0),
  add constraint patient_contacts_name_length check (length(trim(name)) between 2 and 120) not valid,
  add constraint patient_contacts_relationship_length check (length(trim(relationship)) between 2 and 80) not valid,
  add constraint patient_contacts_phone_length check (phone is null or length(phone) between 7 and 30) not valid,
  add constraint patient_contacts_email_length check (email is null or length(email) between 3 and 254) not valid,
  add constraint patient_contacts_push_length check (push_endpoint is null or length(push_endpoint) between 10 and 2048) not valid,
  add constraint patient_contacts_language_format check (preferred_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  add constraint patient_contacts_quiet_pair check (
    (quiet_hours_start is null and quiet_hours_end is null)
    or (quiet_hours_start is not null and quiet_hours_end is not null and quiet_hours_start<>quiet_hours_end)
  ),
  add constraint patient_contacts_guardian_authority check (
    (is_legal_guardian and guardian_authority<>'NONE')
    or (not is_legal_guardian and guardian_authority='NONE')
  ),
  add constraint patient_contacts_primary_active check (not is_primary or active);
alter table patient_contacts add constraint patient_contacts_relationship_window
  check (relationship_effective_end is null or relationship_effective_end>=relationship_effective_start);
alter table patient_contacts add constraint patient_contacts_phone_e164
  check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$') not valid;
alter table patient_contacts add constraint patient_contacts_email_safe
  check (email is null or (
    email !~ '[\r\n]' and email=lower(email)
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  )) not valid;
alter table patient_contacts add constraint patient_contacts_push_safe
  check (push_endpoint is null or (push_endpoint ~ '^https://' and push_endpoint !~ '[\r\n]')) not valid;

-- Legacy data may contain more than one primary recipient. Keep the oldest as
-- primary before adding the concurrency-safe invariant.
with ranked as (
  select id,row_number() over(partition by patient_id order by created_at,id) as rn
  from patient_contacts where is_primary
)
update patient_contacts pc set is_primary=false
from ranked r where r.id=pc.id and r.rn>1;
create unique index patient_contacts_one_active_primary_idx
  on patient_contacts(patient_id) where is_primary and active;
create index patient_contacts_patient_active_idx
  on patient_contacts(patient_id,active,is_primary,created_at);

create table communication_consents (
  id uuid primary key default gen_random_uuid(),
  patient_contact_id uuid not null references patient_contacts(id) on delete restrict,
  patient_id uuid not null references patients(id) on delete restrict,
  channel communication_channel not null,
  status communication_consent_status not null,
  source text not null,
  granted_at timestamptz,
  revoked_at timestamptz,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique(patient_contact_id,channel),
  check (length(source) between 2 and 120),
  check (version>0),
  check (
    (status='GRANTED' and granted_at is not null and revoked_at is null)
    or (status='REVOKED' and revoked_at is not null)
  )
);
create index communication_consents_patient_idx
  on communication_consents(patient_id,patient_contact_id,channel);

-- Append-only, sanitized history. It intentionally contains neither a raw
-- destination nor a message body.
create table communication_consent_events (
  id bigint generated always as identity primary key,
  consent_id uuid not null references communication_consents(id) on delete restrict,
  patient_id uuid not null references patients(id) on delete restrict,
  patient_contact_id uuid not null references patient_contacts(id) on delete restrict,
  channel communication_channel not null,
  prior_status communication_consent_status,
  new_status communication_consent_status not null,
  source text not null,
  changed_by uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  check (length(source) between 2 and 120)
);
create index communication_consent_events_patient_idx
  on communication_consent_events(patient_id,occurred_at desc);

-- This registry contains only keyed fingerprints, never a phone number,
-- email address, push endpoint, patient ID, or contact ID.
create table communication_destination_suppressions (
  channel communication_channel not null,
  destination_fingerprint text not null,
  source text not null,
  first_suppressed_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_provider_event_id text not null,
  primary key(channel,destination_fingerprint),
  check (destination_fingerprint ~ '^[a-f0-9]{64}$'),
  check (length(source) between 2 and 120),
  check (length(last_provider_event_id) between 3 and 300),
  check (last_seen_at>=first_suppressed_at)
);

create table communication_jobs (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete restrict,
  patient_contact_id uuid not null references patient_contacts(id) on delete restrict,
  appointment_id uuid references appointments(id) on delete restrict,
  recovery_case_id uuid references recovery_cases(id) on delete restrict,
  recovery_offer_id uuid references recovery_offers(id) on delete restrict,
  message_type communication_message_type not null,
  channel communication_channel not null,
  status communication_job_status not null default 'QUEUED',
  template_key text not null,
  subject_snapshot text,
  body_snapshot text not null,
  source_entity_version text not null,
  source_contact_version int not null,
  source_consent_version int not null,
  destination_fingerprint text not null,
  scheduled_for timestamptz not null,
  next_attempt_at timestamptz not null,
  expires_at timestamptz not null,
  max_attempts int not null default 3,
  attempt_count int not null default 0,
  last_error_category text,
  processing_token uuid,
  processing_worker text,
  processing_started_at timestamptz,
  delivered_at timestamptz,
  last_receipt_at timestamptz,
  last_receipt_precedence int not null default 0,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancellation_reason text,
  dedupe_key text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  check (length(template_key) between 3 and 100),
  check (length(body_snapshot) between 1 and 1000),
  check (subject_snapshot is null or length(subject_snapshot)<=200),
  check (length(source_entity_version) between 1 and 200),
  check (source_contact_version>0 and source_consent_version>0),
  check (destination_fingerprint ~ '^[a-f0-9]{64}$'),
  check (expires_at>scheduled_for),
  check (max_attempts between 1 and 10),
  check (attempt_count between 0 and max_attempts),
  check (last_error_category is null or length(last_error_category)<=100),
  check (last_receipt_precedence between 0 and 40),
  check (cancellation_reason is null or length(cancellation_reason) between 3 and 500),
  check (length(dedupe_key) between 8 and 300),
  check (version>0),
  check (
    (message_type='APPOINTMENT_REMINDER' and appointment_id is not null
      and recovery_case_id is null and recovery_offer_id is null)
    or (message_type='RECOVERY_OFFER' and appointment_id is null
      and recovery_case_id is not null and recovery_offer_id is not null)
    or (message_type='RECOVERY_UPDATE' and appointment_id is null
      and recovery_case_id is not null and recovery_offer_id is null)
  ),
  check (
    (message_type='APPOINTMENT_REMINDER' and template_key='appointment-reminder-v1'
      and subject_snapshot='Appointment reminder'
      and body_snapshot=('Reminder: an appointment is coming up. Contact the scheduling team if you need help.'
        ||case when channel='SMS' then ' Reply STOP to opt out.' else '' end))
    or (message_type='RECOVERY_OFFER' and template_key='recovery-offer-v1'
      and subject_snapshot='Scheduling update'
      and body_snapshot=('A scheduling update is available. Contact the scheduling team to review it.'
        ||case when channel='SMS' then ' Reply STOP to opt out.' else '' end))
    or (message_type='RECOVERY_UPDATE' and template_key='recovery-update-v1'
      and subject_snapshot='Scheduling update'
      and body_snapshot=('Your schedule has an update. Contact the scheduling team for details.'
        ||case when channel='SMS' then ' Reply STOP to opt out.' else '' end))
  ),
  check (
    (status='PROCESSING' and processing_token is not null and processing_worker is not null and processing_started_at is not null)
    or (status<>'PROCESSING' and processing_token is null and processing_worker is null and processing_started_at is null)
  )
);
create index communication_jobs_dispatch_idx
  on communication_jobs(status,next_attempt_at,scheduled_for)
  where status in ('QUEUED','FAILED');
create index communication_jobs_patient_idx
  on communication_jobs(patient_id,created_at desc);
create index communication_jobs_appointment_idx
  on communication_jobs(appointment_id,status) where appointment_id is not null;
create index communication_jobs_recovery_idx
  on communication_jobs(recovery_case_id,status) where recovery_case_id is not null;

create table communication_delivery_attempts (
  id bigint generated always as identity primary key,
  communication_job_id uuid not null references communication_jobs(id) on delete restrict,
  attempt_number int not null,
  provider text not null,
  provider_message_id text,
  outcome communication_attempt_outcome not null,
  error_category text,
  http_status int,
  destination_hash text not null,
  processing_token_hash text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  unique(communication_job_id,attempt_number),
  unique(communication_job_id,processing_token_hash),
  check (attempt_number>0),
  check (length(provider) between 2 and 80),
  check (provider_message_id is null or length(provider_message_id)<=200),
  check (error_category is null or length(error_category)<=100),
  check (http_status is null or http_status between 100 and 599),
  check (destination_hash ~ '^[A-Fa-f0-9]{32,128}$'),
  check (processing_token_hash ~ '^[a-f0-9]{64}$'),
  check (completed_at>=started_at),
  check (jsonb_typeof(metadata)='object')
);
create index communication_delivery_attempts_job_idx
  on communication_delivery_attempts(communication_job_id,attempt_number desc);

create table communication_delivery_receipts (
  id bigint generated always as identity primary key,
  communication_job_id uuid not null references communication_jobs(id) on delete restrict,
  communication_attempt_id bigint references communication_delivery_attempts(id) on delete restrict,
  provider_event_id text not null unique,
  receipt_type communication_receipt_type not null,
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  check (length(provider_event_id) between 3 and 300),
  check (jsonb_typeof(metadata)='object')
);
create index communication_delivery_receipts_job_idx
  on communication_delivery_receipts(communication_job_id,occurred_at desc);

create table communication_idempotency (
  actor_key text not null,
  operation text not null,
  idempotency_key text not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_key,operation,idempotency_key),
  check (length(actor_key) between 3 and 100),
  check (length(operation) between 3 and 100),
  check (length(idempotency_key) between 8 and 200),
  check (request_hash ~ '^[a-f0-9]{32}$')
);

-- Fail closed until a deployment operator has configured compliant providers,
-- webhook verification, and destination controls outside this migration.
create table communication_delivery_config (
  singleton boolean primary key default true check (singleton),
  delivery_mode text not null default 'RECORD_ONLY' check (delivery_mode in ('RECORD_ONLY','LIVE')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
insert into communication_delivery_config(singleton,delivery_mode) values(true,'RECORD_ONLY');

alter table recovery_offers
  add column response_contact_id uuid references patient_contacts(id) on delete restrict,
  add column response_channel communication_response_channel,
  add column communication_job_id uuid references communication_jobs(id) on delete restrict;
alter table recovery_offers add constraint recovery_offer_response_provenance check (
  (response_contact_id is null and response_channel is null and communication_job_id is null)
  or (response_contact_id is not null and response_channel is not null and (
    (response_channel in ('SMS','EMAIL','PUSH') and communication_job_id is not null)
    or (response_channel in ('MANUAL_PHONE','IN_PERSON') and communication_job_id is null)
  ))
);

create trigger patient_contacts_set_updated_at before update on patient_contacts
for each row execute function set_updated_at();
create trigger communication_consents_set_updated_at before update on communication_consents
for each row execute function set_updated_at();
create trigger communication_jobs_set_updated_at before update on communication_jobs
for each row execute function set_updated_at();

alter table communication_consents enable row level security;
alter table communication_consent_events enable row level security;
alter table communication_destination_suppressions enable row level security;
alter table communication_jobs enable row level security;
alter table communication_delivery_attempts enable row level security;
alter table communication_delivery_receipts enable row level security;
alter table communication_idempotency enable row level security;
alter table communication_delivery_config enable row level security;

-- Do not reuse can_access_patient here: it intentionally grants Authorization
-- and Operations access to patient workflow records. Raw communication
-- destinations need a narrower minimum-necessary boundary.
create or replace function can_read_patient_communication(target_patient uuid)
returns boolean language sql stable security definer set search_path=public as $access$
  select current_app_role()='SCHEDULER'
    or (current_app_role()='CLINICAL' and is_on_patient_team(target_patient))
$access$;
revoke all on function can_read_patient_communication(uuid) from public;
grant execute on function can_read_patient_communication(uuid) to authenticated;

drop policy if exists "scoped contacts read" on patient_contacts;
drop policy if exists "scheduler contacts manage" on patient_contacts;
create policy "minimum necessary contact read" on patient_contacts for select to authenticated
using (can_read_patient_communication(patient_id));
create policy "minimum necessary consent read" on communication_consents for select to authenticated
using (can_read_patient_communication(patient_id));
create policy "scoped sanitized consent history" on communication_consent_events for select to authenticated
using (can_read_patient_communication(patient_id) or current_app_role()='COMPLIANCE');
create policy "minimum necessary communication job read" on communication_jobs for select to authenticated
using (can_read_patient_communication(patient_id));
create policy "scoped sanitized attempt read" on communication_delivery_attempts for select to authenticated
using (current_app_role()='COMPLIANCE' or exists(
  select 1 from communication_jobs j
  where j.id=communication_job_id and can_read_patient_communication(j.patient_id)
));
create policy "scoped sanitized receipt read" on communication_delivery_receipts for select to authenticated
using (current_app_role()='COMPLIANCE' or exists(
  select 1 from communication_jobs j
  where j.id=communication_job_id and can_read_patient_communication(j.patient_id)
));
create policy "communication mode read" on communication_delivery_config for select to authenticated
using (current_app_role() in ('SCHEDULER','OPERATIONS','ADMIN','COMPLIANCE'));

revoke all on patient_contacts,communication_consents,communication_consent_events,
  communication_destination_suppressions,
  communication_jobs,communication_delivery_attempts,communication_delivery_receipts,
  communication_idempotency,communication_delivery_config from anon,authenticated;
grant select on patient_contacts,communication_consents,communication_consent_events,
  communication_jobs,communication_delivery_attempts,communication_delivery_receipts to authenticated;
grant select on communication_delivery_config to authenticated;

-- The former generic trigger copied raw phone/email values to audit_log. Replace
-- it with an intentionally narrow metadata snapshot before any contact changes.
drop trigger if exists patient_contacts_audit_trigger on patient_contacts;
create or replace function audit_patient_contact_change()
returns trigger language plpgsql security definer set search_path=public as $audit$
declare
  v_old jsonb;
  v_new jsonb;
  v_patient uuid;
begin
  if tg_op='DELETE' then v_patient:=old.patient_id; else v_patient:=new.patient_id; end if;
  if tg_op<>'INSERT' then
    v_old:=jsonb_build_object(
      'contact_id',old.id,'relationship',old.relationship,'is_primary',old.is_primary,
      'authorized',old.authorized_to_receive_information,'is_legal_guardian',old.is_legal_guardian,
      'guardian_authority',old.guardian_authority,'preferred_language',old.preferred_language,
      'timezone',old.timezone,'quiet_hours_configured',old.quiet_hours_start is not null,
      'phone_present',old.phone is not null,'email_present',old.email is not null,
      'push_present',old.push_endpoint is not null,'active',old.active,'version',old.version
    );
  end if;
  if tg_op<>'DELETE' then
    v_new:=jsonb_build_object(
      'contact_id',new.id,'relationship',new.relationship,'is_primary',new.is_primary,
      'authorized',new.authorized_to_receive_information,'is_legal_guardian',new.is_legal_guardian,
      'guardian_authority',new.guardian_authority,'preferred_language',new.preferred_language,
      'timezone',new.timezone,'quiet_hours_configured',new.quiet_hours_start is not null,
      'phone_present',new.phone is not null,'email_present',new.email is not null,
      'push_present',new.push_endpoint is not null,'active',new.active,'version',new.version
    );
  end if;
  insert into audit_log(user_id,action,patient_id,old_values,new_values)
  values(auth.uid(),'PATIENT_CONTACT_'||tg_op,v_patient,v_old,v_new);
  if tg_op='DELETE' then return old; end if;
  return new;
end
$audit$;
create trigger patient_contacts_audit_trigger after insert or update or delete on patient_contacts
for each row execute function audit_patient_contact_change();
revoke all on function audit_patient_contact_change() from public,anon,authenticated;

-- The previous trigger stored entire contact rows. Remove all direct identifiers
-- from historical contact audit payloads before oversight users can read them.
update audit_log set
  old_values=case when old_values is null then null else old_values-array['name','phone','email','push_endpoint']::text[] end,
  new_values=case when new_values is null then null else new_values-array['name','phone','email','push_endpoint']::text[] end
where action in ('PATIENT_CONTACTS_INSERT','PATIENT_CONTACTS_UPDATE','PATIENT_CONTACTS_DELETE');

create or replace function communication_allowed_time(
  p_requested timestamptz,p_timezone text,p_quiet_start time,p_quiet_end time
)
returns timestamptz language plpgsql stable security definer
set search_path=public,pg_catalog as $allowed$
declare
  v_local timestamp;
  v_date date;
  v_time time;
  v_allowed_local timestamp;
begin
  if p_requested is null then return null; end if;
  if not exists(select 1 from pg_timezone_names where name=p_timezone) then
    raise exception 'Contact timezone is invalid';
  end if;
  if p_quiet_start is null or p_quiet_end is null then return p_requested; end if;
  v_local:=p_requested at time zone p_timezone;
  v_date:=v_local::date;
  v_time:=v_local::time;
  if p_quiet_start<p_quiet_end and v_time>=p_quiet_start and v_time<p_quiet_end then
    v_allowed_local:=v_date+p_quiet_end;
  elsif p_quiet_start>p_quiet_end and v_time>=p_quiet_start then
    v_allowed_local:=(v_date+1)+p_quiet_end;
  elsif p_quiet_start>p_quiet_end and v_time<p_quiet_end then
    v_allowed_local:=v_date+p_quiet_end;
  else
    return p_requested;
  end if;
  return v_allowed_local at time zone p_timezone;
end
$allowed$;
revoke all on function communication_allowed_time(timestamptz,text,time,time) from public;

create or replace function communication_destination(
  p_contact patient_contacts,p_channel communication_channel
)
returns text language sql immutable set search_path=public as $destination$
  select case p_channel
    when 'SMS' then p_contact.phone
    when 'EMAIL' then p_contact.email
    when 'PUSH' then p_contact.push_endpoint
  end
$destination$;
revoke all on function communication_destination(patient_contacts,communication_channel) from public;

create or replace function save_patient_contact(
  p_patient_id uuid,
  p_contact_id uuid,
  p_name text,
  p_relationship text,
  p_phone text,
  p_email text,
  p_push_endpoint text,
  p_is_primary boolean,
  p_authorized_to_receive_information boolean,
  p_is_legal_guardian boolean,
  p_guardian_authority text,
  p_preferred_language text,
  p_timezone text,
  p_quiet_hours_start time,
  p_quiet_hours_end time,
  p_active boolean,
  p_expected_version int,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $save_contact$
declare
  v_actor uuid:=auth.uid();
  v_name text:=trim(coalesce(p_name,''));
  v_relationship text:=trim(coalesce(p_relationship,''));
  v_phone_input text:=nullif(trim(coalesce(p_phone,'')),'');
  v_phone text;
  v_email text:=nullif(lower(trim(coalesce(p_email,''))),'');
  v_push text:=nullif(trim(coalesce(p_push_endpoint,'')),'');
  v_language text:=trim(coalesce(p_preferred_language,''));
  v_timezone text:=trim(coalesce(p_timezone,''));
  v_authority guardian_authority_type;
  v_contact patient_contacts%rowtype;
  v_prior patient_contacts%rowtype;
  v_consent communication_consents%rowtype;
  v_channel communication_channel;
  v_destination_changed boolean;
  v_created boolean:=false;
  v_payload jsonb;
  v_hash text;
  v_existing communication_idempotency%rowtype;
  v_result jsonb;
begin
  if v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER' then
    raise exception 'Only schedulers may manage patient contacts';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;
  if length(v_name) not between 2 and 120 or length(v_relationship) not between 2 and 80 then
    raise exception 'Contact name and relationship are required';
  end if;
  if v_phone_input is not null then
    if left(v_phone_input,1)<>'+' then raise exception 'Phone number must include its country code'; end if;
    v_phone:='+'||regexp_replace(v_phone_input,'[^0-9]','','g');
  end if;
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Phone number must be a valid E.164 number';
  end if;
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Email address format is invalid';
  end if;
  if v_push is not null and (length(v_push)>2048 or v_push !~ '^https://') then
    raise exception 'Push endpoint must be a secure URL';
  end if;
  if coalesce(v_phone,v_email,v_push) is null and coalesce(p_authorized_to_receive_information,false) then
    raise exception 'An authorized recipient needs at least one destination';
  end if;
  if v_language !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$' then
    raise exception 'Preferred language format is invalid';
  end if;
  if not exists(select 1 from pg_timezone_names where name=v_timezone) then
    raise exception 'Contact timezone is invalid';
  end if;
  if (p_quiet_hours_start is null)<>(p_quiet_hours_end is null)
    or (p_quiet_hours_start is not null and p_quiet_hours_start=p_quiet_hours_end) then
    raise exception 'Quiet hours require different start and end times';
  end if;
  begin
    v_authority:=upper(trim(coalesce(p_guardian_authority,'')))::guardian_authority_type;
  exception when invalid_text_representation then
    raise exception 'Guardian authority is invalid';
  end;
  if coalesce(p_is_legal_guardian,false)<>(v_authority<>'NONE') then
    raise exception 'Guardian authority must match legal guardian status';
  end if;
  if not exists(select 1 from patients p where p.id=p_patient_id) then
    raise exception 'Patient was not found';
  end if;

  v_payload:=jsonb_build_object(
    'patient_id',p_patient_id,'contact_id',p_contact_id,'name',v_name,
    'relationship',v_relationship,'phone',v_phone,'email',v_email,'push',v_push,
    'is_primary',coalesce(p_is_primary,false),
    'authorized',coalesce(p_authorized_to_receive_information,false),
    'is_legal_guardian',coalesce(p_is_legal_guardian,false),
    'guardian_authority',v_authority,'language',v_language,'timezone',v_timezone,
    'quiet_start',p_quiet_hours_start,'quiet_end',p_quiet_hours_end,
    'active',coalesce(p_active,true),
    'expected_version',p_expected_version
  );
  v_hash:=md5(v_payload::text);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':SAVE_CONTACT:'||trim(p_idempotency_key),0));
  select * into v_existing from communication_idempotency i
  where i.actor_key=v_actor::text and i.operation='SAVE_CONTACT'
    and i.idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.request_hash<>v_hash then
      raise exception 'Idempotency key was already used for a different contact request';
    end if;
    return v_existing.result||jsonb_build_object('already_applied',true);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('PATIENT_CONTACTS:'||p_patient_id::text,0));
  if coalesce(p_is_primary,false) and not coalesce(p_active,true) then
    raise exception 'An inactive contact cannot be primary';
  end if;
  if not coalesce(p_active,true) and coalesce(p_authorized_to_receive_information,false) then
    raise exception 'An inactive contact cannot remain authorized';
  end if;
  if p_contact_id is null then
    if coalesce(p_expected_version,0)<>0 then
      raise exception 'New contacts must not include an existing version';
    end if;
    if coalesce(p_is_primary,false) then
      update patient_contacts set is_primary=false,updated_by=v_actor,version=version+1
      where patient_id=p_patient_id and active and is_primary;
    end if;
    insert into patient_contacts(
      patient_id,name,relationship,phone,email,push_endpoint,is_primary,
      authorized_to_receive_information,is_legal_guardian,guardian_authority,
      preferred_language,timezone,quiet_hours_start,quiet_hours_end,active,
      relationship_verified_at,relationship_verified_by,updated_by
    ) values(
      p_patient_id,v_name,v_relationship,v_phone,v_email,v_push,coalesce(p_is_primary,false),
      coalesce(p_authorized_to_receive_information,false),coalesce(p_is_legal_guardian,false),
      v_authority,v_language,v_timezone,p_quiet_hours_start,p_quiet_hours_end,coalesce(p_active,true),
      case when coalesce(p_authorized_to_receive_information,false) then now() else null end,
      case when coalesce(p_authorized_to_receive_information,false) then v_actor else null end,v_actor
    ) returning * into v_contact;
    v_created:=true;
  else
    perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_CONTACT:'||p_contact_id::text,0));
    select * into v_prior from patient_contacts pc where pc.id=p_contact_id for update;
    if not found or v_prior.patient_id<>p_patient_id then raise exception 'Contact was not found'; end if;
    if p_expected_version is null or p_expected_version<>v_prior.version then
      raise exception 'Contact changed; refresh before saving';
    end if;
    if coalesce(p_is_primary,false) then
      update patient_contacts set is_primary=false,updated_by=v_actor,version=version+1
      where patient_id=p_patient_id and active and is_primary and id<>p_contact_id;
    end if;
    update patient_contacts set
      name=v_name,relationship=v_relationship,phone=v_phone,email=v_email,push_endpoint=v_push,
      is_primary=coalesce(p_is_primary,false),
      authorized_to_receive_information=coalesce(p_authorized_to_receive_information,false),
      is_legal_guardian=coalesce(p_is_legal_guardian,false),guardian_authority=v_authority,
      preferred_language=v_language,timezone=v_timezone,
      quiet_hours_start=p_quiet_hours_start,quiet_hours_end=p_quiet_hours_end,
      active=coalesce(p_active,true),
      relationship_effective_end=case when coalesce(p_active,true) then null else current_date end,
      relationship_verified_at=case
        when coalesce(p_authorized_to_receive_information,false) then now() else relationship_verified_at end,
      relationship_verified_by=case
        when coalesce(p_authorized_to_receive_information,false) then v_actor else relationship_verified_by end,
      updated_by=v_actor,version=version+1
    where id=p_contact_id returning * into v_contact;

    -- Consent belongs to a destination, not merely to a contact row. Revoke the
    -- affected channel whenever that destination changes. Withdrawing the
    -- recipient's authorization revokes every channel.
    foreach v_channel in array array['SMS','EMAIL','PUSH']::communication_channel[] loop
      v_destination_changed:=case v_channel
        when 'SMS' then v_prior.phone is distinct from v_contact.phone
        when 'EMAIL' then v_prior.email is distinct from v_contact.email
        when 'PUSH' then v_prior.push_endpoint is distinct from v_contact.push_endpoint
      end;
      if v_destination_changed or not v_contact.authorized_to_receive_information or not v_contact.active then
        select * into v_consent from communication_consents c
        where c.patient_contact_id=v_contact.id and c.channel=v_channel for update;
        if found and v_consent.status='GRANTED' then
          update communication_consents set status='REVOKED',revoked_at=now(),
            source=case when v_destination_changed then 'DESTINATION_CHANGED' else 'CONTACT_ACCESS_REVOKED' end,
            changed_by=v_actor,version=version+1
          where id=v_consent.id returning * into v_consent;
          insert into communication_consent_events(
            consent_id,patient_id,patient_contact_id,channel,prior_status,new_status,source,changed_by
          ) values(
            v_consent.id,v_contact.patient_id,v_contact.id,v_channel,'GRANTED','REVOKED',
            v_consent.source,v_actor
          );
        end if;
        update communication_jobs set cancelled_at=now(),cancelled_by=v_actor,
          cancellation_reason=case when v_destination_changed then 'Recipient destination changed' else 'Recipient authorization withdrawn' end,
          status=case when status='PROCESSING' then status else 'CANCELLED' end,
          processing_token=case when status='PROCESSING' then processing_token else null end,
          processing_worker=case when status='PROCESSING' then processing_worker else null end,
          processing_started_at=case when status='PROCESSING' then processing_started_at else null end,
          version=version+1
        where patient_contact_id=v_contact.id and channel=v_channel
          and status in ('QUEUED','PROCESSING','FAILED');
      end if;
    end loop;
  end if;

  v_result:=jsonb_build_object(
    'contact_id',v_contact.id,'contact_version',v_contact.version,
    'created',v_created,'already_applied',false
  );
  insert into communication_idempotency(actor_key,operation,idempotency_key,request_hash,result)
  values(v_actor::text,'SAVE_CONTACT',trim(p_idempotency_key),v_hash,v_result);
  return v_result;
end
$save_contact$;
revoke all on function save_patient_contact(uuid,uuid,text,text,text,text,text,boolean,boolean,boolean,text,text,text,time,time,boolean,int,text) from public;
grant execute on function save_patient_contact(uuid,uuid,text,text,text,text,text,boolean,boolean,boolean,text,text,text,time,time,boolean,int,text) to authenticated;

create or replace function set_contact_channel_consent(
  p_contact_id uuid,
  p_channel communication_channel,
  p_granted boolean,
  p_source text,
  p_expected_version int,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $set_consent$
declare
  v_actor uuid:=auth.uid();
  v_contact patient_contacts%rowtype;
  v_consent communication_consents%rowtype;
  v_prior_status communication_consent_status;
  v_source text:=trim(coalesce(p_source,''));
  v_payload jsonb;
  v_hash text;
  v_existing communication_idempotency%rowtype;
  v_result jsonb;
  v_destination text;
  v_fingerprint text;
begin
  if v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER' then
    raise exception 'Only schedulers may change communication consent';
  end if;
  if length(v_source) not between 2 and 120 then raise exception 'Consent source is required'; end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;
  v_payload:=jsonb_build_object('contact_id',p_contact_id,'channel',p_channel,
    'granted',p_granted,'source',v_source,'expected_version',p_expected_version);
  v_hash:=md5(v_payload::text);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':SET_CONSENT:'||trim(p_idempotency_key),0));
  select * into v_existing from communication_idempotency i
  where i.actor_key=v_actor::text and i.operation='SET_CONSENT'
    and i.idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.request_hash<>v_hash then
      raise exception 'Idempotency key was already used for a different consent request';
    end if;
    return v_existing.result||jsonb_build_object('already_applied',true);
  end if;

  select * into v_contact from patient_contacts pc where pc.id=p_contact_id;
  if not found then raise exception 'Contact was not found'; end if;
  v_destination:=communication_destination(v_contact,p_channel);
  if p_granted and v_destination is null then
    raise exception 'Contact has no destination for this channel';
  end if;
  if v_destination is not null then
    v_fingerprint:=communication_destination_fingerprint(p_channel,v_destination);
    perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_DESTINATION:'||v_fingerprint,0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_CONTACT:'||p_contact_id::text,0));
  select * into v_contact from patient_contacts pc where pc.id=p_contact_id for update;
  if p_granted and communication_destination_fingerprint(
      p_channel,communication_destination(v_contact,p_channel)
    ) is distinct from v_fingerprint then
    raise exception 'Contact destination changed; retry consent update';
  end if;
  if p_granted and (not v_contact.active or not v_contact.authorized_to_receive_information) then
    raise exception 'Contact is not authorized to receive information';
  end if;
  if p_granted and v_contact.relationship_verified_at is null then
    raise exception 'Contact relationship must be verified before consent is granted';
  end if;
  if p_granted and exists(
    select 1 from communication_destination_suppressions s
    where s.channel=p_channel and s.destination_fingerprint=v_fingerprint
  ) then
    if upper(v_source) not in ('VERIFIED_RECONSENT','SIGNED_RECONSENT') then
      raise exception 'Verified re-consent is required for this suppressed destination';
    end if;
    delete from communication_destination_suppressions
    where channel=p_channel and destination_fingerprint=v_fingerprint;
  end if;
  select * into v_consent from communication_consents c
  where c.patient_contact_id=p_contact_id and c.channel=p_channel for update;
  if found then
    if p_expected_version is null or p_expected_version<>v_consent.version then
      raise exception 'Consent changed; refresh before saving';
    end if;
    if p_granted and v_consent.status='REVOKED'
      and upper(v_consent.source) in ('STOP','UNSUBSCRIBE','PROVIDER_OPT_OUT','PROVIDER_COMPLAINT','HARD_BOUNCE')
      and upper(v_source) not in ('VERIFIED_RECONSENT','SIGNED_RECONSENT') then
      raise exception 'Verified re-consent is required after an opt-out, complaint, or hard bounce';
    end if;
    v_prior_status:=v_consent.status;
    update communication_consents set
      status=case when p_granted then 'GRANTED' else 'REVOKED' end,
      source=v_source,
      granted_at=case when p_granted then now() else granted_at end,
      revoked_at=case when p_granted then null else now() end,
      changed_by=v_actor,version=version+1
    where id=v_consent.id returning * into v_consent;
  else
    if coalesce(p_expected_version,0)<>0 then
      raise exception 'New consent must not include an existing version';
    end if;
    insert into communication_consents(
      patient_contact_id,patient_id,channel,status,source,granted_at,revoked_at,changed_by
    ) values(
      v_contact.id,v_contact.patient_id,p_channel,
      case when p_granted then 'GRANTED' else 'REVOKED' end,v_source,
      case when p_granted then now() else null end,
      case when p_granted then null else now() end,v_actor
    ) returning * into v_consent;
    v_prior_status:=null;
  end if;
  insert into communication_consent_events(
    consent_id,patient_id,patient_contact_id,channel,prior_status,new_status,source,changed_by
  ) values(
    v_consent.id,v_contact.patient_id,v_contact.id,p_channel,v_prior_status,v_consent.status,v_source,v_actor
  );
  if not p_granted then
    update communication_jobs set cancelled_at=now(),cancelled_by=v_actor,
      cancellation_reason='Recipient consent revoked',
      status=case when status='PROCESSING' then status else 'CANCELLED' end,
      processing_token=case when status='PROCESSING' then processing_token else null end,
      processing_worker=case when status='PROCESSING' then processing_worker else null end,
      processing_started_at=case when status='PROCESSING' then processing_started_at else null end,
      version=version+1
    where patient_contact_id=v_contact.id and channel=p_channel
      and status in ('QUEUED','PROCESSING','FAILED');
  end if;
  insert into audit_log(user_id,action,patient_id,new_values)
  values(v_actor,'COMMUNICATION_CONSENT_CHANGED',v_contact.patient_id,jsonb_build_object(
    'contact_id',v_contact.id,'channel',p_channel,'status',v_consent.status,
    'consent_version',v_consent.version,'source',v_source
  ));
  v_result:=jsonb_build_object(
    'consent_id',v_consent.id,'consent_version',v_consent.version,
    'contact_id',v_contact.id,'channel',p_channel,'status',v_consent.status,
    'already_applied',false
  );
  insert into communication_idempotency(actor_key,operation,idempotency_key,request_hash,result)
  values(v_actor::text,'SET_CONSENT',trim(p_idempotency_key),v_hash,v_result);
  return v_result;
end
$set_consent$;
revoke all on function set_contact_channel_consent(uuid,communication_channel,boolean,text,int,text) from public;
grant execute on function set_contact_channel_consent(uuid,communication_channel,boolean,text,int,text) to authenticated;

create or replace function verify_patient_contact_relationship(
  p_contact_id uuid,p_expected_version int,p_verified boolean,p_reason text,p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $verify_contact$
declare
  v_actor uuid:=auth.uid();
  v_contact patient_contacts%rowtype;
  v_consent communication_consents%rowtype;
  v_hash text:=md5(jsonb_build_object('contact_id',p_contact_id,'expected_version',p_expected_version,
    'verified',p_verified,'reason',trim(coalesce(p_reason,'')))::text);
  v_existing communication_idempotency%rowtype;
  v_result jsonb;
begin
  if v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER' then
    raise exception 'Only schedulers may verify contact relationships';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 500 then
    raise exception 'A verification reason is required';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':VERIFY_CONTACT:'||trim(p_idempotency_key),0));
  select * into v_existing from communication_idempotency i
  where actor_key=v_actor::text and operation='VERIFY_CONTACT' and idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'Idempotency key payload does not match'; end if;
    return v_existing.result||jsonb_build_object('already_applied',true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_CONTACT:'||p_contact_id::text,0));
  select * into v_contact from patient_contacts where id=p_contact_id for update;
  if not found then raise exception 'Contact was not found'; end if;
  if v_contact.version<>p_expected_version then raise exception 'Contact changed; refresh before verifying'; end if;
  update patient_contacts set
      relationship_verified_at=case when p_verified then now() else null end,
    relationship_verified_by=case when p_verified then v_actor else null end,
    updated_by=v_actor,version=version+1
  where id=v_contact.id returning * into v_contact;
  if not p_verified then
    for v_consent in
      select * from communication_consents
      where patient_contact_id=v_contact.id and status='GRANTED'
      for update
    loop
      update communication_consents set status='REVOKED',revoked_at=now(),
        source='RELATIONSHIP_UNVERIFIED',changed_by=v_actor,version=version+1
      where id=v_consent.id returning * into v_consent;
      insert into communication_consent_events(
        consent_id,patient_id,patient_contact_id,channel,prior_status,new_status,source,changed_by
      ) values(
        v_consent.id,v_consent.patient_id,v_consent.patient_contact_id,v_consent.channel,
        'GRANTED','REVOKED','RELATIONSHIP_UNVERIFIED',v_actor
      );
    end loop;
    update communication_jobs set
      status=case when status='PROCESSING' then status else 'CANCELLED' end,
      cancelled_at=now(),cancelled_by=v_actor,
      cancellation_reason='Contact relationship verification withdrawn',
      processing_token=case when status='PROCESSING' then processing_token else null end,
      processing_worker=case when status='PROCESSING' then processing_worker else null end,
      processing_started_at=case when status='PROCESSING' then processing_started_at else null end,
      version=version+1
    where patient_contact_id=v_contact.id and status in ('QUEUED','PROCESSING','FAILED');
  end if;
  insert into audit_log(user_id,action,patient_id,new_values,override_reason)
  values(v_actor,'PATIENT_CONTACT_RELATIONSHIP_VERIFIED',v_contact.patient_id,
    jsonb_build_object('contact_id',v_contact.id,'verified',p_verified,'version',v_contact.version),trim(p_reason));
  v_result:=jsonb_build_object('contact_id',v_contact.id,'contact_version',v_contact.version,
    'verified',p_verified,'already_applied',false);
  insert into communication_idempotency(actor_key,operation,idempotency_key,request_hash,result)
  values(v_actor::text,'VERIFY_CONTACT',trim(p_idempotency_key),v_hash,v_result);
  return v_result;
end
$verify_contact$;
revoke all on function verify_patient_contact_relationship(uuid,int,boolean,text,text) from public;
grant execute on function verify_patient_contact_relationship(uuid,int,boolean,text,text) to authenticated;

create or replace function enqueue_communication_job_internal(
  p_patient_id uuid,
  p_contact_id uuid,
  p_appointment_id uuid,
  p_recovery_case_id uuid,
  p_recovery_offer_id uuid,
  p_message_type communication_message_type,
  p_channel communication_channel,
  p_requested_for timestamptz,
  p_source_entity_version text,
  p_expires_at timestamptz,
  p_dedupe_key text,
  p_created_by uuid
)
returns communication_jobs language plpgsql security definer set search_path=public,pg_catalog as $enqueue$
declare
  v_contact patient_contacts%rowtype;
  v_consent communication_consents%rowtype;
  v_scheduled timestamptz;
  v_job communication_jobs%rowtype;
  v_template text;
  v_subject text;
  v_body text;
  v_destination text;
  v_fingerprint text;
begin
  select * into v_contact from patient_contacts pc where pc.id=p_contact_id;
  if not found or v_contact.patient_id<>p_patient_id then
    raise exception 'Communication contact does not belong to the patient';
  end if;
  v_destination:=communication_destination(v_contact,p_channel);
  if v_destination is null then
    raise exception 'Contact has no destination for this channel';
  end if;
  v_fingerprint:=communication_destination_fingerprint(p_channel,v_destination);
  perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_DESTINATION:'||v_fingerprint,0));
  perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_CONTACT:'||p_contact_id::text,0));
  select * into v_contact from patient_contacts pc where pc.id=p_contact_id for update;
  if communication_destination_fingerprint(
      p_channel,communication_destination(v_contact,p_channel)
    ) is distinct from v_fingerprint then
    raise exception 'Contact destination changed; retry queueing';
  end if;
  if not v_contact.active or v_contact.relationship_verified_at is null
    or v_contact.relationship_effective_start>current_date
    or (v_contact.relationship_effective_end is not null and v_contact.relationship_effective_end<current_date)
    or not v_contact.authorized_to_receive_information then
    raise exception 'Contact is not authorized to receive information';
  end if;
  if exists(select 1 from communication_destination_suppressions s
    where s.channel=p_channel and s.destination_fingerprint=v_fingerprint) then
    raise exception 'Destination has withdrawn communication permission';
  end if;
  select * into v_consent from communication_consents c
  where c.patient_contact_id=v_contact.id and c.channel=p_channel for update;
  if not found or v_consent.patient_id<>p_patient_id or v_consent.status<>'GRANTED' then
    raise exception 'Current channel consent is required';
  end if;
  v_scheduled:=communication_allowed_time(
    greatest(coalesce(p_requested_for,now()),now()),v_contact.timezone,
    v_contact.quiet_hours_start,v_contact.quiet_hours_end
  );
  if p_expires_at is null or v_scheduled>=p_expires_at then
    raise exception 'Communication cannot be delivered before it expires';
  end if;
  case p_message_type
    when 'APPOINTMENT_REMINDER' then
      v_template:='appointment-reminder-v1';
      v_subject:='Appointment reminder';
      v_body:='Reminder: an appointment is coming up. Contact the scheduling team if you need help.';
    when 'RECOVERY_OFFER' then
      v_template:='recovery-offer-v1';
      v_subject:='Scheduling update';
      v_body:='A scheduling update is available. Contact the scheduling team to review it.';
    when 'RECOVERY_UPDATE' then
      v_template:='recovery-update-v1';
      v_subject:='Scheduling update';
      v_body:='Your schedule has an update. Contact the scheduling team for details.';
  end case;
  if p_channel='SMS' then v_body:=v_body||' Reply STOP to opt out.'; end if;
  insert into communication_jobs(
    patient_id,patient_contact_id,appointment_id,recovery_case_id,recovery_offer_id,
    message_type,channel,status,template_key,subject_snapshot,body_snapshot,
    source_entity_version,source_contact_version,source_consent_version,destination_fingerprint,
    scheduled_for,next_attempt_at,expires_at,dedupe_key,created_by
  ) values(
    p_patient_id,p_contact_id,p_appointment_id,p_recovery_case_id,p_recovery_offer_id,
    p_message_type,p_channel,'QUEUED',v_template,v_subject,v_body,
    p_source_entity_version,v_contact.version,v_consent.version,v_fingerprint,
    v_scheduled,v_scheduled,p_expires_at,p_dedupe_key,p_created_by
  ) on conflict(dedupe_key) do nothing returning * into v_job;
  if not found then
    select * into v_job from communication_jobs where dedupe_key=p_dedupe_key;
    if v_job.patient_id<>p_patient_id or v_job.patient_contact_id<>p_contact_id
      or v_job.channel<>p_channel or v_job.message_type<>p_message_type
      or v_job.source_entity_version<>p_source_entity_version then
      raise exception 'Communication dedupe key belongs to a different request';
    end if;
  end if;
  return v_job;
end
$enqueue$;
revoke all on function enqueue_communication_job_internal(uuid,uuid,uuid,uuid,uuid,communication_message_type,communication_channel,timestamptz,text,timestamptz,text,uuid) from public,anon,authenticated;

create or replace function queue_appointment_reminder(
  p_appointment_id uuid,
  p_contact_id uuid,
  p_channel communication_channel,
  p_scheduled_for timestamptz,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $queue_reminder$
declare
  v_actor uuid:=auth.uid();
  v_appointment appointments%rowtype;
  v_job communication_jobs%rowtype;
  v_payload jsonb;
  v_hash text;
  v_existing communication_idempotency%rowtype;
  v_dedupe text;
  v_result jsonb;
begin
  if v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER' then
    raise exception 'Only schedulers may queue appointment reminders';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;
  v_payload:=jsonb_build_object('appointment_id',p_appointment_id,'contact_id',p_contact_id,
    'channel',p_channel,'scheduled_for',p_scheduled_for);
  v_hash:=md5(v_payload::text);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':QUEUE_APPOINTMENT_REMINDER:'||trim(p_idempotency_key),0));
  select * into v_existing from communication_idempotency i
  where actor_key=v_actor::text and operation='QUEUE_APPOINTMENT_REMINDER'
    and idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'Idempotency key payload does not match'; end if;
    return v_existing.result||jsonb_build_object('already_applied',true);
  end if;
  select * into v_appointment from appointments a where a.id=p_appointment_id for update;
  if not found then raise exception 'Appointment was not found'; end if;
  if v_appointment.status not in ('SCHEDULED','CONFIRMED') or v_appointment.start_time<=now() then
    raise exception 'Only upcoming active appointments can receive reminders';
  end if;
  v_dedupe:='appt-manual:'||v_appointment.id||':'||md5(v_appointment.updated_at::text)||':'||
    p_contact_id||':'||p_channel||':'||md5(coalesce(p_scheduled_for,now())::text);
  v_job:=enqueue_communication_job_internal(
    v_appointment.patient_id,p_contact_id,v_appointment.id,null,null,'APPOINTMENT_REMINDER',
    p_channel,p_scheduled_for,v_appointment.updated_at::text,v_appointment.start_time,
    v_dedupe,v_actor
  );
  v_result:=jsonb_build_object('job_id',v_job.id,'job_version',v_job.version,
    'status',v_job.status,'scheduled_for',v_job.scheduled_for,'already_applied',false);
  insert into communication_idempotency(actor_key,operation,idempotency_key,request_hash,result)
  values(v_actor::text,'QUEUE_APPOINTMENT_REMINDER',trim(p_idempotency_key),v_hash,v_result);
  return v_result;
end
$queue_reminder$;
revoke all on function queue_appointment_reminder(uuid,uuid,communication_channel,timestamptz,text) from public;
grant execute on function queue_appointment_reminder(uuid,uuid,communication_channel,timestamptz,text) to authenticated;

create or replace function queue_recovery_message(
  p_recovery_case_id uuid,
  p_recovery_offer_id uuid,
  p_contact_id uuid,
  p_channel communication_channel,
  p_message_type communication_message_type,
  p_scheduled_for timestamptz,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $queue_recovery$
declare
  v_actor uuid:=auth.uid();
  v_case recovery_cases%rowtype;
  v_offer recovery_offers%rowtype;
  v_job communication_jobs%rowtype;
  v_payload jsonb;
  v_hash text;
  v_existing communication_idempotency%rowtype;
  v_entity_version text;
  v_expires timestamptz;
  v_dedupe text;
  v_result jsonb;
  v_disruption_id uuid;
begin
  if v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER' then
    raise exception 'Only schedulers may queue recovery messages';
  end if;
  if p_message_type not in ('RECOVERY_OFFER','RECOVERY_UPDATE') then
    raise exception 'Recovery message type is invalid';
  end if;
  if (p_message_type='RECOVERY_OFFER')<>(p_recovery_offer_id is not null) then
    raise exception 'Recovery offer messages require one specific offer';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;
  v_payload:=jsonb_build_object('case_id',p_recovery_case_id,'offer_id',p_recovery_offer_id,
    'contact_id',p_contact_id,'channel',p_channel,'message_type',p_message_type,
    'scheduled_for',p_scheduled_for);
  v_hash:=md5(v_payload::text);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':QUEUE_RECOVERY_MESSAGE:'||trim(p_idempotency_key),0));
  select * into v_existing from communication_idempotency i
  where actor_key=v_actor::text and operation='QUEUE_RECOVERY_MESSAGE'
    and idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'Idempotency key payload does not match'; end if;
    return v_existing.result||jsonb_build_object('already_applied',true);
  end if;
  select disruption_id into v_disruption_id from recovery_cases where id=p_recovery_case_id;
  if not found then raise exception 'Recovery case was not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('RECOVERY_DISRUPTION:'||v_disruption_id::text,0));
  select * into v_case from recovery_cases rc where rc.id=p_recovery_case_id for update;
  if p_message_type='RECOVERY_OFFER' then
    if v_case.status<>'OFFERED' then
      raise exception 'Recovery case is no longer active';
    end if;
    select * into v_offer from recovery_offers ro where ro.id=p_recovery_offer_id for update;
    if not found or v_offer.recovery_case_id<>v_case.id then raise exception 'Recovery offer does not belong to this case'; end if;
    if v_offer.status<>'PENDING' or v_offer.expires_at<=now() then raise exception 'Recovery offer is no longer available'; end if;
    v_entity_version:='case:'||v_case.version||';offer:'||v_offer.version;
    v_expires:=v_offer.expires_at;
  else
    if p_recovery_offer_id is not null then raise exception 'Recovery update must not reference an offer'; end if;
    v_entity_version:='case:'||v_case.version;
    v_expires:=greatest(now()+interval '5 minutes',least(now()+interval '7 days',v_case.original_end_time+interval '7 days'));
  end if;
  v_dedupe:='recovery:'||v_case.id||':'||coalesce(p_recovery_offer_id::text,'update')||':'||
    p_contact_id||':'||p_channel||':'||md5(v_entity_version||':'||coalesce(p_scheduled_for,now())::text);
  v_job:=enqueue_communication_job_internal(
    v_case.patient_id,p_contact_id,null,v_case.id,p_recovery_offer_id,p_message_type,
    p_channel,p_scheduled_for,v_entity_version,v_expires,v_dedupe,v_actor
  );
  v_result:=jsonb_build_object('job_id',v_job.id,'job_version',v_job.version,
    'recovery_case_id',v_case.id,'recovery_offer_id',p_recovery_offer_id,
    'status',v_job.status,'scheduled_for',v_job.scheduled_for,'expires_at',v_job.expires_at,
    'already_applied',false);
  insert into communication_idempotency(actor_key,operation,idempotency_key,request_hash,result)
  values(v_actor::text,'QUEUE_RECOVERY_MESSAGE',trim(p_idempotency_key),v_hash,v_result);
  return v_result;
end
$queue_recovery$;
revoke all on function queue_recovery_message(uuid,uuid,uuid,communication_channel,communication_message_type,timestamptz,text) from public;
grant execute on function queue_recovery_message(uuid,uuid,uuid,communication_channel,communication_message_type,timestamptz,text) to authenticated;

create or replace function sync_appointment_reminders(p_appointment_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $sync_one$
declare
  v_actor uuid:=auth.uid();
  v_service boolean:=coalesce(auth.role()='service_role',false);
  v_appointment appointments%rowtype;
  v_rec record;
  v_target timestamptz;
  v_allowed timestamptz;
  v_dedupe text;
  v_job communication_jobs%rowtype;
  v_ensured int:=0;
  v_cancelled int:=0;
  v_has_primary boolean:=false;
begin
  if not v_service and (v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER') then
    raise exception 'Only schedulers or the communication worker may sync reminders';
  end if;
  select * into v_appointment from appointments a where a.id=p_appointment_id for update;
  if not found then raise exception 'Appointment was not found'; end if;

  update communication_jobs j set cancelled_at=now(),cancelled_by=v_actor,
    cancellation_reason='Reminder source or recipient preference changed',
    status=case when j.status='PROCESSING' then j.status else 'CANCELLED' end,
    processing_token=case when j.status='PROCESSING' then j.processing_token else null end,
    processing_worker=case when j.status='PROCESSING' then j.processing_worker else null end,
    processing_started_at=case when j.status='PROCESSING' then j.processing_started_at else null end,
    version=j.version+1
  where j.appointment_id=v_appointment.id and j.message_type='APPOINTMENT_REMINDER'
    and j.status in ('QUEUED','PROCESSING','FAILED') and (
      v_appointment.status not in ('SCHEDULED','CONFIRMED') or v_appointment.start_time<=now()
      or j.source_entity_version<>v_appointment.updated_at::text
      or not exists(
        select 1 from patient_contacts pc join communication_consents cc
          on cc.patient_contact_id=pc.id and cc.channel=j.channel
        where pc.id=j.patient_contact_id and pc.patient_id=v_appointment.patient_id
          and pc.active and pc.relationship_verified_at is not null
          and pc.authorized_to_receive_information
          and cc.status='GRANTED' and pc.version=j.source_contact_version
          and cc.version=j.source_consent_version
          and communication_destination(pc,j.channel) is not null
      )
    );
  get diagnostics v_cancelled=row_count;
  if v_appointment.status not in ('SCHEDULED','CONFIRMED') or v_appointment.start_time<=now() then
    return jsonb_build_object('appointment_id',v_appointment.id,'ensured_count',0,
      'cancelled_count',v_cancelled,'active',false);
  end if;

  for v_rec in
    select pc.*,cc.channel,cc.version as consent_version,reminder.offset_name,reminder.offset_value
    from patient_contacts pc
    join communication_consents cc on cc.patient_contact_id=pc.id and cc.patient_id=pc.patient_id
    cross join (values('24h',interval '24 hours'),('2h',interval '2 hours')) reminder(offset_name,offset_value)
    where pc.patient_id=v_appointment.patient_id and pc.active and pc.is_primary
      and pc.relationship_verified_at is not null
      and pc.relationship_effective_start<=current_date
      and (pc.relationship_effective_end is null or pc.relationship_effective_end>=current_date)
      and pc.authorized_to_receive_information and cc.status='GRANTED'
      and communication_destination(pc,cc.channel) is not null
    order by pc.is_primary desc,pc.id,cc.channel,reminder.offset_value desc
  loop
    v_has_primary:=true;
    -- Do not collapse multiple missed offsets into duplicate immediate sends.
    -- A scheduler can still use the explicit one-off reminder command when a
    -- clinically appropriate catch-up message is needed.
    if v_appointment.start_time-v_rec.offset_value<=now() then continue; end if;
    v_target:=v_appointment.start_time-v_rec.offset_value;
    v_allowed:=communication_allowed_time(v_target,v_rec.timezone,v_rec.quiet_hours_start,v_rec.quiet_hours_end);
    if v_allowed>=v_appointment.start_time then continue; end if;
    v_dedupe:='appt-sync:'||v_appointment.id||':'||md5(v_appointment.updated_at::text)||':'||
      v_rec.id||':'||v_rec.channel||':'||v_rec.offset_name||':c'||v_rec.version||':s'||v_rec.consent_version;
    v_job:=enqueue_communication_job_internal(
      v_appointment.patient_id,v_rec.id,v_appointment.id,null,null,'APPOINTMENT_REMINDER',
      v_rec.channel,v_allowed,v_appointment.updated_at::text,v_appointment.start_time,
      v_dedupe,v_actor
    );
    v_ensured:=v_ensured+1;
  end loop;
  return jsonb_build_object('appointment_id',v_appointment.id,'ensured_count',v_ensured,
    'cancelled_count',v_cancelled,'active',true,'needs_manual_review',not v_has_primary);
end
$sync_one$;
revoke all on function sync_appointment_reminders(uuid) from public;
grant execute on function sync_appointment_reminders(uuid) to authenticated,service_role;

create or replace function sync_upcoming_appointment_reminders(
  p_horizon_days int,p_limit int
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $sync_upcoming$
declare
  v_actor uuid:=auth.uid();
  v_service boolean:=coalesce(auth.role()='service_role',false);
  v_row record;
  v_result jsonb;
  v_processed int:=0;
  v_failed int:=0;
  v_ensured int:=0;
  v_cancelled int:=0;
  v_manual_review int:=0;
  v_stale_cancelled int:=0;
begin
  if not v_service and (v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER') then
    raise exception 'Only schedulers or the communication worker may sync reminders';
  end if;
  if p_horizon_days not between 1 and 31 or p_limit not between 1 and 500 then
    raise exception 'Reminder sync bounds are invalid';
  end if;
  -- Reconcile inactive and changed appointments too. Restricting the active
  -- loop below would otherwise leave cancelled/past reminders looking queued
  -- until a delivery worker happened to claim them.
  with stale as (
    select j.id from communication_jobs j
    join appointments a on a.id=j.appointment_id
    where j.message_type='APPOINTMENT_REMINDER'
      and j.status in ('QUEUED','PROCESSING','FAILED')
      and (a.status not in ('SCHEDULED','CONFIRMED') or a.start_time<=now()
        or a.updated_at::text<>j.source_entity_version)
    order by j.created_at,j.id limit p_limit for update of j skip locked
  )
  update communication_jobs j set
    status=case when j.status='PROCESSING' then j.status else 'CANCELLED' end,
    cancelled_at=now(),cancellation_reason='Appointment changed or is no longer active',
    processing_token=case when j.status='PROCESSING' then j.processing_token else null end,
    processing_worker=case when j.status='PROCESSING' then j.processing_worker else null end,
    processing_started_at=case when j.status='PROCESSING' then j.processing_started_at else null end,
    version=j.version+1
  from stale where stale.id=j.id;
  get diagnostics v_stale_cancelled=row_count;
  v_cancelled:=v_cancelled+v_stale_cancelled;
  for v_row in
    select a.id from appointments a
    where a.status in ('SCHEDULED','CONFIRMED') and a.start_time>now()
      and a.start_time<=now()+make_interval(days=>p_horizon_days)
    order by a.start_time,a.id limit p_limit
  loop
    begin
      v_result:=sync_appointment_reminders(v_row.id);
      v_processed:=v_processed+1;
      v_ensured:=v_ensured+coalesce((v_result->>'ensured_count')::int,0);
      v_cancelled:=v_cancelled+coalesce((v_result->>'cancelled_count')::int,0);
      if coalesce((v_result->>'needs_manual_review')::boolean,false) then
        v_manual_review:=v_manual_review+1;
      end if;
    exception when others then
      v_failed:=v_failed+1;
    end;
  end loop;
  return jsonb_build_object('processed_count',v_processed,'failed_count',v_failed,
    'ensured_count',v_ensured,'cancelled_count',v_cancelled,
    'manual_review_count',v_manual_review);
end
$sync_upcoming$;
revoke all on function sync_upcoming_appointment_reminders(int,int) from public;
grant execute on function sync_upcoming_appointment_reminders(int,int) to authenticated,service_role;

create or replace function cancel_stale_recovery_communications()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $cancel_recovery_messages$
begin
  if tg_table_name='recovery_cases' then
    update communication_jobs set
      status=case when status='PROCESSING' then status else 'CANCELLED' end,
      cancelled_at=now(),cancellation_reason='Recovery case changed',
      processing_token=case when status='PROCESSING' then processing_token else null end,
      processing_worker=case when status='PROCESSING' then processing_worker else null end,
      processing_started_at=case when status='PROCESSING' then processing_started_at else null end,
      version=version+1
    where recovery_case_id=new.id and status in ('QUEUED','PROCESSING','FAILED')
      and (
        new.status<>'OFFERED'
        or (message_type='RECOVERY_UPDATE' and source_entity_version<>'case:'||new.version)
        or (message_type='RECOVERY_OFFER' and source_entity_version not like 'case:'||new.version||';%')
      );
  else
    update communication_jobs set
      status=case when status='PROCESSING' then status else 'CANCELLED' end,
      cancelled_at=now(),cancellation_reason='Recovery offer changed',
      processing_token=case when status='PROCESSING' then processing_token else null end,
      processing_worker=case when status='PROCESSING' then processing_worker else null end,
      processing_started_at=case when status='PROCESSING' then processing_started_at else null end,
      version=version+1
    where recovery_offer_id=new.id and status in ('QUEUED','PROCESSING','FAILED')
      and (new.status<>'PENDING' or source_entity_version not like '%;offer:'||new.version);
  end if;
  return new;
end
$cancel_recovery_messages$;
drop trigger if exists recovery_cases_cancel_communications_trigger on recovery_cases;
create trigger recovery_cases_cancel_communications_trigger after update on recovery_cases
for each row when (old.version is distinct from new.version or old.status is distinct from new.status)
execute function cancel_stale_recovery_communications();
drop trigger if exists recovery_offers_cancel_communications_trigger on recovery_offers;
create trigger recovery_offers_cancel_communications_trigger after update on recovery_offers
for each row when (old.version is distinct from new.version or old.status is distinct from new.status)
execute function cancel_stale_recovery_communications();
revoke all on function cancel_stale_recovery_communications() from public,anon,authenticated;

-- Claiming returns only an opaque lease. The worker must call
-- prepare_communication_delivery immediately before the provider request; that
-- second call revalidates every source and is the only RPC that reveals a
-- destination or message body.
create or replace function claim_communication_jobs(p_limit int,p_worker_id text)
returns table(job_id uuid,processing_token uuid,attempt_number int,lease_expires_at timestamptz)
language plpgsql security definer set search_path=public,pg_catalog as $claim$
declare
  v_job communication_jobs%rowtype;
  v_token uuid;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  if p_limit not between 1 and 100 or length(trim(coalesce(p_worker_id,''))) not between 3 and 100 then
    raise exception 'Worker claim parameters are invalid';
  end if;
  update communication_jobs set status='EXPIRED',last_error_category='EXPIRED_BEFORE_SEND',
    processing_token=null,processing_worker=null,processing_started_at=null,version=version+1
  where status in ('QUEUED','FAILED') and expires_at<=now();
  for v_job in
    select j.* from communication_jobs j
    where j.status in ('QUEUED','FAILED') and j.next_attempt_at<=now() and j.scheduled_for<=now()
      and j.expires_at>now() and j.attempt_count<j.max_attempts
      and (
        j.status='QUEUED'
        or j.last_error_category='WORKER_LEASE_EXPIRED'
        or exists(
          select 1 from communication_delivery_attempts a
          where a.communication_job_id=j.id
            and a.attempt_number=j.attempt_count
            and a.outcome='TEMPORARY_FAILURE'
        )
      )
    order by j.next_attempt_at,j.created_at,j.id
    limit p_limit for update skip locked
  loop
    v_token:=gen_random_uuid();
    update communication_jobs set status='PROCESSING',processing_token=v_token,
      processing_worker=trim(p_worker_id),processing_started_at=now(),
      attempt_count=attempt_count+1,version=version+1
    where id=v_job.id;
    job_id:=v_job.id;
    processing_token:=v_token;
    attempt_number:=v_job.attempt_count+1;
    lease_expires_at:=now()+interval '5 minutes';
    return next;
  end loop;
end
$claim$;
revoke all on function claim_communication_jobs(int,text) from public,anon,authenticated;
grant execute on function claim_communication_jobs(int,text) to service_role;

create or replace function prepare_communication_delivery(p_job_id uuid,p_processing_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $prepare$
declare
  v_job communication_jobs%rowtype;
  v_contact patient_contacts%rowtype;
  v_consent communication_consents%rowtype;
  v_appointment appointments%rowtype;
  v_case recovery_cases%rowtype;
  v_offer recovery_offers%rowtype;
  v_allowed timestamptz;
  v_destination text;
  v_invalid text;
  v_disruption_id uuid;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  select * into v_job from communication_jobs where id=p_job_id;
  if not found then raise exception 'Communication job was not found'; end if;
  if v_job.recovery_case_id is not null then
    select disruption_id into v_disruption_id from recovery_cases where id=v_job.recovery_case_id;
    if found then
      perform pg_advisory_xact_lock(hashtextextended('RECOVERY_DISRUPTION:'||v_disruption_id::text,0));
    end if;
  end if;
  select * into v_job from communication_jobs where id=p_job_id for update;
  if not found or v_job.status<>'PROCESSING' or v_job.processing_token is distinct from p_processing_token then
    raise exception 'Communication lease is invalid';
  end if;
  if v_job.processing_started_at<now()-interval '5 minutes' then v_invalid:='LEASE_EXPIRED'; end if;
  if v_job.cancelled_at is not null then v_invalid:='CANCELLED_BEFORE_SEND'; end if;
  if v_job.expires_at<=now() then v_invalid:='EXPIRED_BEFORE_SEND'; end if;
  if not exists(select 1 from communication_delivery_config where singleton and delivery_mode='LIVE') then
    v_invalid:='RECORD_ONLY_MODE';
  end if;
  -- Source rows are snapshot reads. Holding the job lock while also locking a
  -- contact/appointment would invert the mutation paths (source -> job), and
  -- those locks would be released before the external provider call anyway.
  select * into v_contact from patient_contacts where id=v_job.patient_contact_id;
  if not found or v_contact.patient_id<>v_job.patient_id or not v_contact.active
    or v_contact.relationship_verified_at is null
    or v_contact.relationship_effective_start>current_date
    or (v_contact.relationship_effective_end is not null and v_contact.relationship_effective_end<current_date)
    or not v_contact.authorized_to_receive_information
    or v_contact.version<>v_job.source_contact_version then
    v_invalid:='CONTACT_CHANGED';
  end if;
  if v_invalid is null then
    select * into v_consent from communication_consents
    where patient_contact_id=v_contact.id and channel=v_job.channel;
    if not found or v_consent.status<>'GRANTED' or v_consent.patient_id<>v_job.patient_id
      or v_consent.version<>v_job.source_consent_version then
      v_invalid:='CONSENT_CHANGED';
    end if;
  end if;
  if v_invalid is null then
    v_destination:=communication_destination(v_contact,v_job.channel);
    if v_destination is null then v_invalid:='DESTINATION_MISSING'; end if;
  end if;
  if v_invalid is null and communication_destination_fingerprint(
      v_job.channel,v_destination
    ) is distinct from v_job.destination_fingerprint then
    v_invalid:='DESTINATION_CHANGED';
  end if;
  if v_invalid is null and exists(
    select 1 from communication_destination_suppressions s
    where s.channel=v_job.channel
      and s.destination_fingerprint=v_job.destination_fingerprint
  ) then
    v_invalid:='DESTINATION_SUPPRESSED';
  end if;
  if v_invalid is null and v_job.message_type='APPOINTMENT_REMINDER' then
    select * into v_appointment from appointments where id=v_job.appointment_id;
    if not found or v_appointment.patient_id<>v_job.patient_id
      or v_appointment.status not in ('SCHEDULED','CONFIRMED')
      or v_appointment.start_time<=now()
      or v_appointment.updated_at::text<>v_job.source_entity_version then
      v_invalid:='APPOINTMENT_CHANGED';
    end if;
  elsif v_invalid is null and v_job.message_type in ('RECOVERY_OFFER','RECOVERY_UPDATE') then
    select * into v_case from recovery_cases where id=v_job.recovery_case_id;
    if not found or v_case.patient_id<>v_job.patient_id then
      v_invalid:='RECOVERY_CASE_CHANGED';
    elsif v_job.message_type='RECOVERY_UPDATE' and 'case:'||v_case.version<>v_job.source_entity_version then
      v_invalid:='RECOVERY_CASE_CHANGED';
    elsif v_job.message_type='RECOVERY_OFFER' then
      select * into v_offer from recovery_offers where id=v_job.recovery_offer_id;
      if v_case.status<>'OFFERED' or not found or v_offer.recovery_case_id<>v_case.id or v_offer.status<>'PENDING'
        or v_offer.expires_at<=now()
        or 'case:'||v_case.version||';offer:'||v_offer.version<>v_job.source_entity_version then
        v_invalid:='RECOVERY_OFFER_CHANGED';
      end if;
    end if;
  end if;
  if v_invalid is not null then
    update communication_jobs set
      status=case when v_invalid like 'EXPIRED%' then 'EXPIRED' else 'SUPPRESSED' end,
      last_error_category=v_invalid,processing_token=null,processing_worker=null,
      processing_started_at=null,version=version+1
    where id=v_job.id;
    return jsonb_build_object('ready',false,'job_id',v_job.id,
      'status',case when v_invalid like 'EXPIRED%' then 'EXPIRED' else 'SUPPRESSED' end,
      'reason',v_invalid);
  end if;
  v_allowed:=communication_allowed_time(now(),v_contact.timezone,
    v_contact.quiet_hours_start,v_contact.quiet_hours_end);
  if v_allowed>now()+interval '5 seconds' then
    if v_allowed>=v_job.expires_at then
      update communication_jobs set status='SUPPRESSED',last_error_category='QUIET_HOURS_PAST_EXPIRY',
        processing_token=null,processing_worker=null,processing_started_at=null,version=version+1
      where id=v_job.id;
      return jsonb_build_object('ready',false,'job_id',v_job.id,'status','SUPPRESSED','reason','QUIET_HOURS_PAST_EXPIRY');
    end if;
    update communication_jobs set status='QUEUED',scheduled_for=v_allowed,next_attempt_at=v_allowed,
      last_error_category=null,processing_token=null,processing_worker=null,processing_started_at=null,
      attempt_count=greatest(0,attempt_count-1),version=version+1
    where id=v_job.id;
    return jsonb_build_object('ready',false,'job_id',v_job.id,'status','QUEUED',
      'scheduled_for',v_allowed,'reason','QUIET_HOURS');
  end if;
  return jsonb_build_object(
    'ready',true,'job_id',v_job.id,'processing_token',v_job.processing_token,
    'attempt_number',v_job.attempt_count,'channel',v_job.channel,
    'destination',v_destination,'destination_hash',v_job.destination_fingerprint,
    'message_type',v_job.message_type,
    'subject',v_job.subject_snapshot,'body',v_job.body_snapshot,
    'expires_at',v_job.expires_at
  );
end
$prepare$;
revoke all on function prepare_communication_delivery(uuid,uuid) from public,anon,authenticated;
grant execute on function prepare_communication_delivery(uuid,uuid) to service_role;

create or replace function record_communication_delivery_outcome(
  p_job_id uuid,p_processing_token uuid,p_provider text,p_provider_message_id text,
  p_outcome communication_attempt_outcome,p_error_category text,p_http_status int,
  p_destination_hash text,p_started_at timestamptz,p_completed_at timestamptz,p_metadata jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $record_outcome$
declare
  v_job communication_jobs%rowtype;
  v_attempt_id bigint;
  v_status communication_job_status;
  v_retry_at timestamptz;
  v_metadata jsonb;
  v_contact patient_contacts%rowtype;
  v_consent communication_consents%rowtype;
  v_receipt communication_delivery_receipts%rowtype;
  v_lease_started_at timestamptz;
  v_invalid text;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  if p_processing_token is null
    or length(trim(coalesce(p_provider,''))) not between 2 and 80
    or p_destination_hash !~ '^[A-Fa-f0-9]{64}$'
    or p_completed_at<p_started_at or p_completed_at>now()+interval '5 minutes' then
    raise exception 'Delivery outcome payload is invalid';
  end if;
  select * into v_job from communication_jobs where id=p_job_id for update;
  if not found then raise exception 'Communication job was not found'; end if;
  if v_job.status<>'PROCESSING' or v_job.processing_token is distinct from p_processing_token then
    -- Safe replay after a worker lost the response.
    select id into v_attempt_id from communication_delivery_attempts
    where communication_job_id=p_job_id
      and processing_token_hash=encode(sha256(convert_to(p_processing_token::text,'UTF8')),'hex');
    if found then return jsonb_build_object('job_id',v_job.id,'attempt_id',v_attempt_id,
      'status',v_job.status,'already_applied',true); end if;
    raise exception 'Communication lease is invalid';
  end if;
  if lower(p_destination_hash)<>v_job.destination_fingerprint then
    raise exception 'Delivery destination fingerprint does not match the claimed job';
  end if;
  v_lease_started_at:=v_job.processing_started_at;
  if v_job.cancelled_at is not null then v_invalid:='CANCELLED_DURING_DELIVERY'; end if;
  select * into v_contact from patient_contacts where id=v_job.patient_contact_id;
  if not found or not v_contact.active or v_contact.relationship_verified_at is null
    or not v_contact.authorized_to_receive_information
    or v_contact.relationship_effective_start>current_date
    or (v_contact.relationship_effective_end is not null and v_contact.relationship_effective_end<current_date)
    or v_contact.version<>v_job.source_contact_version then v_invalid:='CONTACT_CHANGED_DURING_DELIVERY'; end if;
  select * into v_consent from communication_consents
  where patient_contact_id=v_job.patient_contact_id and channel=v_job.channel;
  if not found or v_consent.status<>'GRANTED' or v_consent.version<>v_job.source_consent_version then
    v_invalid:='CONSENT_CHANGED_DURING_DELIVERY';
  end if;
  v_metadata:=jsonb_strip_nulls(jsonb_build_object(
    'provider_status',left(coalesce(p_metadata->>'provider_status',''),80),
    'provider_region',left(coalesce(p_metadata->>'provider_region',''),40)
  ));
  insert into communication_delivery_attempts(
    communication_job_id,attempt_number,provider,provider_message_id,outcome,error_category,
    http_status,destination_hash,processing_token_hash,started_at,completed_at,metadata
  ) values(
    v_job.id,v_job.attempt_count,trim(p_provider),nullif(trim(coalesce(p_provider_message_id,'')),''),
    p_outcome,nullif(left(trim(coalesce(p_error_category,'')),100),''),p_http_status,
    lower(p_destination_hash),encode(sha256(convert_to(p_processing_token::text,'UTF8')),'hex'),
    p_started_at,p_completed_at,v_metadata
  ) returning id into v_attempt_id;
  -- A provider webhook can race its API response. Attach any receipts that
  -- arrived during this lease now that the immutable attempt exists.
  update communication_delivery_receipts set communication_attempt_id=v_attempt_id
  where communication_job_id=v_job.id and communication_attempt_id is null
    and recorded_at>=v_lease_started_at;
  v_status:=case when v_invalid is not null then 'SUPPRESSED'::communication_job_status else case p_outcome
    when 'DELIVERED' then 'DELIVERED'
    when 'ACCEPTED' then 'SENT'
    else 'FAILED'
  end end;
  if v_invalid is null and p_outcome='TEMPORARY_FAILURE'
    and v_job.attempt_count<v_job.max_attempts then
    -- Deterministic jitter avoids synchronized retry bursts while preserving
    -- idempotent outcomes for a given job attempt.
    v_retry_at:=now()
      +make_interval(mins=>least(60,5*(2^greatest(0,v_job.attempt_count-1))::int))
      +make_interval(secs=>((hashtextextended(v_job.id::text||':'||v_job.attempt_count::text,0)%60+60)%60)::double precision);
    if v_retry_at>=v_job.expires_at then v_retry_at:=v_job.expires_at; end if;
  end if;
  update communication_jobs set status=v_status,
    delivered_at=case when v_status='DELIVERED' then p_completed_at else delivered_at end,
    last_error_category=case when v_invalid is not null then v_invalid
      when v_status='FAILED' then coalesce(nullif(left(trim(coalesce(p_error_category,'')),100),''),p_outcome::text) else null end,
    next_attempt_at=coalesce(v_retry_at,next_attempt_at),
    processing_token=null,processing_worker=null,processing_started_at=null,version=version+1
  where id=v_job.id returning * into v_job;
  -- If a webhook won the race, its provider state is authoritative. Apply the
  -- newest receipt only after the attempt is safely recorded and the lease is
  -- released; delivery can never regress to a non-revocation failure.
  select * into v_receipt from communication_delivery_receipts
  where communication_job_id=v_job.id and recorded_at>=v_lease_started_at
  order by case when receipt_type='DELIVERED' then 1 else 0 end desc,
    occurred_at desc,
    case receipt_type when 'OPT_OUT' then 40 when 'COMPLAINT' then 40
      when 'DELIVERED' then 30 when 'BOUNCED' then 20 when 'FAILED' then 20 else 10 end desc,
    id desc limit 1;
  if found and v_job.cancelled_at is null
    and v_job.status not in ('SUPPRESSED','CANCELLED','EXPIRED')
    and v_receipt.receipt_type not in ('OPT_OUT','COMPLAINT')
    and not (v_receipt.receipt_type='BOUNCED'
      and upper(coalesce(v_receipt.metadata->>'provider_status',''))='HARD_BOUNCE') then
    update communication_jobs set
      status=case
        when v_receipt.receipt_type='DELIVERED' then 'DELIVERED'
        when v_receipt.receipt_type='ACCEPTED' and status<>'DELIVERED' then 'SENT'
        when v_receipt.receipt_type in ('BOUNCED','FAILED') and status<>'DELIVERED' then 'FAILED'
        else status end,
      delivered_at=case when v_receipt.receipt_type='DELIVERED'
        then coalesce(delivered_at,v_receipt.occurred_at) else delivered_at end,
      last_error_category=case
        when v_receipt.receipt_type in ('BOUNCED','FAILED') and status<>'DELIVERED'
          then v_receipt.receipt_type::text
        when v_receipt.receipt_type in ('ACCEPTED','DELIVERED') then null
        else last_error_category end,
      version=version+1
    where id=v_job.id returning * into v_job;
  end if;
  return jsonb_build_object('job_id',v_job.id,'job_version',v_job.version,
    'attempt_id',v_attempt_id,'status',v_job.status,'already_applied',false);
end
$record_outcome$;
revoke all on function record_communication_delivery_outcome(uuid,uuid,text,text,communication_attempt_outcome,text,int,text,timestamptz,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function record_communication_delivery_outcome(uuid,uuid,text,text,communication_attempt_outcome,text,int,text,timestamptz,timestamptz,jsonb) to service_role;

create or replace function record_communication_receipt(
  p_job_id uuid,p_provider_event_id text,p_receipt_type communication_receipt_type,
  p_occurred_at timestamptz,p_metadata jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $receipt$
declare
  v_job communication_jobs%rowtype;
  v_receipt communication_delivery_receipts%rowtype;
  v_attempt_id bigint;
  v_consent communication_consents%rowtype;
  v_metadata jsonb;
  v_revoke_consent boolean:=false;
  v_revoke_source text;
  v_receipt_precedence int;
  v_apply_state boolean;
  v_destination_fingerprint text;
  v_contact_id uuid;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  if length(trim(coalesce(p_provider_event_id,''))) not between 3 and 300
    or p_occurred_at>now()+interval '5 minutes' then raise exception 'Receipt payload is invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_RECEIPT:'||trim(p_provider_event_id),0));
  select * into v_receipt from communication_delivery_receipts
  where provider_event_id=trim(p_provider_event_id);
  if found then
    if v_receipt.communication_job_id<>p_job_id or v_receipt.receipt_type<>p_receipt_type then
      raise exception 'Provider event ID was already used for a different receipt';
    end if;
    return jsonb_build_object('receipt_id',v_receipt.id,'job_id',p_job_id,'already_applied',true);
  end if;
  select destination_fingerprint,patient_contact_id
    into v_destination_fingerprint,v_contact_id
  from communication_jobs where id=p_job_id;
  if not found then raise exception 'Communication job was not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'COMMUNICATION_DESTINATION:'||v_destination_fingerprint,0
  ));
  perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_CONTACT:'||v_contact_id::text,0));
  select * into v_job from communication_jobs where id=p_job_id for update;
  if not found then raise exception 'Communication job was not found'; end if;
  if v_job.status='PROCESSING' then
    -- The current attempt does not exist until the worker records its API
    -- outcome; leave the raced receipt unlinked for that outcome to attach.
    v_attempt_id:=null;
  else
    select id into v_attempt_id from communication_delivery_attempts
    where communication_job_id=v_job.id order by attempt_number desc limit 1;
  end if;
  v_metadata:=jsonb_strip_nulls(jsonb_build_object(
    'provider_status',left(coalesce(p_metadata->>'provider_status',''),80),
    'event_source',left(coalesce(p_metadata->>'event_source',''),40)
  ));
  v_revoke_consent:=p_receipt_type in ('OPT_OUT','COMPLAINT')
    or (p_receipt_type='BOUNCED' and upper(coalesce(p_metadata->>'provider_status',''))='HARD_BOUNCE');
  v_revoke_source:=case
    when p_receipt_type='OPT_OUT' then 'PROVIDER_OPT_OUT'
    when p_receipt_type='COMPLAINT' then 'PROVIDER_COMPLAINT'
    else 'HARD_BOUNCE' end;
  v_receipt_precedence:=case p_receipt_type
    when 'ACCEPTED' then 10
    when 'BOUNCED' then 20
    when 'FAILED' then 20
    when 'DELIVERED' then 30
    when 'COMPLAINT' then 40
    when 'OPT_OUT' then 40
  end;
  v_apply_state:=v_revoke_consent
    or v_job.last_receipt_at is null
    or p_occurred_at>v_job.last_receipt_at
    or (p_occurred_at=v_job.last_receipt_at
      and v_receipt_precedence>v_job.last_receipt_precedence);
  insert into communication_delivery_receipts(
    communication_job_id,communication_attempt_id,provider_event_id,receipt_type,occurred_at,metadata
  ) values(v_job.id,v_attempt_id,trim(p_provider_event_id),p_receipt_type,p_occurred_at,v_metadata)
  returning * into v_receipt;
  if v_revoke_consent then
    insert into communication_destination_suppressions(
      channel,destination_fingerprint,source,first_suppressed_at,last_seen_at,last_provider_event_id
    ) values(
      v_job.channel,v_job.destination_fingerprint,v_revoke_source,
      p_occurred_at,p_occurred_at,trim(p_provider_event_id)
    ) on conflict(channel,destination_fingerprint) do update set
      source=case
        when excluded.last_seen_at>=communication_destination_suppressions.last_seen_at
          then excluded.source else communication_destination_suppressions.source end,
      last_seen_at=greatest(communication_destination_suppressions.last_seen_at,excluded.last_seen_at),
      last_provider_event_id=case
        when excluded.last_seen_at>=communication_destination_suppressions.last_seen_at
          then excluded.last_provider_event_id
        else communication_destination_suppressions.last_provider_event_id end;
    -- Opt-outs, complaints, and hard bounces are authoritative even when the
    -- provider delivers them out of order. A delivered historical message is
    -- not rewritten, but every still-actionable message is cancelled below.
    update communication_jobs set
      status=case
        when status='PROCESSING' then status
        when status in ('QUEUED','FAILED','SENT') then 'CANCELLED'
        else status end,
      last_receipt_at=case
        when last_receipt_at is null or p_occurred_at>last_receipt_at then p_occurred_at
        else last_receipt_at end,
      last_receipt_precedence=case
        when last_receipt_at is null or p_occurred_at>last_receipt_at then v_receipt_precedence
        when p_occurred_at=last_receipt_at then greatest(last_receipt_precedence,v_receipt_precedence)
        else last_receipt_precedence end,
      last_error_category=case when status='DELIVERED' then last_error_category else p_receipt_type::text end,
      processing_token=case when status='PROCESSING' then processing_token else null end,
      processing_worker=case when status='PROCESSING' then processing_worker else null end,
      processing_started_at=case when status='PROCESSING' then processing_started_at else null end,
      cancelled_at=case when status in ('QUEUED','FAILED','PROCESSING','SENT')
        then coalesce(cancelled_at,p_occurred_at) else cancelled_at end,
      cancellation_reason=case when status in ('QUEUED','FAILED','PROCESSING','SENT')
        then 'Recipient channel permission withdrawn' else cancellation_reason end,
      version=version+1
    where id=v_job.id returning * into v_job;
  elsif v_apply_state and v_job.status='PROCESSING' then
    -- Preserve the active lease until record_communication_delivery_outcome
    -- persists its attempt. That function then reconciles this receipt.
    update communication_jobs set
      last_receipt_at=p_occurred_at,
      last_receipt_precedence=v_receipt_precedence,
      version=version+1
    where id=v_job.id returning * into v_job;
  elsif v_apply_state then
    update communication_jobs set
      status=case
        when p_receipt_type='DELIVERED'
          and status not in ('DELIVERED','CANCELLED','SUPPRESSED','EXPIRED') then 'DELIVERED'
        when p_receipt_type='ACCEPTED'
          and status in ('QUEUED','FAILED','PROCESSING') then 'SENT'
        when p_receipt_type in ('BOUNCED','FAILED')
          and status in ('QUEUED','FAILED','PROCESSING','SENT') then 'FAILED'
        else status end,
      delivered_at=case
        when p_receipt_type='DELIVERED'
          and status not in ('CANCELLED','SUPPRESSED','EXPIRED')
          then coalesce(delivered_at,p_occurred_at)
        else delivered_at end,
      last_error_category=case
        when p_receipt_type in ('BOUNCED','FAILED') and status<>'DELIVERED' then p_receipt_type::text
        when p_receipt_type in ('ACCEPTED','DELIVERED') then null
        else last_error_category end,
      last_receipt_at=p_occurred_at,
      last_receipt_precedence=v_receipt_precedence,
      processing_token=case when status='PROCESSING' then null else processing_token end,
      processing_worker=case when status='PROCESSING' then null else processing_worker end,
      processing_started_at=case when status='PROCESSING' then null else processing_started_at end,
      version=version+1
    where id=v_job.id returning * into v_job;
  end if;
  if v_revoke_consent then
    -- Revoke every consent that resolves to the same normalized destination,
    -- including duplicate contacts and siblings that share a caregiver phone.
    for v_consent in
      select c.* from communication_consents c
      join patient_contacts pc on pc.id=c.patient_contact_id
      where c.channel=v_job.channel and c.status='GRANTED'
        and communication_destination_fingerprint(
          v_job.channel,communication_destination(pc,v_job.channel)
        )=v_job.destination_fingerprint
      for update of c
    loop
      update communication_consents set status='REVOKED',revoked_at=p_occurred_at,
        source=v_revoke_source,changed_by=null,version=version+1
      where id=v_consent.id returning * into v_consent;
      insert into communication_consent_events(
        consent_id,patient_id,patient_contact_id,channel,prior_status,new_status,source
      ) values(v_consent.id,v_consent.patient_id,v_consent.patient_contact_id,v_job.channel,
        'GRANTED','REVOKED',v_revoke_source);
    end loop;
    update communication_jobs set
      status=case when status='PROCESSING' then status else 'CANCELLED' end,
      cancelled_at=p_occurred_at,cancellation_reason='Recipient channel permission withdrawn',
      processing_token=case when status='PROCESSING' then processing_token else null end,
      processing_worker=case when status='PROCESSING' then processing_worker else null end,
      processing_started_at=case when status='PROCESSING' then processing_started_at else null end,
      version=version+1
    where destination_fingerprint=v_job.destination_fingerprint and channel=v_job.channel
      and id<>v_job.id and status in ('QUEUED','PROCESSING','FAILED');
  end if;
  return jsonb_build_object('receipt_id',v_receipt.id,'job_id',v_job.id,
    'job_version',v_job.version,'status',v_job.status,'already_applied',false);
end
$receipt$;
revoke all on function record_communication_receipt(uuid,text,communication_receipt_type,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function record_communication_receipt(uuid,text,communication_receipt_type,timestamptz,jsonb) to service_role;

create or replace function release_stale_communication_leases(p_limit int)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $release_leases$
declare v_count int;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  if p_limit not between 1 and 500 then raise exception 'Lease release limit is invalid'; end if;
  with stale as (
    select id from communication_jobs where status='PROCESSING'
      and processing_started_at<now()-interval '5 minutes'
    order by processing_started_at limit p_limit for update skip locked
  )
  update communication_jobs j set status=case when j.expires_at<=now() then 'EXPIRED' else 'FAILED' end,
    last_error_category='WORKER_LEASE_EXPIRED',processing_token=null,processing_worker=null,
    processing_started_at=null,next_attempt_at=now(),version=j.version+1
  from stale where stale.id=j.id;
  get diagnostics v_count=row_count;
  return jsonb_build_object('released_count',v_count);
end
$release_leases$;
revoke all on function release_stale_communication_leases(int) from public,anon,authenticated;
grant execute on function release_stale_communication_leases(int) to service_role;

create or replace function retry_communication_job(
  p_job_id uuid,p_expected_version int,p_reason text,p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $retry_job$
declare
  v_actor uuid:=auth.uid();
  v_job communication_jobs%rowtype;
  v_last_outcome communication_attempt_outcome;
  v_hash text:=md5(jsonb_build_object('job_id',p_job_id,'expected_version',p_expected_version,
    'reason',trim(coalesce(p_reason,'')))::text);
  v_existing communication_idempotency%rowtype;
  v_result jsonb;
begin
  if v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER' then raise exception 'Only schedulers may retry communications'; end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 500
    or length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'Retry reason and idempotency key are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':RETRY_COMMUNICATION:'||trim(p_idempotency_key),0));
  select * into v_existing from communication_idempotency
  where actor_key=v_actor::text and operation='RETRY_COMMUNICATION' and idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'Idempotency key payload does not match'; end if;
    return v_existing.result||jsonb_build_object('already_applied',true);
  end if;
  select * into v_job from communication_jobs where id=p_job_id for update;
  if not found or not can_read_patient_communication(v_job.patient_id) then raise exception 'Communication job was not found'; end if;
  if v_job.version<>p_expected_version then raise exception 'Communication job changed; refresh before retrying'; end if;
  if v_job.status<>'FAILED' then raise exception 'Only failed communications can be retried'; end if;
  if v_job.attempt_count>=v_job.max_attempts or v_job.expires_at<=now() then raise exception 'Communication cannot be retried'; end if;
  select outcome into v_last_outcome from communication_delivery_attempts
  where communication_job_id=v_job.id order by attempt_number desc limit 1;
  if v_last_outcome in ('PERMANENT_FAILURE','REJECTED') or v_job.last_error_category in ('COMPLAINT','OPT_OUT') then
    raise exception 'This delivery failure is not retryable';
  end if;
  update communication_jobs set status='QUEUED',next_attempt_at=now(),scheduled_for=least(scheduled_for,now()),
    last_error_category=null,cancelled_at=null,cancelled_by=null,cancellation_reason=null,version=version+1
  where id=v_job.id returning * into v_job;
  insert into audit_log(user_id,action,patient_id,new_values,override_reason)
  values(v_actor,'COMMUNICATION_RETRIED',v_job.patient_id,
    jsonb_build_object('job_id',v_job.id,'message_type',v_job.message_type,'channel',v_job.channel,
      'attempt_count',v_job.attempt_count,'version',v_job.version),trim(p_reason));
  v_result:=jsonb_build_object('job_id',v_job.id,'job_version',v_job.version,
    'status',v_job.status,'already_applied',false);
  insert into communication_idempotency(actor_key,operation,idempotency_key,request_hash,result)
  values(v_actor::text,'RETRY_COMMUNICATION',trim(p_idempotency_key),v_hash,v_result);
  return v_result;
end
$retry_job$;
revoke all on function retry_communication_job(uuid,int,text,text) from public;
grant execute on function retry_communication_job(uuid,int,text,text) to authenticated;

create or replace function cancel_communication_job(
  p_job_id uuid,p_expected_version int,p_reason text,p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $cancel_job$
declare
  v_actor uuid:=auth.uid();
  v_job communication_jobs%rowtype;
  v_hash text:=md5(jsonb_build_object('job_id',p_job_id,'expected_version',p_expected_version,
    'reason',trim(coalesce(p_reason,'')))::text);
  v_existing communication_idempotency%rowtype;
  v_result jsonb;
begin
  if v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER' then raise exception 'Only schedulers may cancel communications'; end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 500
    or length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'Cancellation reason and idempotency key are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':CANCEL_COMMUNICATION:'||trim(p_idempotency_key),0));
  select * into v_existing from communication_idempotency
  where actor_key=v_actor::text and operation='CANCEL_COMMUNICATION' and idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'Idempotency key payload does not match'; end if;
    return v_existing.result||jsonb_build_object('already_applied',true);
  end if;
  select * into v_job from communication_jobs where id=p_job_id for update;
  if not found or not can_read_patient_communication(v_job.patient_id) then raise exception 'Communication job was not found'; end if;
  if v_job.version<>p_expected_version then raise exception 'Communication job changed; refresh before cancelling'; end if;
  if v_job.status not in ('QUEUED','FAILED','PROCESSING') then raise exception 'Communication can no longer be cancelled'; end if;
  update communication_jobs set
    status=case when status='PROCESSING' then status else 'CANCELLED' end,
    cancelled_at=now(),cancelled_by=v_actor,cancellation_reason=trim(p_reason),
    processing_token=case when status='PROCESSING' then processing_token else null end,
    processing_worker=case when status='PROCESSING' then processing_worker else null end,
    processing_started_at=case when status='PROCESSING' then processing_started_at else null end,
    version=version+1
  where id=v_job.id returning * into v_job;
  insert into audit_log(user_id,action,patient_id,new_values,override_reason)
  values(v_actor,'COMMUNICATION_CANCELLED',v_job.patient_id,
    jsonb_build_object('job_id',v_job.id,'message_type',v_job.message_type,'channel',v_job.channel,
      'status',v_job.status,'version',v_job.version),trim(p_reason));
  v_result:=jsonb_build_object('job_id',v_job.id,'job_version',v_job.version,
    'status',v_job.status,'cancellation_requested',true,'already_applied',false);
  insert into communication_idempotency(actor_key,operation,idempotency_key,request_hash,result)
  values(v_actor::text,'CANCEL_COMMUNICATION',trim(p_idempotency_key),v_hash,v_result);
  return v_result;
end
$cancel_job$;
revoke all on function cancel_communication_job(uuid,int,text,text) from public;
grant execute on function cancel_communication_job(uuid,int,text,text) to authenticated;

-- Minimum-necessary projection for a treating provider: channel availability
-- and preferences only, never a name, phone number, email, or push endpoint.
create or replace function communication_contact_summary(p_patient_id uuid)
returns table(
  contact_id uuid,relationship text,is_primary boolean,authorized boolean,
  preferred_language text,timezone text,available_channels communication_channel[]
)
language plpgsql stable security definer set search_path=public,pg_catalog as $contact_summary$
begin
  if auth.uid() is null or current_app_role() is null or not (
    current_app_role()='SCHEDULER'
    or (current_app_role() in ('CLINICAL','PROVIDER') and is_on_patient_team(p_patient_id))
  ) then raise exception 'Patient communication summary is not available'; end if;
  return query
  select pc.id,pc.relationship,pc.is_primary,pc.authorized_to_receive_information,
    pc.preferred_language,pc.timezone,
    coalesce(array_agg(cc.channel order by cc.channel) filter(where cc.status='GRANTED'),
      array[]::communication_channel[])
  from patient_contacts pc left join communication_consents cc on cc.patient_contact_id=pc.id
  where pc.patient_id=p_patient_id and pc.active
    and pc.relationship_effective_start<=current_date
    and (pc.relationship_effective_end is null or pc.relationship_effective_end>=current_date)
  group by pc.id,pc.relationship,pc.is_primary,pc.authorized_to_receive_information,
    pc.preferred_language,pc.timezone
  order by pc.is_primary desc,pc.id;
end
$contact_summary$;
revoke all on function communication_contact_summary(uuid) from public;
grant execute on function communication_contact_summary(uuid) to authenticated;

-- Operations sees counts only: no patient/contact/job IDs, content, or address.
create or replace function communication_delivery_overview(p_since timestamptz)
returns table(channel communication_channel,status communication_job_status,job_count bigint)
language plpgsql stable security definer set search_path=public,pg_catalog as $delivery_overview$
begin
  if auth.uid() is null or current_app_role() is null
    or current_app_role() not in ('SCHEDULER','OPERATIONS','COMPLIANCE') then
    raise exception 'Communication delivery overview is not available';
  end if;
  if p_since is null or p_since<now()-interval '90 days' or p_since>now() then
    raise exception 'Overview start must be within the last 90 days';
  end if;
  return query select j.channel,j.status,count(*)
    from communication_jobs j where j.created_at>=p_since
    group by j.channel,j.status order by j.channel,j.status;
end
$delivery_overview$;
revoke all on function communication_delivery_overview(timestamptz) from public;
grant execute on function communication_delivery_overview(timestamptz) to authenticated;

create or replace function respond_recovery_offer_with_contact(
  p_offer_id uuid,p_expected_version int,p_decision text,p_reason text,
  p_contact_id uuid,p_response_channel communication_response_channel,
  p_communication_job_id uuid,p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog,extensions as $respond_with_contact$
declare
  v_actor uuid:=auth.uid();
  v_offer recovery_offers%rowtype;
  v_case recovery_cases%rowtype;
  v_contact patient_contacts%rowtype;
  v_job communication_jobs%rowtype;
  v_payload jsonb;
  v_hash text;
  v_existing communication_idempotency%rowtype;
  v_result jsonb;
begin
  if v_actor is null or current_app_role() is null
    or current_app_role() not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to respond to recovery offers';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then raise exception 'A valid idempotency key is required'; end if;
  v_payload:=jsonb_build_object('offer_id',p_offer_id,'expected_version',p_expected_version,
    'decision',upper(trim(coalesce(p_decision,''))),'reason',trim(coalesce(p_reason,'')),
    'contact_id',p_contact_id,'response_channel',p_response_channel,'job_id',p_communication_job_id);
  v_hash:=md5(v_payload::text);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':RESPOND_RECOVERY_WITH_CONTACT:'||trim(p_idempotency_key),0));
  select * into v_existing from communication_idempotency
  where actor_key=v_actor::text and operation='RESPOND_RECOVERY_WITH_CONTACT'
    and idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'Idempotency key payload does not match'; end if;
    return v_existing.result||jsonb_build_object('already_applied',true);
  end if;
  select * into v_offer from recovery_offers where id=p_offer_id;
  if not found then raise exception 'Recovery offer was not found'; end if;
  select * into v_case from recovery_cases where id=v_offer.recovery_case_id;
  if not can_access_patient(v_case.patient_id) then raise exception 'Patient is outside your permitted caseload'; end if;
  -- The underlying responder establishes the canonical recovery lock order
  -- (disruption -> original appointment -> case -> offer). Any provenance
  -- validation failure below raises and rolls that response back atomically.
  v_result:=respond_recovery_offer(p_offer_id,p_expected_version,p_decision,p_reason,p_idempotency_key);
  if v_result->>'status' in ('ACCEPTED','DECLINED') then
    perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_CONTACT:'||p_contact_id::text,0));
    if p_response_channel in ('SMS','EMAIL','PUSH') then
      if p_communication_job_id is null then raise exception 'Digital responses require their delivered communication job'; end if;
      -- Delivery preparation also locks job before contact. Keep that order to
      -- prevent a response/worker deadlock.
      select * into v_job from communication_jobs where id=p_communication_job_id for update;
      if not found then raise exception 'Delivered recovery communication does not match this response'; end if;
    elsif p_communication_job_id is not null then
      raise exception 'Manual responses must not reference a digital delivery job';
    end if;
    select * into v_contact from patient_contacts where id=p_contact_id for update;
    if not found or v_contact.patient_id<>v_case.patient_id or not v_contact.active
      or v_contact.relationship_verified_at is null
      or v_contact.relationship_effective_start>current_date
      or (v_contact.relationship_effective_end is not null and v_contact.relationship_effective_end<current_date)
      or not v_contact.authorized_to_receive_information then
      raise exception 'Response contact is not an active authorized recipient';
    end if;
    if p_response_channel in ('SMS','EMAIL','PUSH') then
      if v_job.status<>'DELIVERED' or v_job.message_type<>'RECOVERY_OFFER'
        or v_job.recovery_offer_id<>v_offer.id or v_job.recovery_case_id<>v_case.id
        or v_job.patient_contact_id<>v_contact.id or v_job.channel::text<>p_response_channel::text then
        raise exception 'Delivered recovery communication does not match this response';
      end if;
    end if;
    if p_response_channel='MANUAL_PHONE' and v_contact.phone is null then
      raise exception 'Manual phone responses require a recorded phone destination';
    end if;
    update recovery_offers set response_contact_id=v_contact.id,response_channel=p_response_channel,
      communication_job_id=p_communication_job_id where id=v_offer.id;
    update communication_jobs set
      status=case when status='PROCESSING' then status else 'CANCELLED' end,
      cancelled_at=now(),cancelled_by=v_actor,cancellation_reason='Recovery offer was answered',
      processing_token=case when status='PROCESSING' then processing_token else null end,
      processing_worker=case when status='PROCESSING' then processing_worker else null end,
      processing_started_at=case when status='PROCESSING' then processing_started_at else null end,
      version=version+1
    where recovery_case_id=v_case.id and id is distinct from p_communication_job_id
      and status in ('QUEUED','PROCESSING','FAILED');
    insert into audit_log(user_id,action,patient_id,appointment_id,new_values)
    values(v_actor,'RECOVERY_RESPONSE_PROVENANCE_RECORDED',v_case.patient_id,v_case.original_appointment_id,
      jsonb_build_object('offer_id',v_offer.id,'contact_id',v_contact.id,
        'response_channel',p_response_channel,'communication_job_id',p_communication_job_id));
  end if;
  v_result:=v_result||jsonb_build_object('response_contact_id',p_contact_id,
    'response_channel',p_response_channel,'communication_job_id',p_communication_job_id);
  insert into communication_idempotency(actor_key,operation,idempotency_key,request_hash,result)
  values(v_actor::text,'RESPOND_RECOVERY_WITH_CONTACT',trim(p_idempotency_key),v_hash,v_result);
  return v_result;
end
$respond_with_contact$;
revoke all on function respond_recovery_offer(uuid,int,text,text,text) from authenticated;
revoke all on function respond_recovery_offer_with_contact(uuid,int,text,text,uuid,communication_response_channel,uuid,text) from public;
grant execute on function respond_recovery_offer_with_contact(uuid,int,text,text,uuid,communication_response_channel,uuid,text) to authenticated;

create or replace function app_schema_status()
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $status$
  select jsonb_build_object(
    'ready',true,'version','20261011031100',
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
      and to_regprocedure('public.prepare_communication_delivery(uuid,uuid)') is not null
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
