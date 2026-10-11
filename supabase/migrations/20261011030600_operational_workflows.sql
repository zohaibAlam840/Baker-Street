begin;

create extension if not exists btree_gist with schema extensions;

alter table appointments add column if not exists notes text;
alter table appointments add column if not exists cancellation_reason text;
alter table appointments add column if not exists recurrence_group_id uuid;
alter table appointments add column if not exists created_by uuid references auth.users(id) on delete set null;

-- Database-level collision protection handles concurrent mobile submissions.
alter table appointments drop constraint if exists appointments_patient_no_overlap;
alter table appointments add constraint appointments_patient_no_overlap exclude using gist (
  patient_id with =, tstzrange(start_time, end_time, '[)') with &&
) where (status in ('SCHEDULED','CONFIRMED','COMPLETED'));
alter table appointments drop constraint if exists appointments_provider_no_overlap;
alter table appointments add constraint appointments_provider_no_overlap exclude using gist (
  provider_id with =, tstzrange(start_time, end_time, '[)') with &&
) where (provider_id is not null and status in ('SCHEDULED','CONFIRMED','COMPLETED'));

create table patient_contacts (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  name text not null,
  relationship text not null,
  phone text,
  email text,
  is_primary boolean not null default false,
  authorized_to_receive_information boolean not null default false,
  created_at timestamptz not null default now()
);

create table intake_tasks (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  task_key text not null,
  label text not null,
  completed boolean not null default false,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  unique(patient_id, task_key)
);

create table provider_supervision (
  id uuid primary key default gen_random_uuid(),
  supervisor_id uuid not null references providers(id) on delete cascade,
  supervisee_id uuid not null references providers(id) on delete cascade,
  effective_start date not null default current_date,
  effective_end date,
  active boolean not null default true,
  check (supervisor_id <> supervisee_id),
  check (effective_end is null or effective_end >= effective_start)
);
create unique index provider_supervision_active_unique on provider_supervision(supervisor_id, supervisee_id) where active;

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  role app_role,
  kind text not null,
  title text not null,
  body text,
  href text,
  severity text not null default 'INFO' check (severity in ('INFO','WARNING','CRITICAL')),
  read_at timestamptz,
  dedupe_key text,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create unique index notifications_user_dedupe_idx on notifications(user_id,dedupe_key) where user_id is not null and dedupe_key is not null;
create unique index notifications_role_dedupe_idx on notifications(role,dedupe_key) where role is not null and dedupe_key is not null;

create or replace function validate_appointment_integrity() returns trigger
language plpgsql security definer set search_path=public as $fn$
declare linked authorizations%rowtype;
begin
  if new.start_time >= new.end_time then raise exception 'Appointment end must be after start'; end if;
  if new.authorization_id is not null then
    select * into linked from authorizations where id = new.authorization_id;
    if not found or linked.patient_id <> new.patient_id or linked.service_id <> new.service_id then
      raise exception 'Authorization does not match patient and service';
    end if;
    if new.start_time::date < linked.start_date or new.start_time::date > linked.end_date or linked.status <> 'ACTIVE' then
      raise exception 'Authorization is not active on the appointment date';
    end if;
  end if;
  if new.telehealth and not exists(select 1 from services where id=new.service_id and telehealth_allowed) then
    raise exception 'Selected service does not allow telehealth';
  end if;
  if not new.telehealth and not exists(select 1 from services where id=new.service_id and in_person_allowed) then
    raise exception 'Selected service does not allow in-person delivery';
  end if;
  return new;
end $fn$;
drop trigger if exists validate_appointment_integrity_trigger on appointments;
create trigger validate_appointment_integrity_trigger before insert or update on appointments
for each row execute function validate_appointment_integrity();

alter table patient_contacts enable row level security;
alter table intake_tasks enable row level security;
alter table provider_supervision enable row level security;
alter table notifications enable row level security;

