-- Persist explicit human reject/defer decisions for generated optimizer plans.
-- Plans remain server-generated; the browser supplies only the stable plan ID
-- and the human's decision details.

begin;

create table optimization_plan_decisions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  date_start date not null,
  date_end date not null,
  plan_id text not null,
  decision text not null check (decision in ('REJECTED','DEFERRED')),
  reason text not null,
  deferred_until timestamptz,
  plan_summary jsonb not null default '{}'::jsonb,
  decided_by uuid references auth.users(id) on delete set null,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint optimization_plan_decisions_dates check (date_end>=date_start),
  constraint optimization_plan_decisions_plan_id check (length(plan_id) between 1 and 200),
  constraint optimization_plan_decisions_reason check (length(btrim(reason)) between 3 and 500),
  constraint optimization_plan_decisions_defer check (
    (decision='REJECTED' and deferred_until is null)
    or (decision='DEFERRED' and deferred_until is not null)
  ),
  unique(patient_id,date_start,plan_id)
);
create index optimization_plan_decisions_queue_idx
  on optimization_plan_decisions(patient_id,date_start,decision,deferred_until);
alter table optimization_plan_decisions enable row level security;
create policy "scoped optimization decision read" on optimization_plan_decisions
  for select to authenticated using (can_access_patient(patient_id));
grant select on optimization_plan_decisions to authenticated;

create trigger optimization_plan_decisions_set_updated_at
before update on optimization_plan_decisions
for each row execute function set_updated_at();

-- Approval and reject/defer use the same transaction-scoped lock. Whichever
-- decision commits first wins, so a plan cannot be approved and rejected by
-- two reviewers racing from separate screens.
create or replace function guard_optimization_approval_decision()
returns trigger language plpgsql security definer set search_path=public,pg_catalog
as $guard_approval$
declare v_plan_id text; v_decision optimization_plan_decisions%rowtype;
begin
  v_plan_id:=nullif(new.request_payload#>>'{summary,plan_id}','');
  if new.approved_at is null or new.patient_id is null or v_plan_id is null then return new; end if;
  perform pg_advisory_xact_lock(
    hashtextextended(new.patient_id::text||':'||new.date_start::text||':'||v_plan_id,2)
  );
  select * into v_decision from optimization_plan_decisions
  where patient_id=new.patient_id and date_start=new.date_start and plan_id=v_plan_id
    and (decision='REJECTED' or (decision='DEFERRED' and deferred_until>now()))
  for share;
  if found then
    raise exception 'Plan already has an active % decision',lower(v_decision.decision);
  end if;
  return new;
end
$guard_approval$;
drop trigger if exists guard_optimization_approval_decision_trigger on optimization_requests;
create trigger guard_optimization_approval_decision_trigger
before insert on optimization_requests
for each row execute function guard_optimization_approval_decision();
revoke all on function guard_optimization_approval_decision() from public,anon,authenticated;

create or replace function record_optimization_plan_decision(
  p_patient_id uuid,
  p_date_start date,
  p_date_end date,
  p_plan_id text,
  p_decision text,
  p_reason text,
  p_deferred_until timestamptz,
  p_plan_summary jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_catalog
as $record_decision$
declare
  v_actor uuid:=auth.uid();
  v_role app_role:=current_app_role();
  v_existing optimization_plan_decisions%rowtype;
  v_decision optimization_plan_decisions%rowtype;
begin
  if v_actor is null or v_role is null or v_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'Plan rejection permission required' using errcode='42501';
  end if;
  if not can_access_patient(p_patient_id) then
    raise exception 'Patient is outside your permitted caseload' using errcode='42501';
  end if;
  if p_date_start is null or p_date_end is null or p_date_end<>p_date_start+6 then
    raise exception 'Optimization week is invalid';
  end if;
  if nullif(btrim(p_plan_id),'') is null or length(btrim(p_plan_id))>200 then
    raise exception 'Plan identifier is invalid';
  end if;
  if p_decision is null or p_decision not in ('REJECTED','DEFERRED') then
    raise exception 'Decision must be REJECTED or DEFERRED';
  end if;
  if length(btrim(coalesce(p_reason,''))) not between 3 and 500 then
    raise exception 'Decision reason must be between 3 and 500 characters';
  end if;
  if p_decision='REJECTED' and p_deferred_until is not null then
    raise exception 'A rejected plan cannot have a defer date';
  end if;
  if p_decision='DEFERRED' and (
    p_deferred_until is null or p_deferred_until<=now()
    -- The action enforces the patient's exact local-week boundary. This wider
    -- UTC backstop accommodates every IANA offset without storing PHI here.
    or p_deferred_until>=(p_date_end+2)::timestamptz
  ) then
    raise exception 'Defer time must be in the future and before the optimization week ends';
  end if;
  if p_plan_summary is null or jsonb_typeof(p_plan_summary)<>'object'
    or pg_column_size(p_plan_summary)>65536 then
    raise exception 'Plan summary is invalid';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_patient_id::text||':'||p_date_start::text||':'||btrim(p_plan_id),2)
  );
  select * into v_existing from optimization_plan_decisions
  where patient_id=p_patient_id and date_start=p_date_start and plan_id=btrim(p_plan_id)
  for update;

  if exists(
    select 1 from optimization_requests
    where patient_id=p_patient_id and date_start=p_date_start and approved_at is not null
      and request_payload#>>'{summary,plan_id}'=btrim(p_plan_id)
  ) then
    raise exception 'Plan was already approved';
  end if;

  if found and (
    v_existing.decision='REJECTED'
    or (v_existing.decision='DEFERRED' and v_existing.deferred_until>now())
  ) then
    return jsonb_build_object(
      'decision_id',v_existing.id,'decision',v_existing.decision,
      'deferred_until',v_existing.deferred_until,'already_decided',true,
      'version',v_existing.version
    );
  end if;

  if v_existing.id is null then
    insert into optimization_plan_decisions(
      patient_id,date_start,date_end,plan_id,decision,reason,deferred_until,
      plan_summary,decided_by
    ) values (
      p_patient_id,p_date_start,p_date_end,btrim(p_plan_id),p_decision,btrim(p_reason),
      case when p_decision='DEFERRED' then p_deferred_until else null end,
      p_plan_summary,v_actor
    ) returning * into v_decision;
  else
    update optimization_plan_decisions set
      date_end=p_date_end,decision=p_decision,reason=btrim(p_reason),
      deferred_until=case when p_decision='DEFERRED' then p_deferred_until else null end,
      plan_summary=p_plan_summary,decided_by=v_actor,version=version+1
    where id=v_existing.id returning * into v_decision;
  end if;

  insert into audit_log(
    user_id,action,patient_id,new_values,override_reason
  ) values (
    v_actor,'OPTIMIZATION_PLAN_'||v_decision.decision,p_patient_id,
    jsonb_build_object(
      'decision_id',v_decision.id,'plan_id',v_decision.plan_id,
      'date_start',v_decision.date_start,'date_end',v_decision.date_end,
      'decision',v_decision.decision,'deferred_until',v_decision.deferred_until,
      'version',v_decision.version,'plan_summary',v_decision.plan_summary
    ),v_decision.reason
  );

  return jsonb_build_object(
    'decision_id',v_decision.id,'decision',v_decision.decision,
    'deferred_until',v_decision.deferred_until,'already_decided',false,
    'version',v_decision.version
  );
