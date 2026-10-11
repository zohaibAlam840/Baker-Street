-- Forward-only repairs for enum CASE expressions in communications functions.
begin;

create or replace function set_contact_channel_consent(
  p_contact_id uuid,
  p_channel communication_channel,
  p_granted boolean,
  p_source text,
  p_expected_version int,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $set_consent$
declare
  v_actor uuid:=auth.uid();
  v_contact patient_contacts%rowtype;
  v_consent communication_consents%rowtype;
  v_prior_status communication_consent_status;
  v_source text:=trim(coalesce(p_source,''));
  v_payload jsonb;
  v_hash text;
  v_existing communication_idempotency%rowtype;
  v_result jsonb;
  v_destination text;
  v_fingerprint text;
begin
  if v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER' then
    raise exception 'Only schedulers may change communication consent';
  end if;
  if length(v_source) not between 2 and 120 then raise exception 'Consent source is required'; end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;
  v_payload:=jsonb_build_object('contact_id',p_contact_id,'channel',p_channel,
    'granted',p_granted,'source',v_source,'expected_version',p_expected_version);
  v_hash:=md5(v_payload::text);
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':SET_CONSENT:'||trim(p_idempotency_key),0));
  select * into v_existing from communication_idempotency i
  where i.actor_key=v_actor::text and i.operation='SET_CONSENT'
    and i.idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.request_hash<>v_hash then
      raise exception 'Idempotency key was already used for a different consent request';
    end if;
    return v_existing.result||jsonb_build_object('already_applied',true);
  end if;

  select * into v_contact from patient_contacts pc where pc.id=p_contact_id;
  if not found then raise exception 'Contact was not found'; end if;
  v_destination:=communication_destination(v_contact,p_channel);
  if p_granted and v_destination is null then
    raise exception 'Contact has no destination for this channel';
  end if;
  if v_destination is not null then
    v_fingerprint:=communication_destination_fingerprint(p_channel,v_destination);
    perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_DESTINATION:'||v_fingerprint,0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('COMMUNICATION_CONTACT:'||p_contact_id::text,0));
  select * into v_contact from patient_contacts pc where pc.id=p_contact_id for update;
  if p_granted and communication_destination_fingerprint(
      p_channel,communication_destination(v_contact,p_channel)
    ) is distinct from v_fingerprint then
    raise exception 'Contact destination changed; retry consent update';
  end if;
  if p_granted and (not v_contact.active or not v_contact.authorized_to_receive_information) then
    raise exception 'Contact is not authorized to receive information';
  end if;
  if p_granted and v_contact.relationship_verified_at is null then
    raise exception 'Contact relationship must be verified before consent is granted';
  end if;
  if p_granted and exists(
    select 1 from communication_destination_suppressions s
    where s.channel=p_channel and s.destination_fingerprint=v_fingerprint
  ) then
    if upper(v_source) not in ('VERIFIED_RECONSENT','SIGNED_RECONSENT') then
      raise exception 'Verified re-consent is required for this suppressed destination';
    end if;
    delete from communication_destination_suppressions
    where channel=p_channel and destination_fingerprint=v_fingerprint;
  end if;
  select * into v_consent from communication_consents c
  where c.patient_contact_id=p_contact_id and c.channel=p_channel for update;
  if found then
    if p_expected_version is null or p_expected_version<>v_consent.version then
      raise exception 'Consent changed; refresh before saving';
    end if;
    if p_granted and v_consent.status='REVOKED'
      and upper(v_consent.source) in ('STOP','UNSUBSCRIBE','PROVIDER_OPT_OUT','PROVIDER_COMPLAINT','HARD_BOUNCE')
      and upper(v_source) not in ('VERIFIED_RECONSENT','SIGNED_RECONSENT') then
      raise exception 'Verified re-consent is required after an opt-out, complaint, or hard bounce';
    end if;
    v_prior_status:=v_consent.status;
    update communication_consents set
      status=case
        when p_granted then 'GRANTED'::communication_consent_status
        else 'REVOKED'::communication_consent_status
      end,
      source=v_source,
      granted_at=case when p_granted then now() else granted_at end,
      revoked_at=case when p_granted then null else now() end,
      changed_by=v_actor,version=version+1
    where id=v_consent.id returning * into v_consent;
  else
    if coalesce(p_expected_version,0)<>0 then
      raise exception 'New consent must not include an existing version';
    end if;
    insert into communication_consents(
      patient_contact_id,patient_id,channel,status,source,granted_at,revoked_at,changed_by
    ) values(
      v_contact.id,v_contact.patient_id,p_channel,
      case
        when p_granted then 'GRANTED'::communication_consent_status
        else 'REVOKED'::communication_consent_status
      end,v_source,
      case when p_granted then now() else null end,
      case when p_granted then null else now() end,v_actor
    ) returning * into v_consent;
    v_prior_status:=null;
  end if;
  insert into communication_consent_events(
    consent_id,patient_id,patient_contact_id,channel,prior_status,new_status,source,changed_by
  ) values(
    v_consent.id,v_contact.patient_id,v_contact.id,p_channel,v_prior_status,v_consent.status,v_source,v_actor
  );
  if not p_granted then
    update communication_jobs set cancelled_at=now(),cancelled_by=v_actor,
      cancellation_reason='Recipient consent revoked',
      status=case
        when status='PROCESSING' then status
        else 'CANCELLED'::communication_job_status
      end,
      processing_token=case when status='PROCESSING' then processing_token else null end,
      processing_worker=case when status='PROCESSING' then processing_worker else null end,
      processing_started_at=case when status='PROCESSING' then processing_started_at else null end,
      version=version+1
    where patient_contact_id=v_contact.id and channel=p_channel
      and status in ('QUEUED','PROCESSING','FAILED');
  end if;
  insert into audit_log(user_id,action,patient_id,new_values)
  values(v_actor,'COMMUNICATION_CONSENT_CHANGED',v_contact.patient_id,jsonb_build_object(
    'contact_id',v_contact.id,'channel',p_channel,'status',v_consent.status,
    'consent_version',v_consent.version,'source',v_source
  ));
  v_result:=jsonb_build_object(
    'consent_id',v_consent.id,'consent_version',v_consent.version,
    'contact_id',v_contact.id,'channel',p_channel,'status',v_consent.status,
    'already_applied',false
  );
  insert into communication_idempotency(actor_key,operation,idempotency_key,request_hash,result)
  values(v_actor::text,'SET_CONSENT',trim(p_idempotency_key),v_hash,v_result);
  return v_result;