create policy "scoped contacts read" on patient_contacts for select to authenticated using (can_access_patient(patient_id));
create policy "scheduler contacts manage" on patient_contacts for all to authenticated using (has_app_role(array['SCHEDULER']::app_role[]) and can_access_patient(patient_id)) with check (has_app_role(array['SCHEDULER']::app_role[]) and can_access_patient(patient_id));
create policy "scoped intake read" on intake_tasks for select to authenticated using (can_access_patient(patient_id));
create policy "scheduler clinical intake manage" on intake_tasks for all to authenticated using (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) and can_access_patient(patient_id)) with check (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) and can_access_patient(patient_id));
create policy "provider supervision read" on provider_supervision for select to authenticated using (can_access_provider(supervisor_id) or can_access_provider(supervisee_id));
create policy "clinical admin supervision manage" on provider_supervision for all to authenticated using (has_app_role(array['CLINICAL','ADMIN']::app_role[])) with check (has_app_role(array['CLINICAL','ADMIN']::app_role[]));
create policy "own and role notifications read" on notifications for select to authenticated using (user_id=auth.uid() or role=current_app_role());
create policy "own notifications update" on notifications for update to authenticated using (user_id=auth.uid() or role=current_app_role()) with check (user_id=auth.uid() or role=current_app_role());
create policy "system notifications insert" on notifications for insert to authenticated with check (has_app_role(array['SCHEDULER','CLINICAL','AUTHORIZATION','OPERATIONS','ADMIN']::app_role[]));

create or replace function initialize_patient_intake() returns trigger
language plpgsql security definer set search_path=public as $fn$
begin
  insert into intake_tasks(patient_id,task_key,label) values
    (new.id,'demographics','Demographics reviewed'),
    (new.id,'contact','Primary contact recorded'),
    (new.id,'availability','Availability recorded'),
    (new.id,'clinical','Clinical requirements signed'),
    (new.id,'authorization','Authorization recorded'),
    (new.id,'care_team','Care team assigned');
  return new;
end $fn$;
drop trigger if exists initialize_patient_intake_trigger on patients;
create trigger initialize_patient_intake_trigger after insert on patients
for each row execute function initialize_patient_intake();

-- Appointment writes retain the actor in the row and all meaningful changes
-- are copied into the immutable audit stream.
create or replace function audit_appointment_change() returns trigger
language plpgsql security definer set search_path=public as $fn$
begin
  if tg_op='INSERT' then
    insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
    values(auth.uid(),'APPOINTMENT_CREATED',new.patient_id,new.id,to_jsonb(new),new.notes);
    return new;
  elsif tg_op='UPDATE' then
    insert into audit_log(user_id,action,patient_id,appointment_id,old_values,new_values,override_reason)
    values(auth.uid(),case when new.status='CANCELLED' and old.status<>'CANCELLED' then 'APPOINTMENT_CANCELLED' when old.status='CANCELLED' and new.status<>'CANCELLED' then 'APPOINTMENT_RESTORED' else 'APPOINTMENT_UPDATED' end,new.patient_id,new.id,to_jsonb(old),to_jsonb(new),coalesce(new.cancellation_reason,new.notes));
    return new;
  end if;
  return old;
end $fn$;
drop trigger if exists audit_appointment_change_trigger on appointments;
create trigger audit_appointment_change_trigger after insert or update on appointments for each row execute function audit_appointment_change();

create or replace function audit_domain_change() returns trigger
language plpgsql security definer set search_path=public as $fn$
declare before_row jsonb; after_row jsonb; target_patient uuid; row_id uuid;
begin
  before_row := case when tg_op='INSERT' then null else to_jsonb(old) end;
  after_row := case when tg_op='DELETE' then null else to_jsonb(new) end;
  target_patient := nullif(coalesce(after_row->>'patient_id',before_row->>'patient_id'),'')::uuid;
  row_id := nullif(coalesce(after_row->>'id',before_row->>'id'),'')::uuid;
  insert into audit_log(user_id,action,patient_id,old_values,new_values)
  values(auth.uid(),upper(tg_table_name)||'_'||tg_op,target_patient,before_row,after_row);
  return case when tg_op='DELETE' then old else new end;
end $fn$;
do $do$ declare table_name text; begin
  foreach table_name in array array['patients','patient_service_requirements','authorizations','providers','provider_credentials','patient_contacts','intake_tasks','provider_supervision'] loop
    execute format('drop trigger if exists %I_audit_trigger on %I',table_name,table_name);
    execute format('create trigger %I_audit_trigger after insert or update or delete on %I for each row execute function audit_domain_change()',table_name,table_name);
  end loop;
end $do$;

commit;
