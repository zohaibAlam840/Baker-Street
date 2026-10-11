begin;

-- A provider/supervisor may be linked to a staff record. Other roles must not.
alter table user_profiles drop constraint if exists provider_role_link;
alter table user_profiles add constraint provider_role_link
  check (role in ('PROVIDER', 'CLINICAL') or provider_id is null);
create unique index user_profiles_provider_unique
  on user_profiles(provider_id) where provider_id is not null and active;

create type care_team_role as enum (
  'PRIMARY_CLINICIAN', 'SUPERVISOR', 'TREATING_PROVIDER', 'CARE_COORDINATOR'
);

create table patient_care_team (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  provider_id uuid not null references providers(id) on delete cascade,
  relationship care_team_role not null,
  effective_start date not null default current_date,
  effective_end date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique (patient_id, provider_id, relationship, effective_start),
  check (effective_end is null or effective_end >= effective_start)
);
create index patient_care_team_patient_idx on patient_care_team(patient_id) where active;
create index patient_care_team_provider_idx on patient_care_team(provider_id) where active;
alter table patient_care_team enable row level security;

-- Security-definer helpers prevent policy recursion and keep every table's
-- policies readable. They expose booleans/IDs only, never clinical rows.
create or replace function is_active_user()
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists(select 1 from user_profiles where user_id = auth.uid() and active)
$fn$;

create or replace function has_app_role(allowed app_role[])
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists(
    select 1 from user_profiles
    where user_id = auth.uid() and active and role = any(allowed)
  )
$fn$;

create or replace function is_on_patient_team(target_patient uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists(
    select 1 from patient_care_team pct
    join user_profiles up on up.provider_id = pct.provider_id
    where up.user_id = auth.uid() and up.active and pct.patient_id = target_patient
      and pct.active and pct.effective_start <= current_date
      and (pct.effective_end is null or pct.effective_end >= current_date)
  )
$fn$;

create or replace function can_access_patient(target_patient uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select has_app_role(array['SCHEDULER','AUTHORIZATION','OPERATIONS']::app_role[])
      or (has_app_role(array['CLINICAL','PROVIDER']::app_role[]) and is_on_patient_team(target_patient))
$fn$;

create or replace function can_access_provider(target_provider uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select has_app_role(array['SCHEDULER','CLINICAL','OPERATIONS','ADMIN']::app_role[])
      or current_provider_id() = target_provider
$fn$;

revoke all on function is_active_user() from public;
revoke all on function has_app_role(app_role[]) from public;
revoke all on function is_on_patient_team(uuid) from public;
revoke all on function can_access_patient(uuid) from public;
revoke all on function can_access_provider(uuid) from public;
grant execute on function is_active_user(), has_app_role(app_role[]), is_on_patient_team(uuid), can_access_patient(uuid), can_access_provider(uuid) to authenticated;

-- Shared, non-PHI configuration.
do $do$
declare t text;
begin
  foreach t in array array['locations','services','service_durations','service_requirements','resources','service_resources'] loop
    execute format('create policy "active staff read %1$s" on %1$I for select to authenticated using (is_active_user())', t);
    execute format('create policy "admins insert %1$s" on %1$I for insert to authenticated with check (has_app_role(array[''ADMIN'']::app_role[]))', t);
    execute format('create policy "admins update %1$s" on %1$I for update to authenticated using (has_app_role(array[''ADMIN'']::app_role[])) with check (has_app_role(array[''ADMIN'']::app_role[]))', t);
    execute format('create policy "admins delete %1$s" on %1$I for delete to authenticated using (has_app_role(array[''ADMIN'']::app_role[]))', t);
  end loop;
end $do$;

-- Patient identity and patient-owned records.
create policy "scoped patient read" on patients for select to authenticated using (can_access_patient(id));
create policy "scheduling staff insert patients" on patients for insert to authenticated with check (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]));
create policy "scheduling staff update patients" on patients for update to authenticated using (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) and can_access_patient(id)) with check (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) and can_access_patient(id));

do $do$
declare t text;
begin
  foreach t in array array['patient_availability','patient_preferences','patient_restrictions'] loop
    execute format('create policy "scoped read %1$s" on %1$I for select to authenticated using (can_access_patient(patient_id))', t);
    execute format('create policy "schedulers manage %1$s" on %1$I for all to authenticated using (has_app_role(array[''SCHEDULER'',''CLINICAL'']::app_role[]) and can_access_patient(patient_id)) with check (has_app_role(array[''SCHEDULER'',''CLINICAL'']::app_role[]) and can_access_patient(patient_id))', t);
  end loop;
end $do$;

