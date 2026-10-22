begin;

-- Planned time off is a request, not an availability mutation. Approval hands
-- the exact interval to the existing atomic callout/recovery transaction.
create table provider_time_off_requests (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason_category text not null check (reason_category in ('PTO','TRAINING','OTHER')),
  request_note text not null,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','CANCELLED')),
  version int not null default 1 check (version > 0),
  idempotency_key text not null,
  reviewed_by uuid references auth.users(id) on delete restrict,
  review_reason text,
  reviewed_at timestamptz,
  disruption_id uuid references schedule_disruptions(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < ends_at),
  check (ends_at <= starts_at + interval '14 days'),
  check (length(request_note) between 3 and 500),
  check (length(idempotency_key) between 8 and 200),
  check (review_reason is null or length(review_reason) between 3 and 1000),
  check (
    (status='PENDING' and reviewed_by is null and review_reason is null
      and reviewed_at is null and disruption_id is null)
    or
    (status='APPROVED' and reviewed_by is not null and review_reason is not null
      and reviewed_at is not null and disruption_id is not null)
    or
    (status in ('REJECTED','CANCELLED') and reviewed_by is not null
      and review_reason is not null and reviewed_at is not null and disruption_id is null)
  ),
  unique(requested_by,idempotency_key)
);
alter table provider_time_off_requests add constraint provider_time_off_requests_pending_no_overlap
exclude using gist (
  provider_id with =,
  tstzrange(starts_at,ends_at,'[)') with &&
) where (status='PENDING');
create index provider_time_off_requests_queue_idx
  on provider_time_off_requests(status,starts_at,created_at);
create index provider_time_off_requests_provider_idx
  on provider_time_off_requests(provider_id,created_at desc);
create trigger provider_time_off_requests_set_updated_at
before update on provider_time_off_requests
for each row execute function set_updated_at();

alter table provider_time_off_requests enable row level security;
create policy "scoped time off request read"
on provider_time_off_requests for select to authenticated
using (
  current_app_role()='SCHEDULER'
  or (current_app_role()='PROVIDER' and current_provider_id()=provider_id)
);
grant select on provider_time_off_requests to authenticated;
revoke insert,update,delete on provider_time_off_requests from authenticated;

-- Recurring availability remains readable but no authenticated role may write
-- it directly. A future guarded command can add manager edits without giving a
-- provider a way to silently self-approve PTO.
drop policy if exists "availability managers write" on provider_availability;
revoke insert,update,delete on provider_availability from authenticated;

create or replace function request_provider_time_off(
  p_provider_id uuid,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_reason_category text,
  p_request_note text,
  p_idempotency_key text
)
returns jsonb
language plpgsql security definer set search_path=public,extensions as $request_time_off$
declare
  v_actor uuid:=auth.uid();
  v_category text:=upper(trim(coalesce(p_reason_category,'')));
  v_existing provider_time_off_requests%rowtype;
  v_request_id uuid;
begin
  if v_actor is null or current_app_role()<>'PROVIDER' then
    raise exception 'Provider access required to request time off';
  end if;
  if current_provider_id() is null or current_provider_id() is distinct from p_provider_id then
    raise exception 'Providers may request time off only for their linked clinician record';
  end if;
  if p_start_time is null or p_end_time is null or p_end_time<=p_start_time
    or p_start_time<=now() or p_start_time>now()+interval '1 year'
    or p_end_time>p_start_time+interval '14 days' then
    raise exception 'Time-off window must be future dated, within one year, and no longer than 14 days';
  end if;
  if v_category not in ('PTO','TRAINING','OTHER') then
    raise exception 'Time-off reason category is not supported';
  end if;
  if length(trim(coalesce(p_request_note,''))) not between 3 and 500 then
    raise exception 'A request note between 3 and 500 characters is required';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':TIME_OFF_REQUEST:'||trim(p_idempotency_key),0));
  select * into v_existing from provider_time_off_requests r
  where r.requested_by=v_actor and r.idempotency_key=trim(p_idempotency_key);
  if found then
    return jsonb_build_object(
      'request_id',v_existing.id,'status',v_existing.status,
      'already_requested',true
    );
  end if;

  perform 1 from providers p where p.id=p_provider_id and p.status='ACTIVE' for share;
  if not found then raise exception 'Active clinician was not found'; end if;
  if exists(
    select 1 from schedule_disruptions sd
    where sd.disruption_type='PROVIDER_CALLOUT' and sd.provider_id=p_provider_id
      and sd.status not in ('CANCELLED','WITHDRAWN')
      and tstzrange(sd.starts_at,sd.ends_at,'[)') && tstzrange(p_start_time,p_end_time,'[)')
  ) then raise exception 'This clinician is already unavailable during that window'; end if;
  if exists(
    select 1 from provider_time_off_requests r
    where r.provider_id=p_provider_id and r.status='PENDING'
      and tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(p_start_time,p_end_time,'[)')
  ) then raise exception 'This clinician already has an overlapping pending request'; end if;

  insert into provider_time_off_requests(
    provider_id,requested_by,starts_at,ends_at,reason_category,request_note,idempotency_key
  ) values(
    p_provider_id,v_actor,p_start_time,p_end_time,v_category,trim(p_request_note),trim(p_idempotency_key)
  ) returning id into v_request_id;

  insert into audit_log(user_id,action,new_values,override_reason)
  values(v_actor,'PROVIDER_TIME_OFF_REQUESTED',jsonb_build_object(
    'request_id',v_request_id,'provider_id',p_provider_id,'starts_at',p_start_time,
    'ends_at',p_end_time,'reason_category',v_category
  ),v_category);

  insert into notifications(user_id,kind,title,body,href,severity,dedupe_key,expires_at)
  select up.user_id,'TIME_OFF_REVIEW','Time-off request needs review',
    'Open the secure time-off queue to approve or reject a clinician request.',
    '/time-off','WARNING','time-off-request-'||v_request_id,p_start_time
  from user_profiles up where up.active and up.role='SCHEDULER'
  on conflict(user_id,dedupe_key) where user_id is not null and dedupe_key is not null do nothing;

  return jsonb_build_object(
    'request_id',v_request_id,'status','PENDING','already_requested',false
  );
