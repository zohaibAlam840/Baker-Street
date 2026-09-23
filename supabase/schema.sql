-- =============================================================================
-- Baker Street Multi-Service Scheduling & Optimization Engine
-- Phase 1 schema. Spec: "Dynamic Scheduler for BSH-1.docx" v2.0, sections 9-26.
--
-- Paste into the Supabase SQL editor and run. Safe to re-run: it drops first.
--
-- Design rule (spec section 3): no table encodes ABA. ABA is a row in
-- `services` carrying an optimization_profile, nothing more.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Reset
-- ---------------------------------------------------------------------------
drop table if exists audit_log cascade;
drop table if exists optimization_changes cascade;
drop table if exists optimization_results cascade;
drop table if exists optimization_requests cascade;
drop table if exists appointment_resources cascade;
drop table if exists appointments cascade;
drop table if exists service_resources cascade;
drop table if exists resources cascade;
drop table if exists patient_restrictions cascade;
drop table if exists patient_preferences cascade;
drop table if exists patient_availability cascade;
drop table if exists provider_availability cascade;
drop table if exists provider_services cascade;
drop table if exists provider_credentials cascade;
drop table if exists providers cascade;
drop table if exists authorizations cascade;
drop table if exists patient_service_requirements cascade;
drop table if exists service_requirements cascade;
drop table if exists service_durations cascade;
drop table if exists services cascade;
drop table if exists patients cascade;
drop table if exists locations cascade;

drop type if exists patient_status cascade;
drop type if exists provider_type cascade;
drop type if exists provider_status cascade;
drop type if exists credential_status cascade;
drop type if exists provider_availability_type cascade;
drop type if exists patient_availability_type cascade;
drop type if exists restriction_type cascade;
drop type if exists location_type cascade;
drop type if exists authorization_status cascade;
drop type if exists requirement_type cascade;
drop type if exists appointment_status cascade;
drop type if exists scheduling_flexibility cascade;
drop type if exists optimization_mode cascade;
drop type if exists optimization_status cascade;
drop type if exists solver_status cascade;
drop type if exists change_action cascade;

-- ---------------------------------------------------------------------------
-- Enumerations (vocabularies fixed by the spec)
-- ---------------------------------------------------------------------------
create type patient_status as enum ('ACTIVE', 'INACTIVE', 'PENDING', 'DISCHARGED');

-- Spec section 11.
create type provider_type as enum (
  'RBT', 'BCBA', 'PSYCHOLOGIST', 'NEUROPSYCHOLOGIST', 'LMHC', 'LCSW', 'LPC',
  'OT', 'PT', 'SLP', 'PODIATRIST', 'MD', 'DO', 'TECHNICIAN', 'OTHER'
);
create type provider_status as enum ('ACTIVE', 'INACTIVE', 'ON_LEAVE');
create type credential_status as enum ('ACTIVE', 'EXPIRED', 'SUSPENDED', 'PENDING');

-- Spec section 14.
create type provider_availability_type as enum (
  'CLINICAL', 'ADMINISTRATIVE', 'PREFERRED', 'HARD_UNAVAILABLE', 'PTO'
);

-- Spec section 15.
create type patient_availability_type as enum ('AVAILABLE', 'PREFERRED', 'HARD_UNAVAILABLE');

-- Spec section 17.
create type restriction_type as enum ('SCHOOL', 'WORK', 'OTHER_APPOINTMENT', 'HARD_UNAVAILABLE');

-- Spec section 18.
create type location_type as enum ('CLINIC', 'HOME', 'SCHOOL', 'COMMUNITY', 'TELEHEALTH');

create type authorization_status as enum ('ACTIVE', 'EXPIRED', 'EXHAUSTED', 'PENDING', 'DENIED');

-- Spec section 9, service_requirements.
create type requirement_type as enum (
  'MIN_WEEKLY_HOURS', 'MAX_WEEKLY_HOURS',
  'MIN_WEEKLY_SESSIONS', 'MAX_WEEKLY_SESSIONS',
  'REQUIRED_SESSION_COUNT', 'TARGET_HOURS'
);

