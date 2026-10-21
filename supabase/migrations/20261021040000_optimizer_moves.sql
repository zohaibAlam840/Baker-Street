begin;

-- A move-enabled plan is still approved through the established add-plan
-- transaction. This wrapper first locks and revalidates one flexible source
-- visit, relocates it, and then invokes approve_optimization_plan for the
-- additions. Any failure rolls the move and every addition back together.
create or replace function approve_optimization_plan_with_move(
  p_patient_id uuid,
  p_date_start date,
  p_date_end date,
  p_plan_key text,
  p_additions jsonb,
  p_move jsonb,
  p_summary jsonb default '{}'::jsonb,
  p_reason text default 'Approved move-enabled schedule'
)
returns jsonb
language plpgsql
security definer
set search_path=public,extensions
as $move_plan$
declare
  v_actor uuid:=auth.uid();
  v_role app_role:=current_app_role();
  v_existing_request uuid;
  v_target appointments%rowtype;
  v_expected_resources jsonb;
  v_current_resources jsonb;
  v_new_resources jsonb;
  v_new_provider uuid;
  v_new_location uuid;
  v_new_start timestamptz;
  v_new_end timestamptz;
  v_timezone text;
  v_result jsonb;
  v_request_id uuid;
  v_result_id uuid;
begin
  if v_actor is null or v_role is null or v_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to approve schedules';
  end if;
  if not can_access_patient(p_patient_id) then
    raise exception 'The patient is outside your permitted caseload';
  end if;
  if p_date_end<>p_date_start+6 or extract(isodow from p_date_start)<>1 then
    raise exception 'Optimization must cover one Monday-through-Sunday week';
  end if;
  if p_plan_key is null or length(p_plan_key)<8 then raise exception 'Plan identity is missing'; end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'A meaningful approval reason is required'; end if;
  if jsonb_typeof(p_additions)<>'array' or jsonb_array_length(p_additions)<1
    or jsonb_array_length(p_additions)>100 then
    raise exception 'Move-enabled plans must add between 1 and 100 appointments';
  end if;
  if jsonb_typeof(p_move)<>'object' then raise exception 'Move payload is invalid'; end if;
  if jsonb_typeof(coalesce(p_move->'old_resource_ids','[]'::jsonb))<>'array'
    or jsonb_typeof(coalesce(p_move->'new_resource_ids','[]'::jsonb))<>'array' then
    raise exception 'Move resource assignments are invalid';
  end if;
  if pg_column_size(p_additions)>1048576 or pg_column_size(p_move)>65536
    or pg_column_size(p_summary)>262144 then
    raise exception 'Plan payload is too large';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_plan_key,1));
  select id into v_existing_request from optimization_requests
  where idempotency_key=p_plan_key limit 1;
  if v_existing_request is not null then
    return jsonb_build_object(
      'request_id',v_existing_request,'appointments_moved',0,'already_committed',true
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_patient_id::text||':'||p_date_start::text,0)
  );
  select timezone into v_timezone from patients
  where id=p_patient_id and status='ACTIVE' for update;
  if not found then raise exception 'Patient is not active'; end if;
  select * into v_target from appointments
  where id=nullif(p_move->>'appointment_id','')::uuid
  for update;
  if not found or v_target.patient_id<>p_patient_id then
    raise exception 'The appointment selected for moving no longer exists';
  end if;
  if v_target.status not in ('SCHEDULED','CONFIRMED') then
    raise exception 'Only a scheduled or confirmed appointment can be moved';
  end if;
  if v_target.scheduling_flexibility<>'FLEXIBLE' then
    raise exception 'Only a flexible appointment can be moved by the optimizer';
  end if;
  if v_target.start_time<=now() then
    raise exception 'An appointment cannot be moved after it has started';
  end if;
  if (v_target.start_time at time zone v_timezone)::date
    not between p_date_start and p_date_end then
    raise exception 'The appointment selected for moving is outside the approved week';
  end if;

  select coalesce(jsonb_agg(resource_id::text order by resource_id::text),'[]'::jsonb)
  into v_current_resources from appointment_resources
  where appointment_id=v_target.id;
  select coalesce(jsonb_agg(value order by value),'[]'::jsonb)
  into v_expected_resources
  from jsonb_array_elements_text(coalesce(p_move->'old_resource_ids','[]'::jsonb));
  if v_target.service_id is distinct from nullif(p_move->>'service_id','')::uuid
    or v_target.status::text is distinct from p_move->>'status'
    or v_target.scheduling_flexibility::text is distinct from p_move->>'flexibility'
    or v_target.authorization_id is distinct from nullif(p_move->>'authorization_id','')::uuid
    or v_target.provider_id is distinct from nullif(p_move->>'old_provider_id','')::uuid
    or v_target.location_id is distinct from nullif(p_move->>'old_location_id','')::uuid
    or v_target.start_time is distinct from (p_move->>'old_start_time')::timestamptz
    or v_target.end_time is distinct from (p_move->>'old_end_time')::timestamptz
    or v_target.telehealth is distinct from (p_move->>'telehealth')::boolean
    or v_current_resources is distinct from v_expected_resources then
    raise exception 'The appointment changed while this plan was being reviewed';
  end if;

  v_new_provider:=nullif(p_move->>'new_provider_id','')::uuid;
  v_new_location:=nullif(p_move->>'new_location_id','')::uuid;
  v_new_start:=(p_move->>'new_start_time')::timestamptz;
  v_new_end:=(p_move->>'new_end_time')::timestamptz;
  if v_new_provider is null or v_new_end<=v_new_start then
    raise exception 'Move destination is invalid';
  end if;
  if v_new_start<=now() then raise exception 'A visit cannot be moved into the past'; end if;
  if extract(epoch from(v_new_end-v_new_start))<>extract(epoch from(v_target.end_time-v_target.start_time)) then
    raise exception 'An optimizer move cannot change clinical duration';
  end if;
  if (v_new_start at time zone v_timezone)::date
    not between p_date_start and p_date_end then
    raise exception 'Move destination falls outside the approved week';
  end if;
  select coalesce(jsonb_agg(value order by value),'[]'::jsonb)
  into v_new_resources
  from jsonb_array_elements_text(coalesce(p_move->'new_resource_ids','[]'::jsonb));
  if v_new_start=v_target.start_time and v_new_end=v_target.end_time
    and v_new_provider is not distinct from v_target.provider_id
    and v_new_location is not distinct from v_target.location_id
    and v_new_resources is not distinct from v_current_resources then
    raise exception 'Move destination must change the appointment';
  end if;

  perform 1 from providers where id=v_new_provider for update;
  perform 1 from resources
  where id in (select value::uuid from jsonb_array_elements_text(v_new_resources))
  order by id for update;

  update appointments set
    original_start_time=coalesce(original_start_time,start_time),
    original_provider_id=coalesce(original_provider_id,provider_id),
    original_location_id=coalesce(original_location_id,location_id),
    provider_id=v_new_provider,
    location_id=v_new_location,
    start_time=v_new_start,
    end_time=v_new_end,
    last_change_reason=trim(p_reason)
  where id=v_target.id;

  delete from appointment_resources where appointment_id=v_target.id;
  insert into appointment_resources(appointment_id,resource_id)
  select v_target.id,value::uuid from jsonb_array_elements_text(v_new_resources);

  v_result:=approve_optimization_plan(
    p_patient_id,p_date_start,p_date_end,p_plan_key,p_additions,p_summary,p_reason
  );
  if coalesce((v_result->>'already_committed')::boolean,false) then
    raise exception 'The approval was committed concurrently; refresh before retrying';
  end if;
  v_request_id:=(v_result->>'request_id')::uuid;
  v_result_id:=(v_result->>'result_id')::uuid;

  insert into optimization_changes(
    optimization_result_id,appointment_id,action,service_id,
    old_start,new_start,old_end,new_end,
    old_provider_id,new_provider_id,old_location_id,new_location_id
  ) values (
    v_result_id,v_target.id,'MOVE',v_target.service_id,
    v_target.start_time,v_new_start,v_target.end_time,v_new_end,
    v_target.provider_id,v_new_provider,v_target.location_id,v_new_location
  );
  update optimization_results set appointments_moved=1 where id=v_result_id;
  update optimization_requests set
    allow_moves=true,
    request_payload=request_payload||jsonb_build_object('approved_move',p_move)
  where id=v_request_id;

  insert into audit_log(
    user_id,action,patient_id,appointment_id,optimization_request_id,
    old_values,new_values,override_reason
  ) values (
    v_actor,'OPTIMIZATION_APPOINTMENT_MOVED',p_patient_id,v_target.id,v_request_id,
    jsonb_build_object(
      'start_time',v_target.start_time,'end_time',v_target.end_time,
      'provider_id',v_target.provider_id,'location_id',v_target.location_id,
      'resource_ids',v_current_resources
    ),
    jsonb_build_object(
      'start_time',v_new_start,'end_time',v_new_end,
      'provider_id',v_new_provider,'location_id',v_new_location,
      'resource_ids',v_new_resources
    ),
    trim(p_reason)
  );

  return v_result||jsonb_build_object('appointments_moved',1);
end
$move_plan$;

revoke all on function approve_optimization_plan_with_move(uuid,date,date,text,jsonb,jsonb,jsonb,text)
  from public;
grant execute on function approve_optimization_plan_with_move(uuid,date,date,text,jsonb,jsonb,jsonb,text)
  to authenticated;

create or replace function app_schema_status()
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $status$
  select jsonb_build_object(
    'ready',true,'version','20261021040000',
    'optimizer_approval',to_regprocedure('public.approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text)') is not null,
    'optimizer_moves',to_regprocedure('public.approve_optimization_plan_with_move(uuid,date,date,text,jsonb,jsonb,jsonb,text)') is not null,
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