create policy "scoped requirements read" on patient_service_requirements for select to authenticated using (can_access_patient(patient_id));
create policy "clinical manage requirements" on patient_service_requirements for all to authenticated using (has_app_role(array['CLINICAL']::app_role[]) and can_access_patient(patient_id)) with check (has_app_role(array['CLINICAL']::app_role[]) and can_access_patient(patient_id));

create policy "scoped authorization read" on authorizations for select to authenticated using (can_access_patient(patient_id));
create policy "authorization staff manage" on authorizations for all to authenticated using (has_app_role(array['AUTHORIZATION']::app_role[])) with check (has_app_role(array['AUTHORIZATION']::app_role[]));

-- Provider identity and provider-owned records.
create policy "scoped provider read" on providers for select to authenticated using (can_access_provider(id));
create policy "clinical admin insert providers" on providers for insert to authenticated with check (has_app_role(array['CLINICAL','ADMIN']::app_role[]));
create policy "clinical admin update providers" on providers for update to authenticated using (has_app_role(array['CLINICAL','ADMIN']::app_role[])) with check (has_app_role(array['CLINICAL','ADMIN']::app_role[]));

do $do$
declare t text;
begin
  foreach t in array array['provider_credentials','provider_services'] loop
    execute format('create policy "scoped read %1$s" on %1$I for select to authenticated using (can_access_provider(provider_id))', t);
    execute format('create policy "clinical admin manage %1$s" on %1$I for all to authenticated using (has_app_role(array[''CLINICAL'',''ADMIN'']::app_role[])) with check (has_app_role(array[''CLINICAL'',''ADMIN'']::app_role[]))', t);
  end loop;
end $do$;

create policy "scoped availability read" on provider_availability for select to authenticated using (can_access_provider(provider_id));
create policy "availability managers write" on provider_availability for all to authenticated using (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) or current_provider_id() = provider_id) with check (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) or current_provider_id() = provider_id);

-- Explicit care-team links define caseload scope.
create policy "team members read links" on patient_care_team for select to authenticated using (can_access_patient(patient_id) or can_access_provider(provider_id));
create policy "clinical scheduler manage teams" on patient_care_team for all to authenticated using (has_app_role(array['SCHEDULER','CLINICAL']::app_role[])) with check (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]));

-- Scheduling records. Resource links inherit visibility from their appointment.
create policy "scoped appointment read" on appointments for select to authenticated using (can_access_patient(patient_id));
create policy "schedulers insert appointments" on appointments for insert to authenticated with check (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) and can_access_patient(patient_id));
create policy "schedulers update appointments" on appointments for update to authenticated using (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) and can_access_patient(patient_id)) with check (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) and can_access_patient(patient_id));
create policy "schedulers delete appointments" on appointments for delete to authenticated using (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) and can_access_patient(patient_id));

create policy "appointment resource read" on appointment_resources for select to authenticated using (exists(select 1 from appointments a where a.id = appointment_id and can_access_patient(a.patient_id)));
create policy "appointment resource write" on appointment_resources for all to authenticated using (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) and exists(select 1 from appointments a where a.id = appointment_id and can_access_patient(a.patient_id))) with check (has_app_role(array['SCHEDULER','CLINICAL']::app_role[]) and exists(select 1 from appointments a where a.id = appointment_id and can_access_patient(a.patient_id)));

-- Optimization data follows its patient. Organization-level requests are
-- restricted to operations; patient-less rows never become a visibility leak.
create policy "optimization request read" on optimization_requests for select to authenticated using ((patient_id is not null and can_access_patient(patient_id)) or (patient_id is null and has_app_role(array['OPERATIONS']::app_role[])));
create policy "optimizer create requests" on optimization_requests for insert to authenticated with check (has_app_role(array['SCHEDULER','CLINICAL','OPERATIONS']::app_role[]) and ((patient_id is not null and can_access_patient(patient_id)) or (patient_id is null and has_app_role(array['OPERATIONS']::app_role[]))));
create policy "optimization results read" on optimization_results for select to authenticated using (exists(select 1 from optimization_requests r where r.id = optimization_request_id));
create policy "optimization changes read" on optimization_changes for select to authenticated using (exists(select 1 from optimization_results rs join optimization_requests rq on rq.id = rs.optimization_request_id where rs.id = optimization_result_id));

-- Audit is oversight-only. Writes will come from security-definer scheduling
-- transactions so users cannot manufacture or alter their own history.
create policy "oversight reads audit" on audit_log for select to authenticated using (has_app_role(array['CLINICAL','OPERATIONS','ADMIN','COMPLIANCE']::app_role[]));

commit;