end
$set_consent$;

create or replace function sync_appointment_reminders(p_appointment_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $sync_one$
declare
  v_actor uuid:=auth.uid();
  v_service boolean:=coalesce(auth.role()='service_role',false);
  v_appointment appointments%rowtype;
  v_rec record;
  v_target timestamptz;
  v_allowed timestamptz;
  v_dedupe text;
  v_ensured int:=0;
  v_cancelled int:=0;
  v_has_primary boolean:=false;
begin
  if not v_service and (v_actor is null or current_app_role() is null or current_app_role()<>'SCHEDULER') then
    raise exception 'Only schedulers or the communication worker may sync reminders';
  end if;
  select * into v_appointment from appointments a where a.id=p_appointment_id for update;
  if not found then raise exception 'Appointment was not found'; end if;

  update communication_jobs j set cancelled_at=now(),cancelled_by=v_actor,
    cancellation_reason='Reminder source or recipient preference changed',
    status=case
      when j.status='PROCESSING' then j.status
      else 'CANCELLED'::communication_job_status
    end,
    processing_token=case when j.status='PROCESSING' then j.processing_token else null end,
    processing_worker=case when j.status='PROCESSING' then j.processing_worker else null end,
    processing_started_at=case when j.status='PROCESSING' then j.processing_started_at else null end,
    version=j.version+1
  where j.appointment_id=v_appointment.id and j.message_type='APPOINTMENT_REMINDER'
    and j.status in ('QUEUED','PROCESSING','FAILED') and (
      v_appointment.status not in ('SCHEDULED','CONFIRMED') or v_appointment.start_time<=now()
      or j.source_entity_version<>v_appointment.updated_at::text
      or not exists(
        select 1 from patient_contacts pc join communication_consents cc
          on cc.patient_contact_id=pc.id and cc.channel=j.channel
        where pc.id=j.patient_contact_id and pc.patient_id=v_appointment.patient_id
          and pc.active and pc.relationship_verified_at is not null
          and pc.authorized_to_receive_information
          and cc.status='GRANTED' and pc.version=j.source_contact_version
          and cc.version=j.source_consent_version
          and communication_destination(pc,j.channel) is not null
      )
    );
  get diagnostics v_cancelled=row_count;
  if v_appointment.status not in ('SCHEDULED','CONFIRMED') or v_appointment.start_time<=now() then
    return jsonb_build_object('appointment_id',v_appointment.id,'ensured_count',0,
      'cancelled_count',v_cancelled,'active',false);
  end if;

  for v_rec in
    select pc.*,cc.channel,cc.version as consent_version,reminder.offset_name,reminder.offset_value
    from patient_contacts pc
    join communication_consents cc on cc.patient_contact_id=pc.id and cc.patient_id=pc.patient_id
    cross join (values('24h',interval '24 hours'),('2h',interval '2 hours')) reminder(offset_name,offset_value)
    where pc.patient_id=v_appointment.patient_id and pc.active and pc.is_primary
      and pc.relationship_verified_at is not null
      and pc.relationship_effective_start<=current_date
      and (pc.relationship_effective_end is null or pc.relationship_effective_end>=current_date)
      and pc.authorized_to_receive_information and cc.status='GRANTED'
      and communication_destination(pc,cc.channel) is not null
    order by pc.is_primary desc,pc.id,cc.channel,reminder.offset_value desc
  loop
    v_has_primary:=true;
    -- Do not collapse multiple missed offsets into duplicate immediate sends.
    -- A scheduler can still use the explicit one-off reminder command when a
    -- clinically appropriate catch-up message is needed.
    if v_appointment.start_time-v_rec.offset_value<=now() then continue; end if;
    v_target:=v_appointment.start_time-v_rec.offset_value;
    v_allowed:=communication_allowed_time(v_target,v_rec.timezone,v_rec.quiet_hours_start,v_rec.quiet_hours_end);
    if v_allowed>=v_appointment.start_time then continue; end if;
    v_dedupe:='appt-sync:'||v_appointment.id||':'||md5(v_appointment.updated_at::text)||':'||
      v_rec.id||':'||v_rec.channel||':'||v_rec.offset_name||':c'||v_rec.version||':s'||v_rec.consent_version;
    perform enqueue_communication_job_internal(
      v_appointment.patient_id,v_rec.id,v_appointment.id,null,null,'APPOINTMENT_REMINDER',
      v_rec.channel,v_allowed,v_appointment.updated_at::text,v_appointment.start_time,
      v_dedupe,v_actor
    );
    v_ensured:=v_ensured+1;
  end loop;
  return jsonb_build_object('appointment_id',v_appointment.id,'ensured_count',v_ensured,
    'cancelled_count',v_cancelled,'active',true,'needs_manual_review',not v_has_primary);
end
$sync_one$;

revoke all on function sync_appointment_reminders(uuid) from public;
grant execute on function sync_appointment_reminders(uuid) to authenticated,service_role;

create or replace function prepare_communication_delivery(p_job_id uuid,p_processing_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $prepare$
declare
  v_job communication_jobs%rowtype;
  v_contact patient_contacts%rowtype;
  v_consent communication_consents%rowtype;
  v_appointment appointments%rowtype;
  v_case recovery_cases%rowtype;
  v_offer recovery_offers%rowtype;
  v_allowed timestamptz;
  v_destination text;
  v_invalid text;
  v_disruption_id uuid;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  select * into v_job from communication_jobs where id=p_job_id;
  if not found then raise exception 'Communication job was not found'; end if;
  if v_job.recovery_case_id is not null then
    select disruption_id into v_disruption_id from recovery_cases where id=v_job.recovery_case_id;
    if found then
      perform pg_advisory_xact_lock(hashtextextended('RECOVERY_DISRUPTION:'||v_disruption_id::text,0));
    end if;
  end if;
  select * into v_job from communication_jobs where id=p_job_id for update;
  if not found or v_job.status<>'PROCESSING' or v_job.processing_token is distinct from p_processing_token then
    raise exception 'Communication lease is invalid';
  end if;
  if v_job.processing_started_at<now()-interval '5 minutes' then v_invalid:='LEASE_EXPIRED'; end if;
  if v_job.cancelled_at is not null then v_invalid:='CANCELLED_BEFORE_SEND'; end if;
  if v_job.expires_at<=now() then v_invalid:='EXPIRED_BEFORE_SEND'; end if;
  if not exists(select 1 from communication_delivery_config where singleton and delivery_mode='LIVE') then
    v_invalid:='RECORD_ONLY_MODE';
  end if;
  -- Source rows are snapshot reads. Holding the job lock while also locking a
  -- contact/appointment would invert the mutation paths (source -> job), and
  -- those locks would be released before the external provider call anyway.
  select * into v_contact from patient_contacts where id=v_job.patient_contact_id;
  if not found or v_contact.patient_id<>v_job.patient_id or not v_contact.active
    or v_contact.relationship_verified_at is null
    or v_contact.relationship_effective_start>current_date
    or (v_contact.relationship_effective_end is not null and v_contact.relationship_effective_end<current_date)
    or not v_contact.authorized_to_receive_information
    or v_contact.version<>v_job.source_contact_version then
    v_invalid:='CONTACT_CHANGED';
  end if;
  if v_invalid is null then
    select * into v_consent from communication_consents
    where patient_contact_id=v_contact.id and channel=v_job.channel;
    if not found or v_consent.status<>'GRANTED' or v_consent.patient_id<>v_job.patient_id
      or v_consent.version<>v_job.source_consent_version then
      v_invalid:='CONSENT_CHANGED';
    end if;
  end if;
  if v_invalid is null then
    v_destination:=communication_destination(v_contact,v_job.channel);
    if v_destination is null then v_invalid:='DESTINATION_MISSING'; end if;
  end if;
  if v_invalid is null and communication_destination_fingerprint(
      v_job.channel,v_destination
    ) is distinct from v_job.destination_fingerprint then
    v_invalid:='DESTINATION_CHANGED';
  end if;
  if v_invalid is null and exists(
    select 1 from communication_destination_suppressions s
    where s.channel=v_job.channel
      and s.destination_fingerprint=v_job.destination_fingerprint
  ) then
    v_invalid:='DESTINATION_SUPPRESSED';
  end if;
  if v_invalid is null and v_job.message_type='APPOINTMENT_REMINDER' then
    select * into v_appointment from appointments where id=v_job.appointment_id;
    if not found or v_appointment.patient_id<>v_job.patient_id
      or v_appointment.status not in ('SCHEDULED','CONFIRMED')
      or v_appointment.start_time<=now()
      or v_appointment.updated_at::text<>v_job.source_entity_version then
      v_invalid:='APPOINTMENT_CHANGED';
    end if;
  elsif v_invalid is null and v_job.message_type in ('RECOVERY_OFFER','RECOVERY_UPDATE') then
    select * into v_case from recovery_cases where id=v_job.recovery_case_id;
    if not found or v_case.patient_id<>v_job.patient_id then
      v_invalid:='RECOVERY_CASE_CHANGED';
    elsif v_job.message_type='RECOVERY_UPDATE' and 'case:'||v_case.version<>v_job.source_entity_version then
      v_invalid:='RECOVERY_CASE_CHANGED';
    elsif v_job.message_type='RECOVERY_OFFER' then
      select * into v_offer from recovery_offers where id=v_job.recovery_offer_id;
      if v_case.status<>'OFFERED' or not found or v_offer.recovery_case_id<>v_case.id or v_offer.status<>'PENDING'
        or v_offer.expires_at<=now()
        or 'case:'||v_case.version||';offer:'||v_offer.version<>v_job.source_entity_version then
        v_invalid:='RECOVERY_OFFER_CHANGED';
      end if;
    end if;
  end if;
  if v_invalid is not null then
    update communication_jobs set
      status=case
        when v_invalid like 'EXPIRED%' then 'EXPIRED'::communication_job_status
        else 'SUPPRESSED'::communication_job_status
      end,
      last_error_category=v_invalid,processing_token=null,processing_worker=null,
      processing_started_at=null,version=version+1
    where id=v_job.id;
    return jsonb_build_object('ready',false,'job_id',v_job.id,
      'status',case when v_invalid like 'EXPIRED%' then 'EXPIRED' else 'SUPPRESSED' end,
      'reason',v_invalid);
  end if;
  v_allowed:=communication_allowed_time(now(),v_contact.timezone,
    v_contact.quiet_hours_start,v_contact.quiet_hours_end);
  if v_allowed>now()+interval '5 seconds' then
    if v_allowed>=v_job.expires_at then
      update communication_jobs set status='SUPPRESSED',last_error_category='QUIET_HOURS_PAST_EXPIRY',
        processing_token=null,processing_worker=null,processing_started_at=null,version=version+1
      where id=v_job.id;
      return jsonb_build_object('ready',false,'job_id',v_job.id,'status','SUPPRESSED','reason','QUIET_HOURS_PAST_EXPIRY');
    end if;
    update communication_jobs set status='QUEUED',scheduled_for=v_allowed,next_attempt_at=v_allowed,
      last_error_category=null,processing_token=null,processing_worker=null,processing_started_at=null,
      attempt_count=greatest(0,attempt_count-1),version=version+1
    where id=v_job.id;
    return jsonb_build_object('ready',false,'job_id',v_job.id,'status','QUEUED',
      'scheduled_for',v_allowed,'reason','QUIET_HOURS');
  end if;
  return jsonb_build_object(
    'ready',true,'job_id',v_job.id,'processing_token',v_job.processing_token,
    'attempt_number',v_job.attempt_count,'channel',v_job.channel,
    'destination',v_destination,'destination_hash',v_job.destination_fingerprint,
    'message_type',v_job.message_type,
    'subject',v_job.subject_snapshot,'body',v_job.body_snapshot,
    'expires_at',v_job.expires_at
  );
end
$prepare$;

revoke all on function prepare_communication_delivery(uuid,uuid) from public,anon,authenticated;
grant execute on function prepare_communication_delivery(uuid,uuid) to service_role;

create or replace function record_communication_delivery_outcome(
  p_job_id uuid,p_processing_token uuid,p_provider text,p_provider_message_id text,
  p_outcome communication_attempt_outcome,p_error_category text,p_http_status int,
  p_destination_hash text,p_started_at timestamptz,p_completed_at timestamptz,p_metadata jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $record_outcome$
declare
  v_job communication_jobs%rowtype;
  v_attempt_id bigint;
  v_status communication_job_status;
  v_retry_at timestamptz;
  v_metadata jsonb;
  v_contact patient_contacts%rowtype;
  v_consent communication_consents%rowtype;
  v_receipt communication_delivery_receipts%rowtype;
  v_lease_started_at timestamptz;
  v_invalid text;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  if p_processing_token is null
    or length(trim(coalesce(p_provider,''))) not between 2 and 80
    or p_destination_hash !~ '^[A-Fa-f0-9]{64}$'
    or p_completed_at<p_started_at or p_completed_at>now()+interval '5 minutes' then
    raise exception 'Delivery outcome payload is invalid';
  end if;
  select * into v_job from communication_jobs where id=p_job_id for update;
  if not found then raise exception 'Communication job was not found'; end if;
  if v_job.status<>'PROCESSING' or v_job.processing_token is distinct from p_processing_token then
    -- Safe replay after a worker lost the response.
    select id into v_attempt_id from communication_delivery_attempts
    where communication_job_id=p_job_id
      and processing_token_hash=encode(sha256(convert_to(p_processing_token::text,'UTF8')),'hex');
    if found then return jsonb_build_object('job_id',v_job.id,'attempt_id',v_attempt_id,
      'status',v_job.status,'already_applied',true); end if;
    raise exception 'Communication lease is invalid';
  end if;
  if lower(p_destination_hash)<>v_job.destination_fingerprint then
    raise exception 'Delivery destination fingerprint does not match the claimed job';
  end if;
  v_lease_started_at:=v_job.processing_started_at;
  if v_job.cancelled_at is not null then v_invalid:='CANCELLED_DURING_DELIVERY'; end if;
  select * into v_contact from patient_contacts where id=v_job.patient_contact_id;
  if not found or not v_contact.active or v_contact.relationship_verified_at is null
    or not v_contact.authorized_to_receive_information
    or v_contact.relationship_effective_start>current_date
    or (v_contact.relationship_effective_end is not null and v_contact.relationship_effective_end<current_date)
    or v_contact.version<>v_job.source_contact_version then v_invalid:='CONTACT_CHANGED_DURING_DELIVERY'; end if;
  select * into v_consent from communication_consents
  where patient_contact_id=v_job.patient_contact_id and channel=v_job.channel;
  if not found or v_consent.status<>'GRANTED' or v_consent.version<>v_job.source_consent_version then
    v_invalid:='CONSENT_CHANGED_DURING_DELIVERY';
  end if;
  v_metadata:=jsonb_strip_nulls(jsonb_build_object(
    'provider_status',left(coalesce(p_metadata->>'provider_status',''),80),
    'provider_region',left(coalesce(p_metadata->>'provider_region',''),40)
  ));
  insert into communication_delivery_attempts(
    communication_job_id,attempt_number,provider,provider_message_id,outcome,error_category,
    http_status,destination_hash,processing_token_hash,started_at,completed_at,metadata
  ) values(
    v_job.id,v_job.attempt_count,trim(p_provider),nullif(trim(coalesce(p_provider_message_id,'')),''),
    p_outcome,nullif(left(trim(coalesce(p_error_category,'')),100),''),p_http_status,
    lower(p_destination_hash),encode(sha256(convert_to(p_processing_token::text,'UTF8')),'hex'),
    p_started_at,p_completed_at,v_metadata
  ) returning id into v_attempt_id;
  -- A provider webhook can race its API response. Attach any receipts that
  -- arrived during this lease now that the immutable attempt exists.
  update communication_delivery_receipts set communication_attempt_id=v_attempt_id
  where communication_job_id=v_job.id and communication_attempt_id is null
    and recorded_at>=v_lease_started_at;
  v_status:=case
    when v_invalid is not null then 'SUPPRESSED'::communication_job_status
    when p_outcome='DELIVERED' then 'DELIVERED'::communication_job_status
    when p_outcome='ACCEPTED' then 'SENT'::communication_job_status
    else 'FAILED'::communication_job_status
  end;
  if v_invalid is null and p_outcome='TEMPORARY_FAILURE'
    and v_job.attempt_count<v_job.max_attempts then
    -- Deterministic jitter avoids synchronized retry bursts while preserving
    -- idempotent outcomes for a given job attempt.
    v_retry_at:=now()
      +make_interval(mins=>least(60,5*(2^greatest(0,v_job.attempt_count-1))::int))
      +make_interval(secs=>((hashtextextended(v_job.id::text||':'||v_job.attempt_count::text,0)%60+60)%60)::double precision);
    if v_retry_at>=v_job.expires_at then v_retry_at:=v_job.expires_at; end if;
  end if;
  update communication_jobs set status=v_status,
    delivered_at=case when v_status='DELIVERED' then p_completed_at else delivered_at end,
    last_error_category=case when v_invalid is not null then v_invalid
      when v_status='FAILED' then coalesce(nullif(left(trim(coalesce(p_error_category,'')),100),''),p_outcome::text) else null end,
    next_attempt_at=coalesce(v_retry_at,next_attempt_at),
    processing_token=null,processing_worker=null,processing_started_at=null,version=version+1
  where id=v_job.id returning * into v_job;
  -- If a webhook won the race, its provider state is authoritative. Apply the
  -- newest receipt only after the attempt is safely recorded and the lease is
  -- released; delivery can never regress to a non-revocation failure.
  select * into v_receipt from communication_delivery_receipts
  where communication_job_id=v_job.id and recorded_at>=v_lease_started_at
  order by case when receipt_type='DELIVERED' then 1 else 0 end desc,
    occurred_at desc,
    case receipt_type when 'OPT_OUT' then 40 when 'COMPLAINT' then 40
      when 'DELIVERED' then 30 when 'BOUNCED' then 20 when 'FAILED' then 20 else 10 end desc,
    id desc limit 1;
  if found and v_job.cancelled_at is null
    and v_job.status not in ('SUPPRESSED','CANCELLED','EXPIRED')
    and v_receipt.receipt_type not in ('OPT_OUT','COMPLAINT')
    and not (v_receipt.receipt_type='BOUNCED'
      and upper(coalesce(v_receipt.metadata->>'provider_status',''))='HARD_BOUNCE') then
    update communication_jobs set
      status=case
        when v_receipt.receipt_type='DELIVERED' then 'DELIVERED'::communication_job_status
        when v_receipt.receipt_type='ACCEPTED' and status<>'DELIVERED' then 'SENT'::communication_job_status
        when v_receipt.receipt_type in ('BOUNCED','FAILED') and status<>'DELIVERED' then 'FAILED'::communication_job_status
        else status
      end,
      delivered_at=case when v_receipt.receipt_type='DELIVERED'
        then coalesce(delivered_at,v_receipt.occurred_at) else delivered_at end,
      last_error_category=case
        when v_receipt.receipt_type in ('BOUNCED','FAILED') and status<>'DELIVERED'
          then v_receipt.receipt_type::text
        when v_receipt.receipt_type in ('ACCEPTED','DELIVERED') then null
        else last_error_category end,
      version=version+1
    where id=v_job.id returning * into v_job;
  end if;
  return jsonb_build_object('job_id',v_job.id,'job_version',v_job.version,
    'attempt_id',v_attempt_id,'status',v_job.status,'already_applied',false);
end
$record_outcome$;

revoke all on function record_communication_delivery_outcome(uuid,uuid,text,text,communication_attempt_outcome,text,int,text,timestamptz,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function record_communication_delivery_outcome(uuid,uuid,text,text,communication_attempt_outcome,text,int,text,timestamptz,timestamptz,jsonb) to service_role;

create or replace function release_stale_communication_leases(p_limit int)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $release_leases$
declare v_count int;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
  if p_limit not between 1 and 500 then raise exception 'Lease release limit is invalid'; end if;
  with stale as (
    select id from communication_jobs where status='PROCESSING'
      and processing_started_at<now()-interval '5 minutes'
    order by processing_started_at limit p_limit for update skip locked
  )
  update communication_jobs j set
    status=case
      when j.expires_at<=now() then 'EXPIRED'::communication_job_status
      else 'FAILED'::communication_job_status
    end,
    last_error_category='WORKER_LEASE_EXPIRED',processing_token=null,processing_worker=null,
    processing_started_at=null,next_attempt_at=now(),version=j.version+1
  from stale where stale.id=j.id;
  get diagnostics v_count=row_count;
  return jsonb_build_object('released_count',v_count);
end
$release_leases$;

revoke all on function release_stale_communication_leases(int) from public,anon,authenticated;
grant execute on function release_stale_communication_leases(int) to service_role;

create or replace function app_schema_status()
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $status$
  select jsonb_build_object(
    'ready',true,'version','20261011031200',
    'optimizer_approval',to_regprocedure('public.approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text)') is not null,
    'atomic_booking',to_regprocedure('public.create_appointment_series(jsonb,text)') is not null,
    'opaque_conflicts',to_regprocedure('public.optimization_busy_intervals(timestamp with time zone,timestamp with time zone)') is not null,
    'schedule_recovery',to_regclass('public.recovery_cases') is not null
      and to_regprocedure('public.respond_recovery_offer_with_contact(uuid,integer,text,text,uuid,communication_response_channel,uuid,text)') is not null,
    'communications',to_regclass('public.communication_consents') is not null
      and to_regclass('public.communication_jobs') is not null
      and to_regclass('public.communication_destination_suppressions') is not null
      and to_regclass('public.communication_delivery_attempts') is not null
      and to_regprocedure('public.sync_appointment_reminders(uuid)') is not null
      and to_regprocedure('public.prepare_communication_delivery(uuid,uuid)') is not null
  )
$status$;

revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
