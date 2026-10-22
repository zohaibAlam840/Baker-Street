begin;

-- A scheduler may propose a move or shorter visit, but a proposal that lowers
-- the source week's care below the active clinical target must be reviewed by
-- the patient's clinical supervisor. The source appointment remains unchanged
-- while the request is pending.
create table appointment_reduction_requests (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete restrict,
  patient_id uuid not null references patients(id) on delete restrict,
  service_id uuid not null references services(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  request_reason text not null,
  proposed_provider_id uuid references providers(id) on delete restrict,
  proposed_location_id uuid references locations(id) on delete restrict,
  proposed_start_time timestamptz not null,
  proposed_end_time timestamptz not null,
  proposed_status appointment_status not null,
  proposed_flexibility scheduling_flexibility not null,
  proposed_resource_ids jsonb not null default '[]'::jsonb,
  source_appointment_updated_at timestamptz not null,
  source_start_time timestamptz not null,
  source_end_time timestamptz not null,
  source_week_start date not null,
  scheduled_minutes_before int not null check (scheduled_minutes_before >= 0),
  scheduled_minutes_after int not null check (scheduled_minutes_after >= 0),
  target_minutes int,
  required_service boolean not null default false,
  clinical_requirement_fingerprint text not null,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','STALE')),
  version int not null default 1 check (version > 0),
  reviewed_by uuid references auth.users(id) on delete restrict,
  review_reason text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(request_reason) between 3 and 1000),
  check (review_reason is null or length(review_reason) between 3 and 1000),
  check (proposed_start_time < proposed_end_time),
  check (source_start_time < source_end_time),
  check (target_minutes is null or target_minutes >= 0),
  check (jsonb_typeof(proposed_resource_ids) = 'array'),
  check (
    (status = 'PENDING' and reviewed_by is null and review_reason is null and reviewed_at is null)
    or
    (status <> 'PENDING' and reviewed_by is not null and review_reason is not null and reviewed_at is not null)
  )
);
create unique index appointment_reduction_requests_one_pending_idx
  on appointment_reduction_requests(appointment_id) where status='PENDING';
create index appointment_reduction_requests_queue_idx
  on appointment_reduction_requests(status,created_at);
create index appointment_reduction_requests_patient_idx
  on appointment_reduction_requests(patient_id,created_at desc);
create trigger appointment_reduction_requests_set_updated_at
before update on appointment_reduction_requests
for each row execute function set_updated_at();

alter table appointment_reduction_requests enable row level security;
create policy "scoped reduction request read"
on appointment_reduction_requests for select to authenticated
using (
  current_app_role() in ('SCHEDULER','CLINICAL')
  and can_access_patient(patient_id)
);
grant select on appointment_reduction_requests to authenticated;
revoke insert,update,delete on appointment_reduction_requests from authenticated;