end
$request_time_off$;
revoke all on function request_provider_time_off(uuid,timestamptz,timestamptz,text,text,text) from public;
grant execute on function request_provider_time_off(uuid,timestamptz,timestamptz,text,text,text) to authenticated;

create or replace function decide_provider_time_off_request(
  p_request_id uuid,
  p_expected_version int,
  p_decision text,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path=public,extensions as $decide_time_off$
declare
  v_actor uuid:=auth.uid();
  v_decision text:=upper(trim(coalesce(p_decision,'')));
  v_request provider_time_off_requests%rowtype;
  v_callout jsonb;
  v_disruption_id uuid;
  v_affected_count int:=0;
begin
  if v_actor is null or current_app_role()<>'SCHEDULER' then
    raise exception 'Scheduler access required to decide time-off requests';
  end if;
  if p_expected_version is null or p_expected_version<1 then
    raise exception 'A valid time-off request version is required';
  end if;
  if v_decision not in ('APPROVED','REJECTED') then
    raise exception 'Decision must be APPROVED or REJECTED';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'A decision reason between 3 and 1000 characters is required';
  end if;

  select * into v_request from provider_time_off_requests r
  where r.id=p_request_id for update;
  if not found then raise exception 'Time-off request was not found'; end if;
  if v_request.version=p_expected_version+1 and v_request.status=v_decision
    and v_request.reviewed_by=v_actor and v_request.review_reason=trim(p_reason) then
    return jsonb_build_object(
      'request_id',v_request.id,'status',v_request.status,
      'disruption_id',v_request.disruption_id,'already_decided',true
    );
  end if;
  if v_request.version<>p_expected_version then
    raise exception 'Time-off request changed; refresh before deciding';
  end if;
  if v_request.status<>'PENDING' then
    raise exception 'Time-off request is already decided';
  end if;

  if v_decision='APPROVED' then
    if v_request.ends_at<=now() then
      raise exception 'Time-off request has expired and cannot be approved';
    end if;
    v_callout:=report_provider_callout(
      v_request.provider_id,v_request.starts_at,v_request.ends_at,
      v_request.reason_category,v_request.request_note,
      'approved-time-off:'||v_request.id::text
    );
    v_disruption_id:=(v_callout->>'disruption_id')::uuid;
    v_affected_count:=coalesce((v_callout->>'affected_count')::int,0);
    update provider_time_off_requests set
      status='APPROVED',version=version+1,reviewed_by=v_actor,
      review_reason=trim(p_reason),reviewed_at=now(),disruption_id=v_disruption_id
    where id=v_request.id;
  else
    update provider_time_off_requests set
      status='REJECTED',version=version+1,reviewed_by=v_actor,
      review_reason=trim(p_reason),reviewed_at=now()
    where id=v_request.id;
  end if;

  insert into audit_log(user_id,action,new_values,override_reason)
  values(v_actor,'PROVIDER_TIME_OFF_'||v_decision,jsonb_build_object(
    'request_id',v_request.id,'provider_id',v_request.provider_id,
    'starts_at',v_request.starts_at,'ends_at',v_request.ends_at,
    'disruption_id',v_disruption_id,'affected_appointments',v_affected_count
  ),trim(p_reason));

  insert into notifications(user_id,kind,title,body,href,severity,dedupe_key,expires_at)
  values(
    v_request.requested_by,'TIME_OFF_DECISION',
    case when v_decision='APPROVED' then 'Time off approved' else 'Time off rejected' end,
    case when v_decision='APPROVED'
      then 'Your approved window is now reflected in the schedule.'
      else 'Open the secure time-off queue to review the scheduler decision.' end,
    '/time-off',case when v_decision='APPROVED' then 'INFO' else 'WARNING' end,
    'time-off-decision-'||v_request.id,
    greatest(v_request.ends_at,now()+interval '1 day')
  )
  on conflict(user_id,dedupe_key) where user_id is not null and dedupe_key is not null do nothing;

  return jsonb_build_object(
    'request_id',v_request.id,'status',v_decision,'disruption_id',v_disruption_id,
    'affected_count',v_affected_count,'already_decided',false
  );
end
$decide_time_off$;
revoke all on function decide_provider_time_off_request(uuid,int,text,text) from public;
grant execute on function decide_provider_time_off_request(uuid,int,text,text) to authenticated;

create or replace function cancel_provider_time_off_request(
  p_request_id uuid,
  p_expected_version int,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path=public,extensions as $cancel_time_off$
declare
  v_actor uuid:=auth.uid();
  v_request provider_time_off_requests%rowtype;
begin
  if v_actor is null or current_app_role()<>'PROVIDER' then
    raise exception 'Provider access required to cancel a time-off request';
  end if;
  if p_expected_version is null or p_expected_version<1
    or length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'A current request version and cancellation reason are required';
  end if;
  select * into v_request from provider_time_off_requests r
  where r.id=p_request_id for update;
  if not found then raise exception 'Time-off request was not found'; end if;
  if v_request.provider_id is distinct from current_provider_id()
    or v_request.requested_by is distinct from v_actor then
    raise exception 'Providers may cancel only their own pending request';
  end if;
  if v_request.version=p_expected_version+1 and v_request.status='CANCELLED'
    and v_request.review_reason=trim(p_reason) then
    return jsonb_build_object('request_id',v_request.id,'status','CANCELLED','already_cancelled',true);
  end if;
  if v_request.version<>p_expected_version then
    raise exception 'Time-off request changed; refresh before cancelling';
  end if;
  if v_request.status<>'PENDING' then
    raise exception 'Only a pending time-off request can be cancelled';
  end if;

  update provider_time_off_requests set
    status='CANCELLED',version=version+1,reviewed_by=v_actor,
    review_reason=trim(p_reason),reviewed_at=now()
  where id=v_request.id;
  insert into audit_log(user_id,action,new_values,override_reason)
  values(v_actor,'PROVIDER_TIME_OFF_CANCELLED',jsonb_build_object(
    'request_id',v_request.id,'provider_id',v_request.provider_id,
    'starts_at',v_request.starts_at,'ends_at',v_request.ends_at
  ),trim(p_reason));

  return jsonb_build_object('request_id',v_request.id,'status','CANCELLED','already_cancelled',false);
end
$cancel_time_off$;
revoke all on function cancel_provider_time_off_request(uuid,int,text) from public;
grant execute on function cancel_provider_time_off_request(uuid,int,text) to authenticated;

create or replace function app_schema_status()
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $status$
  select jsonb_build_object(
    'ready',true,'version','20261022020000',
    'optimizer_approval',to_regprocedure('public.approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text)') is not null,
    'optimizer_moves',to_regprocedure('public.approve_optimization_plan_with_move(uuid,date,date,text,jsonb,jsonb,jsonb,text)') is not null,
    'optimizer_decisions',to_regprocedure('public.record_optimization_plan_decision(uuid,date,date,text,text,text,timestamp with time zone,jsonb)') is not null
      and to_regclass('public.optimization_plan_decisions') is not null,
    'clinical_reductions',to_regclass('public.appointment_reduction_requests') is not null
      and to_regprocedure('public.decide_appointment_reduction(uuid,integer,text,text)') is not null,
    'provider_time_off',to_regclass('public.provider_time_off_requests') is not null
      and to_regprocedure('public.request_provider_time_off(uuid,timestamp with time zone,timestamp with time zone,text,text,text)') is not null
      and to_regprocedure('public.decide_provider_time_off_request(uuid,integer,text,text)') is not null
      and to_regprocedure('public.cancel_provider_time_off_request(uuid,integer,text)') is not null,
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
    'communication_delivery',to_regclass('public.communication_receipt_tokens') is not null
      and to_regprocedure('public.communication_delivery_mode()') is not null
      and to_regprocedure('public.claim_communication_jobs_for_channels(integer,text,communication_channel[])') is not null
      and to_regprocedure('public.prepare_communication_provider_delivery(uuid,uuid)') is not null
      and to_regprocedure('public.record_communication_provider_receipt(uuid,text,text,communication_receipt_type,timestamp with time zone,jsonb)') is not null
      and to_regprocedure('public.record_communication_destination_receipt(communication_channel,text,text,text,communication_receipt_type,timestamp with time zone,jsonb)') is not null,
    'configuration_writes',to_regprocedure('public.update_service_configuration(uuid,text,text,text,integer[],integer,text,boolean,boolean,boolean,boolean,boolean,uuid[])') is not null
      and to_regprocedure('public.update_location_configuration(uuid,text,location_type,text,text,text,boolean)') is not null
      and to_regprocedure('public.update_resource_configuration(uuid,text,text,integer,uuid,boolean)') is not null
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