end
$record_decision$;
revoke all on function record_optimization_plan_decision(uuid,date,date,text,text,text,timestamptz,jsonb) from public,anon;
grant execute on function record_optimization_plan_decision(uuid,date,date,text,text,text,timestamptz,jsonb) to authenticated;

create or replace function app_schema_status()
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $status$
  select jsonb_build_object(
    'ready',true,'version','20261021020000',
    'optimizer_approval',to_regprocedure('public.approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text)') is not null,
    'optimizer_decisions',to_regprocedure('public.record_optimization_plan_decision(uuid,date,date,text,text,text,timestamp with time zone,jsonb)') is not null
      and to_regclass('public.optimization_plan_decisions') is not null,
    'atomic_booking',to_regprocedure('public.create_appointment_series(jsonb,text)') is not null,
    'opaque_conflicts',to_regprocedure('public.optimization_busy_intervals(timestamp with time zone,timestamp with time zone)') is not null,
    'schedule_recovery',to_regclass('public.recovery_cases') is not null
      and to_regprocedure('public.respond_recovery_offer_with_contact(uuid,integer,text,text,uuid,communication_response_channel,uuid,text)') is not null,
    'communications',to_regclass('public.communication_consents') is not null
      and to_regclass('public.communication_jobs') is not null
      and to_regclass('public.communication_destination_suppressions') is not null
      and to_regclass('public.communication_delivery_attempts') is not null
      and to_regprocedure('public.sync_appointment_reminders(uuid)') is not null
      and to_regprocedure('public.prepare_communication_delivery(uuid,uuid)') is not null,
    'configuration_writes',to_regprocedure('public.update_service_configuration(uuid,text,text,text,integer[],integer,text,boolean,boolean,boolean,boolean,boolean,uuid[])') is not null
      and to_regprocedure('public.update_location_configuration(uuid,text,location_type,text,text,text,boolean)') is not null
      and to_regprocedure('public.update_resource_configuration(uuid,text,text,integer,uuid,boolean)') is not null
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