-- Preserve the established signature. The return value now distinguishes an
-- applied routine change from a reduction queued for clinical review.
create or replace function update_appointment_booking(
  p_appointment_id uuid,
  p_provider_id uuid,
  p_location_id uuid,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_status appointment_status,
  p_flexibility scheduling_flexibility,
  p_resource_ids jsonb,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path=public,extensions as $update_booking$
declare
  v_actor uuid:=auth.uid();
  v_actor_role app_role:=current_app_role();
  v_target appointments%rowtype;
  v_patient_timezone text;
  v_existing_resources jsonb;
  v_requested_resources jsonb;
  v_source_date date;
  v_proposed_date date;
  v_source_week_start date;
  v_proposed_week_start date;
  v_before_minutes int:=0;
  v_after_minutes int:=0;
  v_target_minutes int;
  v_required_service boolean:=false;
  v_requirement_fingerprint text;
  v_requires_review boolean:=false;
  v_pending appointment_reduction_requests%rowtype;
  v_request_id uuid;
begin
  if v_actor is null or v_actor_role is null
    or v_actor_role not in ('SCHEDULER','CLINICAL') then
    raise exception 'You do not have permission to update appointments';
  end if;
  if p_status is null or p_status not in ('SCHEDULED','CONFIRMED','COMPLETED') then
    raise exception 'Cancellation, restoration, and no-show transitions require their dedicated workflow';
  end if;
  if p_start_time is null or p_end_time is null or p_start_time>=p_end_time then
    raise exception 'Appointment end must be after start';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'A change reason between 3 and 1000 characters is required';
  end if;
  if jsonb_typeof(coalesce(p_resource_ids,'[]'::jsonb))<>'array'
    or jsonb_array_length(coalesce(p_resource_ids,'[]'::jsonb))>20 then
    raise exception 'Resource assignments are invalid';
  end if;

  select * into v_target from appointments a where a.id=p_appointment_id for update;
  if not found then raise exception 'Appointment no longer exists'; end if;
  if v_target.status not in ('SCHEDULED','CONFIRMED') then
    raise exception 'This appointment lifecycle state requires its dedicated workflow';
  end if;
  if not can_access_patient(v_target.patient_id) then
    raise exception 'Patient is outside your permitted caseload';
  end if;

  select p.timezone into v_patient_timezone from patients p where p.id=v_target.patient_id;
  v_patient_timezone:=coalesce(v_patient_timezone,'America/New_York');
  v_source_date:=(v_target.start_time at time zone v_patient_timezone)::date;
  v_proposed_date:=(p_start_time at time zone v_patient_timezone)::date;
  v_source_week_start:=v_source_date-extract(dow from v_source_date)::int;
  v_proposed_week_start:=v_proposed_date-extract(dow from v_proposed_date)::int;

  select
    case when max(psr.target_hours_per_week) is null then null
      else round(max(psr.target_hours_per_week)*60)::int end,
    coalesce(bool_or(psr.required),false),
    md5(coalesce(string_agg(
      psr.id::text||':'||coalesce(psr.target_hours_per_week::text,'')||':'||psr.required::text||':'
        ||psr.effective_start::text||':'||coalesce(psr.effective_end::text,''),
      ',' order by psr.id
    ),''))
  into v_target_minutes,v_required_service,v_requirement_fingerprint
  from patient_service_requirements psr
  where psr.patient_id=v_target.patient_id and psr.service_id=v_target.service_id
    and psr.effective_start<=v_source_date
    and (psr.effective_end is null or psr.effective_end>=v_source_date);

  select coalesce(round(sum(extract(epoch from (a.end_time-a.start_time))/60))::int,0)
  into v_before_minutes
  from appointments a
  where a.patient_id=v_target.patient_id and a.service_id=v_target.service_id
    and a.status in ('SCHEDULED','CONFIRMED','COMPLETED')
    and ((a.start_time at time zone v_patient_timezone)::date
      - extract(dow from (a.start_time at time zone v_patient_timezone)::date)::int)=v_source_week_start;

  v_after_minutes:=greatest(0,v_before_minutes
    - round(extract(epoch from (v_target.end_time-v_target.start_time))/60)::int
    + case when v_proposed_week_start=v_source_week_start
      then round(extract(epoch from (p_end_time-p_start_time))/60)::int else 0 end);
  v_requires_review:=v_after_minutes<v_before_minutes and (
    (v_target_minutes is not null and v_after_minutes<v_target_minutes)
    or (v_required_service and v_after_minutes=0)
  );

  select coalesce(jsonb_agg(ar.resource_id::text order by ar.resource_id::text),'[]'::jsonb)
  into v_existing_resources from appointment_resources ar
  where ar.appointment_id=p_appointment_id;
  select coalesce(jsonb_agg(x.resource_id order by x.resource_id),'[]'::jsonb)
  into v_requested_resources
  from (
    select distinct value resource_id
    from jsonb_array_elements_text(coalesce(p_resource_ids,'[]'::jsonb)) values_list(value)
  ) x;

  if v_actor_role='SCHEDULER' and v_requires_review then
    select * into v_pending from appointment_reduction_requests rr
    where rr.appointment_id=p_appointment_id and rr.status='PENDING' for update;
    if found then
      if v_pending.source_appointment_updated_at=v_target.updated_at
        and v_pending.proposed_provider_id is not distinct from p_provider_id
        and v_pending.proposed_location_id is not distinct from p_location_id
        and v_pending.proposed_start_time=p_start_time
        and v_pending.proposed_end_time=p_end_time
        and v_pending.proposed_status=p_status
        and v_pending.proposed_flexibility=p_flexibility
        and v_pending.proposed_resource_ids=v_requested_resources then
        return jsonb_build_object(
          'appointment_id',p_appointment_id,'status','PENDING_REVIEW',
          'request_id',v_pending.id,'already_pending',true
        );
      end if;
      raise exception 'This appointment already has a pending clinical reduction review';
    end if;

    insert into appointment_reduction_requests(
      appointment_id,patient_id,service_id,requested_by,request_reason,
      proposed_provider_id,proposed_location_id,proposed_start_time,proposed_end_time,
      proposed_status,proposed_flexibility,proposed_resource_ids,
      source_appointment_updated_at,source_start_time,source_end_time,source_week_start,
      scheduled_minutes_before,scheduled_minutes_after,target_minutes,required_service,
      clinical_requirement_fingerprint
    ) values(
      p_appointment_id,v_target.patient_id,v_target.service_id,v_actor,trim(p_reason),
      p_provider_id,p_location_id,p_start_time,p_end_time,p_status,p_flexibility,v_requested_resources,
      v_target.updated_at,v_target.start_time,v_target.end_time,v_source_week_start,
      v_before_minutes,v_after_minutes,v_target_minutes,v_required_service,
      v_requirement_fingerprint
    ) returning id into v_request_id;

    insert into audit_log(user_id,action,patient_id,appointment_id,old_values,new_values,override_reason)
    values(v_actor,'APPOINTMENT_REDUCTION_REQUESTED',v_target.patient_id,p_appointment_id,
      jsonb_build_object('start_time',v_target.start_time,'end_time',v_target.end_time,'scheduled_minutes',v_before_minutes),
      jsonb_build_object('request_id',v_request_id,'start_time',p_start_time,'end_time',p_end_time,
        'scheduled_minutes',v_after_minutes,'target_minutes',v_target_minutes,'required_service',v_required_service),
      trim(p_reason));

    insert into notifications(user_id,kind,title,body,href,severity,dedupe_key,expires_at)
    select up.user_id,'CLINICAL_REDUCTION_REVIEW','Care reduction needs review',
      'Open the secure clinical queue to approve or reject a proposed schedule reduction.',
      '/reductions','WARNING','clinical-reduction-'||v_request_id,p_start_time
    from user_profiles up
    where up.active and up.role='CLINICAL' and exists(
      select 1 from patient_care_team pct
      where pct.patient_id=v_target.patient_id and pct.provider_id=up.provider_id
        and pct.active and pct.effective_start<=current_date
        and (pct.effective_end is null or pct.effective_end>=current_date)
    )
    on conflict(user_id,dedupe_key) where user_id is not null and dedupe_key is not null do nothing;

    return jsonb_build_object(
      'appointment_id',p_appointment_id,'status','PENDING_REVIEW',
      'request_id',v_request_id,'already_pending',false
    );
  end if;

  update appointments set
    provider_id=p_provider_id,location_id=p_location_id,start_time=p_start_time,end_time=p_end_time,
    status=p_status,scheduling_flexibility=p_flexibility,last_change_reason=trim(p_reason)
  where id=p_appointment_id;

  if v_existing_resources is distinct from v_requested_resources then
    delete from appointment_resources where appointment_id=p_appointment_id;
    insert into appointment_resources(appointment_id,resource_id)
    select p_appointment_id,value::uuid
    from jsonb_array_elements_text(v_requested_resources) values_list(value)
    order by value::uuid;
  end if;

  if v_actor_role='CLINICAL' and v_requires_review then
    insert into audit_log(user_id,action,patient_id,appointment_id,old_values,new_values,override_reason)
    values(v_actor,'APPOINTMENT_REDUCTION_DIRECTLY_APPROVED',v_target.patient_id,p_appointment_id,
      jsonb_build_object('scheduled_minutes',v_before_minutes,'start_time',v_target.start_time,'end_time',v_target.end_time),
      jsonb_build_object('scheduled_minutes',v_after_minutes,'target_minutes',v_target_minutes,
        'start_time',p_start_time,'end_time',p_end_time,'required_service',v_required_service),
      trim(p_reason));
  end if;

  return jsonb_build_object(
    'appointment_id',p_appointment_id,'status','APPLIED','updated',true,
    'clinical_reduction',v_requires_review
  );
end
$update_booking$;
revoke all on function update_appointment_booking(uuid,uuid,uuid,timestamptz,timestamptz,appointment_status,scheduling_flexibility,jsonb,text) from public;
grant execute on function update_appointment_booking(uuid,uuid,uuid,timestamptz,timestamptz,appointment_status,scheduling_flexibility,jsonb,text) to authenticated;

create or replace function decide_appointment_reduction(
  p_request_id uuid,
  p_expected_version int,
  p_decision text,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path=public,extensions as $decide_reduction$
declare
  v_actor uuid:=auth.uid();
  v_decision text:=upper(trim(coalesce(p_decision,'')));
  v_request appointment_reduction_requests%rowtype;
  v_target appointments%rowtype;
  v_existing_resources jsonb;
  v_patient_timezone text;
  v_current_requirement_fingerprint text;
begin
  if v_actor is null or current_app_role()<>'CLINICAL' then
    raise exception 'Clinical supervisor access required';
  end if;
  if p_expected_version is null or p_expected_version<1 then
    raise exception 'A valid reduction request version is required';
  end if;
  if v_decision not in ('APPROVED','REJECTED') then
    raise exception 'Decision must be APPROVED or REJECTED';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then
    raise exception 'A clinical decision reason between 3 and 1000 characters is required';
  end if;

  select * into v_request from appointment_reduction_requests rr
  where rr.id=p_request_id for update;
  if not found then raise exception 'Reduction request was not found'; end if;
  if not can_access_patient(v_request.patient_id) then
    raise exception 'Patient is outside your permitted caseload';
  end if;
  if v_request.version=p_expected_version+1 and v_request.status=v_decision
    and v_request.reviewed_by=v_actor and v_request.review_reason=trim(p_reason) then
    return jsonb_build_object(
      'request_id',v_request.id,'appointment_id',v_request.appointment_id,
      'status',v_request.status,'already_decided',true
    );
  end if;
  if v_request.version<>p_expected_version then
    raise exception 'Reduction request changed; refresh before deciding';
  end if;
  if v_request.status<>'PENDING' then
    raise exception 'Reduction request is already decided';
  end if;

  if v_decision='REJECTED' then
    update appointment_reduction_requests set status='REJECTED',version=version+1,
      reviewed_by=v_actor,review_reason=trim(p_reason),reviewed_at=now()
    where id=v_request.id;

    insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
    values(v_actor,'APPOINTMENT_REDUCTION_REJECTED',v_request.patient_id,v_request.appointment_id,
      jsonb_build_object('request_id',v_request.id,'scheduled_minutes_after',v_request.scheduled_minutes_after,
        'target_minutes',v_request.target_minutes),trim(p_reason));
  else
    select * into v_target from appointments a where a.id=v_request.appointment_id for update;
    if not found then raise exception 'Appointment no longer exists'; end if;
    select p.timezone into v_patient_timezone from patients p where p.id=v_request.patient_id;
    v_patient_timezone:=coalesce(v_patient_timezone,'America/New_York');
    select md5(coalesce(string_agg(
      psr.id::text||':'||coalesce(psr.target_hours_per_week::text,'')||':'||psr.required::text||':'
        ||psr.effective_start::text||':'||coalesce(psr.effective_end::text,''),
      ',' order by psr.id
    ),''))
    into v_current_requirement_fingerprint
    from patient_service_requirements psr
    where psr.patient_id=v_request.patient_id and psr.service_id=v_request.service_id
      and psr.effective_start<=(v_request.source_start_time at time zone v_patient_timezone)::date
      and (psr.effective_end is null
        or psr.effective_end>=(v_request.source_start_time at time zone v_patient_timezone)::date);
    if v_target.updated_at<>v_request.source_appointment_updated_at
      or v_target.status not in ('SCHEDULED','CONFIRMED')
      or v_current_requirement_fingerprint<>v_request.clinical_requirement_fingerprint then
      update appointment_reduction_requests set status='STALE',version=version+1,
        reviewed_by=v_actor,review_reason=trim(p_reason),reviewed_at=now()
      where id=v_request.id;
      insert into audit_log(user_id,action,patient_id,appointment_id,new_values,override_reason)
      values(v_actor,'APPOINTMENT_REDUCTION_STALE',v_request.patient_id,v_request.appointment_id,
        jsonb_build_object('request_id',v_request.id),trim(p_reason));
      return jsonb_build_object(
        'request_id',v_request.id,'appointment_id',v_request.appointment_id,
        'status','STALE','already_decided',false
      );
    end if;

    select coalesce(jsonb_agg(ar.resource_id::text order by ar.resource_id::text),'[]'::jsonb)
    into v_existing_resources from appointment_resources ar
    where ar.appointment_id=v_target.id;

    update appointments set
      provider_id=v_request.proposed_provider_id,
      location_id=v_request.proposed_location_id,
      start_time=v_request.proposed_start_time,
      end_time=v_request.proposed_end_time,
      status=v_request.proposed_status,
      scheduling_flexibility=v_request.proposed_flexibility,
      last_change_reason=trim(p_reason)
    where id=v_target.id;

    if v_existing_resources is distinct from v_request.proposed_resource_ids then
      delete from appointment_resources where appointment_id=v_target.id;
      insert into appointment_resources(appointment_id,resource_id)
      select v_target.id,value::uuid
      from jsonb_array_elements_text(v_request.proposed_resource_ids) values_list(value)
      order by value::uuid;
    end if;

    update appointment_reduction_requests set status='APPROVED',version=version+1,
      reviewed_by=v_actor,review_reason=trim(p_reason),reviewed_at=now()
    where id=v_request.id;

    insert into audit_log(user_id,action,patient_id,appointment_id,old_values,new_values,override_reason)
    values(v_actor,'APPOINTMENT_REDUCTION_APPROVED',v_request.patient_id,v_request.appointment_id,
      jsonb_build_object('start_time',v_target.start_time,'end_time',v_target.end_time,
        'scheduled_minutes',v_request.scheduled_minutes_before),
      jsonb_build_object('request_id',v_request.id,'start_time',v_request.proposed_start_time,
        'end_time',v_request.proposed_end_time,'scheduled_minutes',v_request.scheduled_minutes_after,
        'target_minutes',v_request.target_minutes),trim(p_reason));
  end if;

  insert into notifications(user_id,kind,title,body,href,severity,dedupe_key)
  values(
    v_request.requested_by,'CLINICAL_REDUCTION_DECISION',
    case when v_decision='APPROVED' then 'Care reduction approved' else 'Care reduction rejected' end,
    'Open the secure appointment record to review the clinical decision.',
    '/appointments/'||v_request.appointment_id,
    case when v_decision='APPROVED' then 'INFO' else 'WARNING' end,
    'clinical-reduction-decision-'||v_request.id
  )
  on conflict(user_id,dedupe_key) where user_id is not null and dedupe_key is not null do nothing;

  return jsonb_build_object(
    'request_id',v_request.id,'appointment_id',v_request.appointment_id,
    'status',v_decision,'already_decided',false
  );
end
$decide_reduction$;
revoke all on function decide_appointment_reduction(uuid,int,text,text) from public;
grant execute on function decide_appointment_reduction(uuid,int,text,text) to authenticated;

create or replace function app_schema_status()
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $status$
  select jsonb_build_object(
    'ready',true,'version','20261022010000',
    'optimizer_approval',to_regprocedure('public.approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text)') is not null,
    'optimizer_moves',to_regprocedure('public.approve_optimization_plan_with_move(uuid,date,date,text,jsonb,jsonb,jsonb,text)') is not null,
    'optimizer_decisions',to_regprocedure('public.record_optimization_plan_decision(uuid,date,date,text,text,text,timestamp with time zone,jsonb)') is not null
      and to_regclass('public.optimization_plan_decisions') is not null,
    'clinical_reductions',to_regclass('public.appointment_reduction_requests') is not null
      and to_regprocedure('public.decide_appointment_reduction(uuid,integer,text,text)') is not null,
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
