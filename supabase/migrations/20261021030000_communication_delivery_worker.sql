begin;

-- Receipt correlation tokens are intentionally kept outside communication_jobs.
-- Staff can read scoped jobs, but only the service-role preparation boundary may
-- reveal a callback token to an approved delivery provider.
create table communication_receipt_tokens (
  communication_job_id uuid primary key references communication_jobs(id) on delete restrict,
  receipt_token uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now()
);
alter table communication_receipt_tokens enable row level security;
revoke all on communication_receipt_tokens from public,anon,authenticated;

create or replace function ensure_communication_receipt_token()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $token$
begin
  insert into communication_receipt_tokens(communication_job_id)
  values(new.id) on conflict(communication_job_id) do nothing;
  return new;
end
$token$;
revoke all on function ensure_communication_receipt_token() from public,anon,authenticated;

create trigger communication_jobs_receipt_token_trigger
after insert on communication_jobs for each row execute function ensure_communication_receipt_token();

insert into communication_receipt_tokens(communication_job_id)
select id from communication_jobs on conflict(communication_job_id) do nothing;

create or replace function communication_delivery_mode()
returns text language plpgsql stable security definer set search_path=public,pg_catalog as $mode$
declare v_mode text;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  select delivery_mode into v_mode from communication_delivery_config where singleton;
  return coalesce(v_mode,'RECORD_ONLY');
end
$mode$;
revoke all on function communication_delivery_mode() from public,anon,authenticated;
grant execute on function communication_delivery_mode() to service_role;

-- Do not lease channels for which this worker has no configured provider. This
-- prevents an SMS/email deployment from consuming future PUSH work as failures.
create or replace function claim_communication_jobs_for_channels(
  p_limit int,p_worker_id text,p_channels communication_channel[]
)
returns table(job_id uuid,processing_token uuid,attempt_number int,lease_expires_at timestamptz)
language plpgsql security definer set search_path=public,pg_catalog as $claim$
declare
  v_job communication_jobs%rowtype;
  v_token uuid;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  if p_limit not between 1 and 100
    or length(trim(coalesce(p_worker_id,''))) not between 3 and 100
    or coalesce(cardinality(p_channels),0) not between 1 and 3
    or array_position(p_channels,null) is not null then
    raise exception 'Worker claim parameters are invalid';
  end if;
  update communication_jobs set status='EXPIRED',last_error_category='EXPIRED_BEFORE_SEND',
    processing_token=null,processing_worker=null,processing_started_at=null,version=version+1
  where status in ('QUEUED','FAILED') and expires_at<=now();
  for v_job in
    select j.* from communication_jobs j
    where j.channel=any(p_channels)
      and j.status in ('QUEUED','FAILED') and j.next_attempt_at<=now() and j.scheduled_for<=now()
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
revoke all on function claim_communication_jobs_for_channels(int,text,communication_channel[])
  from public,anon,authenticated;
grant execute on function claim_communication_jobs_for_channels(int,text,communication_channel[])
  to service_role;

