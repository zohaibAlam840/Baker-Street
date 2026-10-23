begin;

-- Aggregate operational signals only. This table intentionally has no actor,
-- patient, provider, request URL, free text, or metadata columns so it cannot
-- become a shadow PHI log.
create table operational_events (
  id bigint generated always as identity primary key,
  category text not null check (category in (
    'AUTH_SIGN_IN_FAILED',
    'OPTIMIZER_BOUNDED',
    'PUSH_DELIVERY_FAILED'
  )),
  release text not null check (length(release) between 1 and 100),
  occurred_at timestamptz not null default now()
);
create index operational_events_category_time_idx
  on operational_events(category, occurred_at desc);

alter table operational_events enable row level security;
revoke all on operational_events from public, anon, authenticated;
grant select, insert, delete on operational_events to service_role;
grant usage, select on sequence operational_events_id_seq to service_role;

alter function app_schema_status() rename to app_schema_status_20261022040000;
revoke all on function app_schema_status_20261022040000() from public, anon, authenticated;
create function app_schema_status()
returns jsonb
language sql stable security definer set search_path=public,pg_catalog as $status$
  select app_schema_status_20261022040000() || jsonb_build_object(
    'version', '20261023010000',
    'operational_monitoring',
      to_regclass('public.operational_events') is not null
      and not has_table_privilege('authenticated', 'public.operational_events', 'SELECT,INSERT,UPDATE,DELETE')
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon, authenticated;

commit;
