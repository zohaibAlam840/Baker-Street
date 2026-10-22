begin;

-- Providers and linked clinical users may still report an urgent personal
-- callout, but planned leave must pass through the request/approval workflow.
-- Scheduler-created callouts (including an approved time-off request) are not
-- restricted because Scheduler is the approving role.
create or replace function guard_self_reported_provider_callout()
returns trigger
language plpgsql
set search_path=public,pg_catalog as $guard$
declare
  v_role app_role:=current_app_role();
begin
  if new.disruption_type='PROVIDER_CALLOUT' and v_role in ('PROVIDER','CLINICAL') then
    if new.reason_category in ('PTO','TRAINING') then
      raise exception 'Planned PTO and training must use the time-off request workflow';
    end if;
    if new.starts_at>now()+interval '24 hours' then
      raise exception 'Urgent self-reported callouts may start at most 24 hours ahead';
    end if;
  end if;
  return new;
end
$guard$;
revoke all on function guard_self_reported_provider_callout() from public,anon,authenticated;

drop trigger if exists guard_self_reported_provider_callout_trigger on schedule_disruptions;
create trigger guard_self_reported_provider_callout_trigger
before insert on schedule_disruptions
for each row execute function guard_self_reported_provider_callout();

-- Preserve the preceding readiness contract and add the new guard without
-- copying every earlier capability expression into this small hardening step.
alter function app_schema_status() rename to app_schema_status_20261022020000;
revoke all on function app_schema_status_20261022020000() from public,anon,authenticated;
create function app_schema_status()
returns jsonb
language sql stable security definer set search_path=public,pg_catalog as $status$
  select app_schema_status_20261022020000() || jsonb_build_object(
    'version','20261022030000',
    'provider_callout_guard',
      to_regprocedure('public.guard_self_reported_provider_callout()') is not null
      and exists(
        select 1 from pg_trigger
        where tgrelid='public.schedule_disruptions'::regclass
          and tgname='guard_self_reported_provider_callout_trigger'
          and not tgisinternal
      )
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