-- Append the opaque receipt token only after the existing just-in-time consent,
-- source, quiet-hours, suppression, and delivery-mode checks have succeeded.
create or replace function prepare_communication_provider_delivery(
  p_job_id uuid,p_processing_token uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $prepare_provider$
declare
  v_result jsonb;
  v_receipt_token uuid;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  v_result:=prepare_communication_delivery(p_job_id,p_processing_token);
  if coalesce((v_result->>'ready')::boolean,false) then
    select t.receipt_token into v_receipt_token
    from communication_receipt_tokens t
    join communication_jobs j on j.id=t.communication_job_id
    where t.communication_job_id=p_job_id
      and j.status='PROCESSING' and j.processing_token=p_processing_token;
    if v_receipt_token is null then raise exception 'Communication receipt token is missing'; end if;
    v_result:=v_result||jsonb_build_object('receipt_token',v_receipt_token);
  end if;
  return v_result;
end
$prepare_provider$;
revoke all on function prepare_communication_provider_delivery(uuid,uuid)
  from public,anon,authenticated;
grant execute on function prepare_communication_provider_delivery(uuid,uuid) to service_role;

-- Provider callbacks resolve an opaque token rather than exposing patient or
-- job identifiers in callback URLs and custom arguments.
create or replace function record_communication_provider_receipt(
  p_receipt_token uuid,p_provider text,p_provider_event_id text,
  p_receipt_type communication_receipt_type,p_occurred_at timestamptz,p_metadata jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $provider_receipt$
declare
  v_job_id uuid;
  v_event_id text;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  if p_receipt_token is null
    or length(trim(coalesce(p_provider,''))) not between 2 and 40
    or length(trim(coalesce(p_provider_event_id,''))) not between 3 and 240
    or jsonb_typeof(coalesce(p_metadata,'{}'::jsonb))<>'object' then
    raise exception 'Provider receipt payload is invalid';
  end if;
  select communication_job_id into v_job_id from communication_receipt_tokens
  where receipt_token=p_receipt_token;
  if not found then raise exception 'Communication receipt token was not found'; end if;
  v_event_id:=lower(trim(p_provider))||':'||trim(p_provider_event_id);
  return record_communication_receipt(
    v_job_id,v_event_id,p_receipt_type,p_occurred_at,
    coalesce(p_metadata,'{}'::jsonb)||jsonb_build_object('event_source',upper(trim(p_provider)))
  );
end
$provider_receipt$;
revoke all on function record_communication_provider_receipt(uuid,text,text,communication_receipt_type,timestamptz,jsonb)
  from public,anon,authenticated;
grant execute on function record_communication_provider_receipt(uuid,text,text,communication_receipt_type,timestamptz,jsonb)
  to service_role;

-- Twilio sends inbound STOP notifications to the Messaging Service webhook,
-- which has no outbound callback token. Resolve only to a destination that this
-- application has previously messaged, then reuse the canonical revocation RPC.
create or replace function record_communication_destination_receipt(
  p_channel communication_channel,p_destination text,p_provider text,p_provider_event_id text,
  p_receipt_type communication_receipt_type,p_occurred_at timestamptz,p_metadata jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $destination_receipt$
declare
  v_job_id uuid;
  v_fingerprint text;
  v_event_id text;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  if p_channel is distinct from 'SMS' or p_receipt_type is distinct from 'OPT_OUT'
    or length(trim(coalesce(p_destination,''))) not between 8 and 30
    or length(trim(coalesce(p_provider,''))) not between 2 and 40
    or length(trim(coalesce(p_provider_event_id,''))) not between 3 and 240
    or jsonb_typeof(coalesce(p_metadata,'{}'::jsonb))<>'object' then
    raise exception 'Destination receipt payload is invalid';
  end if;
  v_fingerprint:=communication_destination_fingerprint(p_channel,trim(p_destination));
  select id into v_job_id from communication_jobs
  where channel=p_channel and destination_fingerprint=v_fingerprint
  order by created_at desc,id desc limit 1;
  if not found then
    return jsonb_build_object('matched',false,'already_applied',false);
  end if;
  v_event_id:=lower(trim(p_provider))||':'||trim(p_provider_event_id);
  return record_communication_receipt(
    v_job_id,v_event_id,p_receipt_type,p_occurred_at,
    coalesce(p_metadata,'{}'::jsonb)||jsonb_build_object('event_source',upper(trim(p_provider)))
  )||jsonb_build_object('matched',true);
end
$destination_receipt$;
revoke all on function record_communication_destination_receipt(communication_channel,text,text,text,communication_receipt_type,timestamptz,jsonb)
  from public,anon,authenticated;
grant execute on function record_communication_destination_receipt(communication_channel,text,text,text,communication_receipt_type,timestamptz,jsonb)
  to service_role;

create or replace function app_schema_status()
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $status$
  select jsonb_build_object(
    'ready',true,'version','20261021030000',
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
