-- Authentication identity and application role assignments.
-- Domain-table RLS is enabled in a later migration together with real app
-- sessions, so the demo cannot accidentally appear authenticated.

begin;

create type app_role as enum (
  'SCHEDULER',
  'CLINICAL',
  'PROVIDER',
  'AUTHORIZATION',
  'OPERATIONS',
  'ADMIN',
  'COMPLIANCE'
);

create table user_profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  role          app_role not null,
  provider_id   uuid references providers(id) on delete set null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint provider_role_link check (role = 'PROVIDER' or provider_id is null)
);

create index user_profiles_role_idx on user_profiles(role) where active;
create trigger user_profiles_set_updated_at before update on user_profiles
for each row execute function set_updated_at();

alter table user_profiles enable row level security;

-- A user may read their own identity and role. Role administration is kept
-- out of direct client writes and will run through an audited server action.
create policy "users read own profile"
on user_profiles for select
to authenticated
using (user_id = auth.uid());

create or replace function current_app_role()
returns app_role
language sql
stable
security definer
set search_path = public
as $fn$
  select role
  from user_profiles
  where user_id = auth.uid() and active
$fn$;

create or replace function current_provider_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select provider_id
  from user_profiles
  where user_id = auth.uid() and active
$fn$;

revoke all on function current_app_role() from public;
revoke all on function current_provider_id() from public;
grant execute on function current_app_role() to authenticated;
grant execute on function current_provider_id() to authenticated;

commit;