create type appointment_status as enum (
  'SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'PROPOSED'
);

-- Spec section 21. LOCKED cannot move. PROTECTED may move at heavy penalty.
create type scheduling_flexibility as enum ('LOCKED', 'PROTECTED', 'FLEXIBLE');

-- Spec section 23.
create type optimization_mode as enum (
  'CHECK_CONFLICT', 'OPTIMIZE_PATIENT', 'OPTIMIZE_PROVIDER', 'FILL_SERVICE',
  'ORGANIZATION_OPTIMIZATION', 'WHAT_IF', 'CAPACITY_ANALYSIS'
);
create type optimization_status as enum ('QUEUED', 'RUNNING', 'COMPLETE', 'FAILED', 'CANCELLED');

-- Spec section 66.
create type solver_status as enum ('OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'TIME_LIMIT', 'ERROR');

-- Spec section 25.
create type change_action as enum ('ADD', 'MOVE', 'REMOVE', 'CHANGE_PROVIDER', 'CHANGE_LOCATION');

-- ---------------------------------------------------------------------------
-- 18. Locations
-- ---------------------------------------------------------------------------
create table locations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        location_type not null,
  address     text,
  city        text,
  state       text,
  postal_code text,
  timezone    text not null default 'America/New_York',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 9. Patients
-- ---------------------------------------------------------------------------
create table patients (
  id                  uuid primary key default gen_random_uuid(),
  external_id         text unique,
  first_name          text not null,
  last_name           text not null,
  date_of_birth       date,
  status              patient_status not null default 'ACTIVE',
  timezone            text not null default 'America/New_York',
  primary_location_id uuid references locations(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index patients_status_idx on patients(status);

-- ---------------------------------------------------------------------------
-- 9. Services -- the configuration table that keeps the engine generic
-- ---------------------------------------------------------------------------
create table services (
  id                       uuid primary key default gen_random_uuid(),
  service_code             text not null unique,
  service_name             text not null,
  department               text not null,
  active                   boolean not null default true,
  default_duration_minutes int not null,
  min_duration_minutes     int not null,
  max_duration_minutes     int not null,
  telehealth_allowed       boolean not null default false,
  in_person_allowed        boolean not null default true,
  group_allowed            boolean not null default false,
  requires_authorization   boolean not null default false,
  -- Spec sections 5 and 42: objective and weights are config, never solver code.
  optimization_profile     jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint services_duration_order check (
    min_duration_minutes <= default_duration_minutes
    and default_duration_minutes <= max_duration_minutes
  ),
  -- Durations must land on the 15-minute slot grid (spec section 28).
  constraint services_duration_grid check (
    min_duration_minutes % 15 = 0
    and default_duration_minutes % 15 = 0
    and max_duration_minutes % 15 = 0
  )
);

-- ---------------------------------------------------------------------------
-- 9. Service durations (the discrete lengths a service may be booked at)
-- ---------------------------------------------------------------------------
create table service_durations (
  id               uuid primary key default gen_random_uuid(),
  service_id       uuid not null references services(id) on delete cascade,
  duration_minutes int not null,
  active           boolean not null default true,
  unique (service_id, duration_minutes),
  constraint service_durations_grid check (duration_minutes % 15 = 0)
);

-- ---------------------------------------------------------------------------
-- 9. Service requirements (defaults at the service level)
-- ---------------------------------------------------------------------------
create table service_requirements (
  id                 uuid primary key default gen_random_uuid(),
  service_id         uuid not null references services(id) on delete cascade,
  requirement_type   requirement_type not null,
  value              numeric not null,
  unit               text not null default 'hours',
  priority           int not null default 100,
  is_hard_constraint boolean not null default false,
  effective_start    date,
  effective_end      date
);
create index service_requirements_service_idx on service_requirements(service_id);

-- ---------------------------------------------------------------------------
-- 9. Patient service requirements
--
-- The spec is emphatic that authorization and clinical need are different
-- things. A patient may be authorized 30h while the clinical floor is 20h,
-- target 25h, ceiling 30h. The optimizer needs all four numbers, so all four
-- live here and the authorized figure lives only in `authorizations`.
-- ---------------------------------------------------------------------------
create table patient_service_requirements (
  id                        uuid primary key default gen_random_uuid(),
  patient_id                uuid not null references patients(id) on delete cascade,
  service_id                uuid not null references services(id) on delete cascade,
  minimum_hours_per_week    numeric,
  maximum_hours_per_week    numeric,
  minimum_sessions_per_week int,
  maximum_sessions_per_week int,
  target_hours_per_week     numeric,
  target_sessions_per_week  int,
  required                  boolean not null default false,
  priority                  int not null default 100,
  effective_start           date not null default current_date,
  effective_end             date,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint psr_hours_order check (
    minimum_hours_per_week is null
    or maximum_hours_per_week is null
    or minimum_hours_per_week <= maximum_hours_per_week
  ),
  constraint psr_sessions_order check (
    minimum_sessions_per_week is null
    or maximum_sessions_per_week is null
    or minimum_sessions_per_week <= maximum_sessions_per_week
  )
);
create index psr_patient_idx on patient_service_requirements(patient_id);
create index psr_service_idx on patient_service_requirements(service_id);

-- ---------------------------------------------------------------------------
-- 10. Authorizations
-- ---------------------------------------------------------------------------
create table authorizations (
  id                   uuid primary key default gen_random_uuid(),
  patient_id           uuid not null references patients(id) on delete cascade,
  service_id           uuid not null references services(id) on delete cascade,
  payer                text,
  authorization_number text,
  authorized_hours     numeric,
  authorized_units     numeric,
  units_per_hour       numeric not null default 4,
  start_date           date not null,
  end_date             date not null,
  status               authorization_status not null default 'ACTIVE',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint authorizations_period check (start_date <= end_date)
);
create index authorizations_patient_idx on authorizations(patient_id);
create index authorizations_lookup_idx on authorizations(patient_id, service_id, status);

-- ---------------------------------------------------------------------------
-- 11. Providers
-- ---------------------------------------------------------------------------
create table providers (
  id               uuid primary key default gen_random_uuid(),
  external_id      text unique,
  first_name       text not null,
  last_name        text not null,
  provider_type    provider_type not null,
  status           provider_status not null default 'ACTIVE',
  timezone         text not null default 'America/New_York',
  home_location_id uuid references locations(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index providers_type_idx on providers(provider_type, status);

-- ---------------------------------------------------------------------------
-- 12. Provider credentials
-- ---------------------------------------------------------------------------
create table provider_credentials (
  id                uuid primary key default gen_random_uuid(),
  provider_id       uuid not null references providers(id) on delete cascade,
  credential_type   text not null,
  credential_number text,
  state             text,
  issue_date        date,
  expiration_date   date,
  status            credential_status not null default 'ACTIVE'
);
create index provider_credentials_provider_idx on provider_credentials(provider_id);

-- ---------------------------------------------------------------------------
-- 13. Provider / service eligibility
-- ---------------------------------------------------------------------------
create table provider_services (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references providers(id) on delete cascade,
  service_id      uuid not null references services(id) on delete cascade,
  eligible        boolean not null default true,
  effective_start date,
  effective_end   date,
  unique (provider_id, service_id)
);
create index provider_services_service_idx on provider_services(service_id) where eligible;

-- ---------------------------------------------------------------------------
-- 14. Provider availability
-- ---------------------------------------------------------------------------
create table provider_availability (
  id                uuid primary key default gen_random_uuid(),
  provider_id       uuid not null references providers(id) on delete cascade,
  day_of_week       int not null check (day_of_week between 0 and 6), -- 0 = Sunday
  start_time        time not null,
  end_time          time not null,
  availability_type provider_availability_type not null default 'CLINICAL',
  location_id       uuid references locations(id) on delete set null,
  effective_start   date,
  effective_end     date,
  constraint provider_availability_order check (start_time < end_time)
);
create index provider_availability_provider_idx on provider_availability(provider_id, day_of_week);

-- ---------------------------------------------------------------------------
-- 15. Patient availability
-- ---------------------------------------------------------------------------
create table patient_availability (
  id                uuid primary key default gen_random_uuid(),
  patient_id        uuid not null references patients(id) on delete cascade,
  day_of_week       int not null check (day_of_week between 0 and 6),
  start_time        time not null,
  end_time          time not null,
  availability_type patient_availability_type not null default 'AVAILABLE',
  effective_start   date,
  effective_end     date,
  constraint patient_availability_order check (start_time < end_time)
);
create index patient_availability_patient_idx on patient_availability(patient_id, day_of_week);

-- ---------------------------------------------------------------------------
-- 16. Patient preferences (soft unless explicitly designated otherwise)
-- ---------------------------------------------------------------------------
create table patient_preferences (
  id                    uuid primary key default gen_random_uuid(),
  patient_id            uuid not null references patients(id) on delete cascade,
  preferred_service_id  uuid references services(id) on delete cascade,
  preferred_day         int check (preferred_day between 0 and 6),
  preferred_start_time  time,
  preferred_end_time    time,
  preferred_provider_id uuid references providers(id) on delete set null,
  preferred_location_id uuid references locations(id) on delete set null,
  priority              int not null default 100,
  is_hard_constraint    boolean not null default false
);
create index patient_preferences_patient_idx on patient_preferences(patient_id);

-- ---------------------------------------------------------------------------
-- 17. Patient restrictions (school / work / other)
-- ---------------------------------------------------------------------------
create table patient_restrictions (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references patients(id) on delete cascade,
  restriction_type restriction_type not null,
  day_of_week      int not null check (day_of_week between 0 and 6),
  start_time       time not null,
  end_time         time not null,
  -- null = no service may be scheduled in this window; set = only this one may.
  service_allowed  uuid references services(id) on delete set null,
  effective_start  date,
  effective_end    date,
  constraint patient_restrictions_order check (start_time < end_time)
);
create index patient_restrictions_patient_idx on patient_restrictions(patient_id, day_of_week);

-- ---------------------------------------------------------------------------
-- 19. Resources
-- ---------------------------------------------------------------------------
create table resources (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  resource_type text not null,
  location_id   uuid references locations(id) on delete cascade,
  capacity      int not null default 1 check (capacity >= 1),
  active        boolean not null default true
);
create index resources_location_idx on resources(location_id);

-- ---------------------------------------------------------------------------
-- 20. Service resources
-- ---------------------------------------------------------------------------
create table service_resources (
  id          uuid primary key default gen_random_uuid(),
  service_id  uuid not null references services(id) on delete cascade,
  resource_id uuid not null references resources(id) on delete cascade,
  required    boolean not null default true,
  unique (service_id, resource_id)
);

-- ---------------------------------------------------------------------------
-- 21. Appointments
-- ---------------------------------------------------------------------------
create table appointments (
  id                     uuid primary key default gen_random_uuid(),
  patient_id             uuid not null references patients(id) on delete cascade,
  service_id             uuid not null references services(id) on delete restrict,
  provider_id            uuid references providers(id) on delete set null,
  authorization_id       uuid references authorizations(id) on delete set null,
  location_id            uuid references locations(id) on delete set null,
  start_time             timestamptz not null,
  end_time               timestamptz not null,
  status                 appointment_status not null default 'SCHEDULED',
  scheduling_flexibility scheduling_flexibility not null default 'FLEXIBLE',
  telehealth             boolean not null default false,
  -- Kept so the UI can render a before/after diff after an optimization run.
  original_start_time    timestamptz,
  original_provider_id   uuid references providers(id) on delete set null,
  original_location_id   uuid references locations(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint appointments_period check (start_time < end_time)
);
create index appointments_patient_window_idx on appointments(patient_id, start_time, end_time);
create index appointments_provider_window_idx on appointments(provider_id, start_time, end_time);
create index appointments_service_idx on appointments(service_id);
create index appointments_auth_idx on appointments(authorization_id);

-- ---------------------------------------------------------------------------
-- 22. Appointment resources
-- ---------------------------------------------------------------------------
create table appointment_resources (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  resource_id    uuid not null references resources(id) on delete cascade,
  unique (appointment_id, resource_id)
);
create index appointment_resources_resource_idx on appointment_resources(resource_id);

-- ---------------------------------------------------------------------------
-- 23. Optimization requests
-- ---------------------------------------------------------------------------
create table optimization_requests (
  id                     uuid primary key default gen_random_uuid(),
  requested_by           uuid,
  mode                   optimization_mode not null,
  patient_id             uuid references patients(id) on delete cascade,
  date_start             date not null,
  date_end               date not null,
  objective              text,
  target_service_id      uuid references services(id) on delete set null,
  target_hours           numeric,
  allow_moves            boolean not null default true,
  allow_provider_changes boolean not null default true,
  allow_location_changes boolean not null default false,
  max_solutions          int not null default 3,
  status                 optimization_status not null default 'QUEUED',
  solver_status          solver_status,
  runtime_ms             int,
  request_payload        jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  completed_at           timestamptz
);
create index optimization_requests_patient_idx on optimization_requests(patient_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 24. Optimization results
-- ---------------------------------------------------------------------------
create table optimization_results (
  id                          uuid primary key default gen_random_uuid(),
  optimization_request_id     uuid not null references optimization_requests(id) on delete cascade,
  rank                        int not null,
  objective_score             numeric,
  -- Per-service metrics live in JSON so adding a service never migrates this
  -- table (spec section 24).
  service_metrics_json        jsonb not null default '{}'::jsonb,
  aba_hours                   numeric,
  authorized_hours            numeric,
  unused_authorization        numeric,
  required_services_completed boolean,
  appointments_added          int not null default 0,
  appointments_moved          int not null default 0,
  appointments_removed        int not null default 0,
  provider_changes            int not null default 0,
  location_changes            int not null default 0,
  patient_gaps                int,
  provider_gaps               int,
  travel_minutes              int,
  created_at                  timestamptz not null default now(),
  unique (optimization_request_id, rank)
);

-- ---------------------------------------------------------------------------
-- 25. Optimization changes
-- ---------------------------------------------------------------------------
create table optimization_changes (
  id                     uuid primary key default gen_random_uuid(),
  optimization_result_id uuid not null references optimization_results(id) on delete cascade,
  appointment_id         uuid references appointments(id) on delete set null,
  action                 change_action not null,
  service_id             uuid references services(id) on delete set null,
  old_start              timestamptz,
  new_start              timestamptz,
  old_end                timestamptz,
  new_end                timestamptz,
  old_provider_id        uuid references providers(id) on delete set null,
  new_provider_id        uuid references providers(id) on delete set null,
  old_location_id        uuid references locations(id) on delete set null,
  new_location_id        uuid references locations(id) on delete set null
);
create index optimization_changes_result_idx on optimization_changes(optimization_result_id);

-- ---------------------------------------------------------------------------
-- 26. Audit log -- every optimizer-driven change must be auditable
-- ---------------------------------------------------------------------------
create table audit_log (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid,
  action                  text not null,
  patient_id              uuid references patients(id) on delete set null,
  appointment_id          uuid references appointments(id) on delete set null,
  optimization_request_id uuid references optimization_requests(id) on delete set null,
  old_values              jsonb,
  new_values              jsonb,
  override_reason         text,
  created_at              timestamptz not null default now()
);
create index audit_log_patient_idx on audit_log(patient_id, created_at desc);
create index audit_log_appointment_idx on audit_log(appointment_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$ language plpgsql;

do $do$
declare t text;
begin
  foreach t in array array[
    'locations', 'patients', 'services', 'patient_service_requirements',
    'authorizations', 'providers', 'appointments'
  ] loop
    execute format(
      'create trigger %I_set_updated_at before update on %I
       for each row execute function set_updated_at()', t, t
    );
  end loop;
end $do$;

commit;
