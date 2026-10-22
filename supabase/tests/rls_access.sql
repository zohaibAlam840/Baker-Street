begin;
create extension if not exists pgtap with schema extensions;
set local role postgres;
set local search_path = public, extensions;
select plan(239);

select extensions.ok((select bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace and relname = any(array[
  'patients','providers','appointments','authorizations','patient_service_requirements','patient_care_team','audit_log'
])), 'all sensitive representative tables have RLS enabled');

select extensions.ok((select count(*) >= 1 from pg_policies where schemaname='public' and tablename='appointments' and cmd='SELECT'), 'appointments retain their scoped read policy');
select extensions.ok((select count(*) >= 2 from pg_policies where schemaname='public' and tablename='authorizations'), 'authorizations have scoped read and management policies');
select extensions.ok((select count(*) >= 2 from pg_policies where schemaname='public' and tablename='patient_service_requirements'), 'clinical requirements have scoped policies');
select extensions.ok((select count(*) >= 2 from pg_policies where schemaname='public' and tablename='patient_care_team'), 'care-team links have scoped policies');
select extensions.ok((select count(*) >= 1 from pg_policies where schemaname='public' and tablename='audit_log'), 'audit log has an oversight read policy');
select extensions.ok((select count(*) >= 2 from pg_policies where schemaname='public' and tablename='user_profiles'), 'user profiles separate own and admin access');
select extensions.ok((select bool_and(relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relname=any(array['locations','patients','services','service_durations','service_requirements','patient_service_requirements','authorizations','providers','provider_credentials','provider_services','provider_availability','patient_availability','patient_preferences','patient_restrictions','resources','service_resources','appointments','appointment_resources','optimization_requests','optimization_results','optimization_changes','audit_log'])), 'all original 22 domain tables remain protected by RLS');
select extensions.ok((select bool_and(relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relname=any(array['patient_contacts','intake_tasks','provider_supervision','notifications'])), 'new workflow tables have RLS enabled');
select extensions.ok(exists(select 1 from pg_constraint where conname='appointments_patient_no_overlap'), 'patient overlap is blocked in the database');
select extensions.ok(exists(select 1 from pg_constraint where conname='appointments_provider_no_overlap'), 'provider overlap is blocked in the database');
select extensions.ok(exists(select 1 from pg_trigger where tgname='audit_appointment_change_trigger' and not tgisinternal), 'appointment changes are audited by a database trigger');
select extensions.ok((select relrowsecurity from pg_class where oid='push_subscriptions'::regclass), 'push subscriptions have RLS enabled');
select extensions.ok(to_regprocedure('approve_optimization_plan(uuid,date,date,text,jsonb,jsonb,text)') is not null, 'atomic optimizer approval function is installed');
select extensions.ok(to_regprocedure('approve_optimization_plan_with_move(uuid,date,date,text,jsonb,jsonb,jsonb,text)') is not null, 'atomic move-enabled optimizer approval function is installed');
select extensions.ok(has_function_privilege('authenticated','approve_optimization_plan_with_move(uuid,date,date,text,jsonb,jsonb,jsonb,text)','EXECUTE'), 'authorized reviewers can invoke move-enabled approval');
select extensions.ok(position('scheduling_flexibility<>''FLEXIBLE''' in regexp_replace(pg_get_functiondef('approve_optimization_plan_with_move(uuid,date,date,text,jsonb,jsonb,jsonb,text)'::regprocedure),'\s+','','g'))>0, 'optimizer moves are limited to flexible appointments');
select extensions.ok(position('start_time<=now()' in regexp_replace(pg_get_functiondef('approve_optimization_plan_with_move(uuid,date,date,text,jsonb,jsonb,jsonb,text)'::regprocedure),'\s+','','g'))>0, 'optimizer cannot move a visit after it starts');
select extensions.ok((select relrowsecurity from pg_class where oid='optimization_plan_decisions'::regclass), 'optimizer plan decisions have RLS enabled');
select extensions.ok(to_regprocedure('record_optimization_plan_decision(uuid,date,date,text,text,text,timestamptz,jsonb)') is not null, 'optimizer reject/defer command is installed');
select extensions.ok(has_function_privilege('authenticated','record_optimization_plan_decision(uuid,date,date,text,text,text,timestamptz,jsonb)','EXECUTE'), 'authenticated decision owners can invoke reject/defer');
select extensions.ok(not has_table_privilege('authenticated','optimization_plan_decisions','INSERT,UPDATE,DELETE'), 'optimizer decisions cannot bypass the guarded command');
select extensions.ok(exists(select 1 from pg_trigger where tgname='guard_optimization_approval_decision_trigger' and not tgisinternal), 'approval is serialized against reject and defer decisions');
select extensions.ok(to_regprocedure('create_appointment_series(jsonb,text)') is not null, 'atomic recurring booking function is installed');
select extensions.ok(to_regprocedure('update_appointment_booking(uuid,uuid,uuid,timestamptz,timestamptz,appointment_status,scheduling_flexibility,jsonb,text)') is not null, 'atomic appointment update function is installed');
select extensions.ok((select relrowsecurity from pg_class where oid='appointment_reduction_requests'::regclass), 'clinical reduction requests have RLS enabled');
select extensions.ok(to_regprocedure('decide_appointment_reduction(uuid,int,text,text)') is not null, 'clinical reduction decision command is installed');
select extensions.ok(has_function_privilege('authenticated','decide_appointment_reduction(uuid,int,text,text)','EXECUTE'), 'authenticated reviewers can invoke the guarded reduction decision command');
select extensions.ok(not has_table_privilege('authenticated','appointment_reduction_requests','INSERT,UPDATE,DELETE'), 'reduction decisions cannot bypass the guarded commands');
select extensions.ok((select relrowsecurity from pg_class where oid='provider_time_off_requests'::regclass), 'provider time-off requests have RLS enabled');
select extensions.ok(to_regprocedure('request_provider_time_off(uuid,timestamptz,timestamptz,text,text,text)') is not null, 'provider time-off request command is installed');
select extensions.ok(to_regprocedure('decide_provider_time_off_request(uuid,int,text,text)') is not null, 'provider time-off decision command is installed');
select extensions.ok(to_regprocedure('cancel_provider_time_off_request(uuid,int,text)') is not null, 'provider time-off cancellation command is installed');
select extensions.ok(has_function_privilege('authenticated','request_provider_time_off(uuid,timestamptz,timestamptz,text,text,text)','EXECUTE'), 'authenticated providers can invoke the guarded request command');
select extensions.ok(not has_table_privilege('authenticated','provider_time_off_requests','INSERT,UPDATE,DELETE'), 'time-off mutations cannot bypass the guarded commands');
select extensions.ok(not has_table_privilege('authenticated','provider_availability','INSERT,UPDATE,DELETE'), 'recurring provider availability cannot bypass time-off approval');
select extensions.ok(to_regprocedure('guard_self_reported_provider_callout()') is not null, 'self-reported callout guard function is installed');
select extensions.ok(exists(select 1 from pg_trigger where tgname='guard_self_reported_provider_callout_trigger' and not tgisinternal), 'provider callouts are protected by the planned-leave guard');
select extensions.ok((select count(*)=1 from information_schema.columns where table_schema='public' and table_name='user_profiles' and column_name='version'), 'user profiles carry a concurrency version');
select extensions.ok((select relrowsecurity from pg_class where oid='user_access_commands'::regclass), 'user access command ledger has RLS enabled');
select extensions.ok(to_regprocedure('manage_user_access(uuid,int,app_role,uuid,boolean,text,text)') is not null, 'guarded user access command is installed');
select extensions.ok(has_function_privilege('authenticated','manage_user_access(uuid,int,app_role,uuid,boolean,text,text)','EXECUTE'), 'authenticated administrators can invoke the guarded access command');
select extensions.ok(not has_table_privilege('authenticated','user_profiles','INSERT,UPDATE,DELETE'), 'user access changes cannot bypass the guarded command');
select extensions.ok(not has_table_privilege('authenticated','user_access_commands','SELECT,INSERT,UPDATE,DELETE'), 'user access replay ledger is private');
select extensions.ok(to_regprocedure('optimization_busy_intervals(timestamptz,timestamptz)') is not null, 'PHI-free busy interval function is installed');
select extensions.ok(to_regprocedure('app_schema_status()') is not null, 'deployment schema readiness function is installed');
select extensions.ok(to_regprocedure('update_location_configuration(uuid,text,location_type,text,text,text,boolean)') is not null, 'atomic location configuration command is installed');
select extensions.ok(to_regprocedure('update_resource_configuration(uuid,text,text,int,uuid,boolean)') is not null, 'atomic resource configuration command is installed');
select extensions.ok(to_regprocedure('update_service_configuration(uuid,text,text,text,int[],int,text,boolean,boolean,boolean,boolean,boolean,uuid[])') is not null, 'atomic service configuration command is installed');
select extensions.ok(has_function_privilege('authenticated','update_location_configuration(uuid,text,location_type,text,text,text,boolean)','EXECUTE'), 'authenticated administrators can invoke location configuration');
select extensions.ok(has_function_privilege('authenticated','update_resource_configuration(uuid,text,text,int,uuid,boolean)','EXECUTE'), 'authenticated administrators can invoke resource configuration');
select extensions.ok(has_function_privilege('authenticated','update_service_configuration(uuid,text,text,text,int[],int,text,boolean,boolean,boolean,boolean,boolean,uuid[])','EXECUTE'), 'authenticated administrators can invoke service configuration');
select extensions.ok((select count(*)=5 from pg_trigger where tgname=any(array['locations_audit_trigger','resources_audit_trigger','services_audit_trigger','service_durations_audit_trigger','service_resources_audit_trigger']) and not tgisinternal), 'configuration changes are audited by database triggers');
select extensions.ok((select bool_and(not has_table_privilege('authenticated',table_name,'INSERT,UPDATE,DELETE')) from unnest(array['locations','resources','services','service_durations','service_resources']) table_name), 'configuration writes cannot bypass the guarded commands');
select extensions.ok(exists(select 1 from pg_trigger where tgname='validate_appointment_linked_resources_trigger' and not tgisinternal), 'appointment resource integrity is checked at commit');
select extensions.ok(exists(select 1 from pg_trigger where tgname='validate_resource_link_removal_trigger' and not tgisinternal), 'required resource removal is checked at commit');
select extensions.ok(exists(select 1 from information_schema.columns where table_schema='public' and table_name='appointments' and column_name='last_change_reason'), 'appointment changes retain their documented reason');
select extensions.ok(has_function_privilege('authenticated','optimization_busy_intervals(timestamptz,timestamptz)','EXECUTE'), 'authenticated schedulers can request opaque conflicts');
select extensions.ok((select bool_and(relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relname=any(array['schedule_disruptions','recovery_cases','recovery_offers','recovery_idempotency','notification_receipts'])), 'all recovery tables have RLS enabled');
select extensions.ok(to_regprocedure('report_provider_callout(uuid,timestamptz,timestamptz,text,text,text)') is not null, 'provider callout command is installed');
select extensions.ok(to_regprocedure('report_patient_cancellation(uuid,text,boolean,text)') is not null, 'patient cancellation command is installed');
select extensions.ok(to_regprocedure('create_recovery_offer(uuid,int,text,uuid,uuid,timestamptz,timestamptz,boolean,uuid,jsonb,timestamptz,text)') is not null, 'recovery offer command is installed');
select extensions.ok(to_regprocedure('expire_recovery_offers(uuid)') is not null, 'recovery offer expiry command is installed');
select extensions.ok(to_regprocedure('expire_recovery_offer_queue(int)') is not null, 'bounded recovery queue expiry command is installed');
select extensions.ok(has_function_privilege('authenticated','expire_recovery_offer_queue(int)','EXECUTE'), 'authenticated recovery workers can invoke bounded queue expiry');
select extensions.ok(to_regprocedure('respond_recovery_offer(uuid,int,text,text,text)') is not null, 'recovery response command is installed');
select extensions.ok(to_regprocedure('set_recovery_case_state(uuid,int,text,text,timestamptz)') is not null, 'recovery case state command is installed');
select extensions.ok(to_regprocedure('restore_cancelled_appointment(uuid,text,text)') is not null, 'cancelled appointment restore command is installed');
select extensions.ok(to_regprocedure('withdraw_provider_callout(uuid,text,text)') is not null, 'provider callout withdrawal command is installed');
select extensions.ok(to_regprocedure('release_locked_recovery_case(uuid,int,text)') is not null, 'locked recovery clinical release command is installed');
select extensions.ok(to_regprocedure('provider_callout_intervals(timestamptz,timestamptz)') is not null, 'minimal callout interval reader is installed');
select extensions.ok(app_schema_status()->>'version'='20261022040000' and (app_schema_status()->>'schedule_recovery')::boolean and (app_schema_status()->>'configuration_writes')::boolean and (app_schema_status()->>'optimizer_decisions')::boolean and (app_schema_status()->>'optimizer_moves')::boolean and (app_schema_status()->>'provider_time_off')::boolean and (app_schema_status()->>'provider_callout_guard')::boolean and (app_schema_status()->>'access_management')::boolean, 'deployment health reports recovery, time off, access management, configuration writes, and optimizer decisions and moves ready');
select extensions.ok(exists(select 1 from pg_trigger where tgname='validate_provider_callout_guard_trigger' and not tgisinternal), 'provider callouts guard appointment writes');
select extensions.ok(not has_table_privilege('authenticated','appointments','INSERT'), 'authenticated clients cannot directly insert appointments');
select extensions.ok(not has_table_privilege('authenticated','appointments','UPDATE'), 'authenticated clients cannot directly update appointments');
select extensions.ok(not has_table_privilege('authenticated','appointments','DELETE'), 'authenticated clients cannot directly delete appointments');
select extensions.ok(not has_table_privilege('authenticated','appointment_resources','INSERT,UPDATE,DELETE'), 'authenticated clients cannot directly mutate appointment resources');
select extensions.ok(not has_table_privilege('authenticated','notifications','INSERT'), 'authenticated clients cannot manufacture notifications');
select extensions.ok(not has_column_privilege('authenticated','notifications','title','UPDATE'), 'authenticated clients cannot alter notification content');
select extensions.ok(has_column_privilege('authenticated','notifications','read_at','UPDATE'), 'authenticated clients may mark only targeted legacy notifications read');
select extensions.ok((select bool_and(not has_table_privilege('authenticated',relname,'INSERT')) from pg_class where relnamespace='public'::regnamespace and relname=any(array['schedule_disruptions','recovery_cases','recovery_offers','recovery_idempotency'])), 'recovery transitions cannot bypass command RPCs');
select extensions.ok(not has_column_privilege('authenticated','notification_receipts','notification_id','UPDATE'), 'notification receipt ownership cannot be retargeted');
select extensions.ok(position('delete from recovery_idempotency' in lower(pg_get_functiondef('report_patient_cancellation(uuid,text,boolean,text)'::regprocedure)))=0, 'patient cancellation replay ledger is append-only');
select extensions.ok(position('delete from recovery_idempotency' in lower(pg_get_functiondef('restore_cancelled_appointment(uuid,text,text)'::regprocedure)))=0, 'appointment restore replay ledger is append-only');
select extensions.ok(position('start_time<=now()' in regexp_replace(lower(pg_get_functiondef('restore_cancelled_appointment(uuid,text,text)'::regprocedure)), '\\s+', '', 'g'))>0, 'cancelled appointments cannot be restored after their original start');
select extensions.ok(position('provider_callout_withdrawn_after_visit_start' in lower(pg_get_functiondef('withdraw_provider_callout(uuid,text,text)'::regprocedure)))>0, 'callout withdrawal keeps already-started visits out of the active schedule');
select extensions.ok((select bool_and(relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relname=any(array[
  'communication_consents','communication_consent_events','communication_jobs',
  'communication_delivery_attempts','communication_delivery_receipts','communication_idempotency',
  'communication_delivery_config','communication_destination_hash_keys',
  'communication_destination_suppressions','communication_receipt_tokens'
])), 'all communication tables have RLS enabled');
select extensions.ok(app_schema_status()->>'version'='20261022040000' and (app_schema_status()->>'communications')::boolean and (app_schema_status()->>'communication_delivery')::boolean, 'deployment health reports communications and provider delivery ready');
select extensions.ok((app_schema_status()->>'optimizer_moves')::boolean, 'deployment health reports move-enabled optimizer approval ready');
select extensions.ok(app_schema_status()->>'version'='20261022040000' and (app_schema_status()->>'clinical_reductions')::boolean, 'deployment health reports clinical reduction review ready');
select extensions.ok(to_regprocedure('save_patient_contact(uuid,uuid,text,text,text,text,text,boolean,boolean,boolean,text,text,text,time,time,boolean,int,text)') is not null, 'contact save command is installed');
select extensions.ok(to_regprocedure('set_contact_channel_consent(uuid,communication_channel,boolean,text,int,text)') is not null, 'consent command is installed');
select extensions.ok(to_regprocedure('queue_appointment_reminder(uuid,uuid,communication_channel,timestamptz,text)') is not null, 'appointment reminder command is installed');
select extensions.ok(to_regprocedure('queue_recovery_message(uuid,uuid,uuid,communication_channel,communication_message_type,timestamptz,text)') is not null, 'recovery message command is installed');
select extensions.ok(to_regprocedure('sync_appointment_reminders(uuid)') is not null, 'single appointment reminder reconciler is installed');
select extensions.ok(to_regprocedure('sync_upcoming_appointment_reminders(int,int)') is not null, 'bounded appointment reminder reconciler is installed');
select extensions.ok(to_regprocedure('retry_communication_job(uuid,int,text,text)') is not null, 'communication retry command is installed');
select extensions.ok(to_regprocedure('cancel_communication_job(uuid,int,text,text)') is not null, 'communication cancellation command is installed');
select extensions.ok(to_regprocedure('respond_recovery_offer_with_contact(uuid,int,text,text,uuid,communication_response_channel,uuid,text)') is not null, 'recovery response provenance command is installed');
select extensions.ok(to_regprocedure('prepare_communication_delivery(uuid,uuid)') is not null, 'pre-send revalidation command is installed');
select extensions.ok(to_regprocedure('record_communication_receipt(uuid,text,communication_receipt_type,timestamptz,jsonb)') is not null, 'replay-safe receipt command is installed');
select extensions.ok(not has_table_privilege('authenticated','patient_contacts','INSERT,UPDATE,DELETE'), 'contact writes cannot bypass command RPCs');
select extensions.ok(not has_table_privilege('authenticated','communication_jobs','INSERT,UPDATE,DELETE'), 'communication job writes cannot bypass command RPCs');
select extensions.ok(not has_table_privilege('authenticated','communication_idempotency','SELECT'), 'communication replay ledger is private');
select extensions.ok(not has_function_privilege('authenticated','respond_recovery_offer(uuid,int,text,text,text)','EXECUTE'), 'generic recovery response without provenance is disabled');
select extensions.ok(has_function_privilege('authenticated','respond_recovery_offer_with_contact(uuid,int,text,text,uuid,communication_response_channel,uuid,text)','EXECUTE'), 'authenticated recovery managers can use the provenance command');
select extensions.ok(not has_function_privilege('authenticated','claim_communication_jobs(int,text)','EXECUTE'), 'authenticated users cannot claim delivery work');
select extensions.ok(has_function_privilege('service_role','claim_communication_jobs(int,text)','EXECUTE'), 'service delivery worker can claim work');
select extensions.ok(exists(select 1 from pg_trigger where tgname='patient_contacts_audit_trigger' and not tgisinternal), 'sanitized contact audit trigger is installed');
select extensions.ok(position('to_jsonb(new)' in lower(pg_get_functiondef('audit_patient_contact_change()'::regprocedure)))=0, 'contact audit does not serialize the raw row');
select extensions.ok(exists(select 1 from pg_indexes where schemaname='public' and indexname='patient_contacts_one_active_primary_idx'), 'one active primary recipient is enforced');
select extensions.ok((select count(*)=3 from information_schema.columns where table_schema='public' and table_name='recovery_offers' and column_name=any(array['response_contact_id','response_channel','communication_job_id'])), 'recovery offers retain response provenance');
select extensions.ok((select delivery_mode='RECORD_ONLY' from communication_delivery_config where singleton), 'patient delivery fails closed in record-only mode until providers are configured');
select extensions.ok(exists(select 1 from pg_constraint where conrelid='communication_jobs'::regclass and pg_get_constraintdef(oid) like '%appointment-reminder-v1%'), 'communication jobs enforce fixed PHI-minimal templates');
select extensions.ok((select count(*)=2 from information_schema.columns where table_schema='public' and table_name='communication_jobs' and column_name=any(array['last_receipt_at','last_receipt_precedence'])), 'communication jobs track monotonic receipt state');
select extensions.ok(position($needle$j.status in ('queued','failed')$needle$ in lower(pg_get_functiondef('claim_communication_jobs(int,text)'::regprocedure)))>0, 'delivery worker claims due automatic retries as well as new jobs');
select extensions.ok(not has_table_privilege('authenticated','communication_receipt_tokens','SELECT,INSERT,UPDATE,DELETE'), 'provider receipt correlation tokens are private');
select extensions.ok(exists(select 1 from pg_trigger where tgname='communication_jobs_receipt_token_trigger' and not tgisinternal), 'new communication jobs receive an opaque callback token');
select extensions.ok(to_regprocedure('communication_delivery_mode()') is not null, 'service worker can check the database delivery gate before claiming work');
select extensions.ok(to_regprocedure('claim_communication_jobs_for_channels(int,text,communication_channel[])') is not null, 'channel-bounded communication claim command is installed');
select extensions.ok(to_regprocedure('prepare_communication_provider_delivery(uuid,uuid)') is not null, 'provider preparation command is installed');
select extensions.ok(to_regprocedure('record_communication_provider_receipt(uuid,text,text,communication_receipt_type,timestamptz,jsonb)') is not null, 'opaque provider receipt command is installed');
select extensions.ok(to_regprocedure('record_communication_destination_receipt(communication_channel,text,text,text,communication_receipt_type,timestamptz,jsonb)') is not null, 'destination opt-out receipt command is installed');
select extensions.ok(has_function_privilege('service_role','prepare_communication_provider_delivery(uuid,uuid)','EXECUTE'), 'service worker can prepare an approved provider delivery');
select extensions.ok(not has_function_privilege('authenticated','record_communication_provider_receipt(uuid,text,text,communication_receipt_type,timestamptz,jsonb)','EXECUTE'), 'authenticated users cannot forge provider receipts');

-- Exercise the actual policies under the authenticated Postgres role. Results
-- are captured in a temp table and asserted after returning to postgres.
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email, '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
from (values
  ('10000000-0000-0000-0000-000000000001'::uuid,'scheduler@test.invalid'),
  ('10000000-0000-0000-0000-000000000002'::uuid,'clinical@test.invalid'),
  ('10000000-0000-0000-0000-000000000003'::uuid,'provider@test.invalid'),
  ('10000000-0000-0000-0000-000000000004'::uuid,'authorization@test.invalid'),
  ('10000000-0000-0000-0000-000000000005'::uuid,'operations@test.invalid'),
  ('10000000-0000-0000-0000-000000000006'::uuid,'admin@test.invalid'),
  ('10000000-0000-0000-0000-000000000007'::uuid,'compliance@test.invalid'),
  ('10000000-0000-0000-0000-000000000008'::uuid,'inactive@test.invalid')
) x(id,email);

insert into locations(id,name,type,timezone) values ('20000000-0000-0000-0000-000000000001','RLS Test Clinic','CLINIC','America/New_York');
insert into providers(id,first_name,last_name,provider_type,home_location_id) values
('30000000-0000-0000-0000-000000000001','Clinical','Tester','BCBA','20000000-0000-0000-0000-000000000001'),
('30000000-0000-0000-0000-000000000002','Provider','Tester','RBT','20000000-0000-0000-0000-000000000001'),
('30000000-0000-0000-0000-000000000003','Unrelated','Tester','RBT','20000000-0000-0000-0000-000000000001');
insert into patients(id,first_name,last_name,primary_location_id) values
('40000000-0000-0000-0000-000000000001','Assigned','Patient','20000000-0000-0000-0000-000000000001'),
('40000000-0000-0000-0000-000000000002','Other','Patient','20000000-0000-0000-0000-000000000001');
update user_profiles up set display_name=v.display_name, role=v.role::app_role,
  requested_role=v.role::app_role, provider_id=v.provider_id, active=true
from (values
('10000000-0000-0000-0000-000000000001'::uuid,'Scheduler','SCHEDULER',null::uuid),
('10000000-0000-0000-0000-000000000002'::uuid,'Clinical','CLINICAL','30000000-0000-0000-0000-000000000001'::uuid),
('10000000-0000-0000-0000-000000000003'::uuid,'Provider','PROVIDER','30000000-0000-0000-0000-000000000002'::uuid),
('10000000-0000-0000-0000-000000000004'::uuid,'Authorization','AUTHORIZATION',null::uuid),
('10000000-0000-0000-0000-000000000005'::uuid,'Operations','OPERATIONS',null::uuid),
('10000000-0000-0000-0000-000000000006'::uuid,'Admin','ADMIN',null::uuid),
('10000000-0000-0000-0000-000000000007'::uuid,'Compliance','COMPLIANCE',null::uuid)
) v(user_id,display_name,role,provider_id)
where up.user_id=v.user_id;
insert into patient_care_team(patient_id,provider_id,relationship) values
('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','SUPERVISOR'),
('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','TREATING_PROVIDER');
insert into patient_contacts(patient_id,name,relationship) values
('40000000-0000-0000-0000-000000000001','Assigned Guardian','Parent'),
('40000000-0000-0000-0000-000000000002','Other Guardian','Parent');
insert into notifications(role,kind,title,dedupe_key) values ('PROVIDER','TEST','Provider task','rls-provider-task'),('ADMIN','TEST','Admin task','rls-admin-task');
insert into push_subscriptions(user_id,endpoint,p256dh,auth) values
('10000000-0000-0000-0000-000000000003','https://push.test/provider','key','auth'),
('10000000-0000-0000-0000-000000000006','https://push.test/admin','key','auth');
insert into audit_log(action) values ('RLS_TEST');

-- Recovery fixtures use cancelled source visits so the test remains focused
-- on visibility, not availability/authorization scheduling rules.
insert into services(
  id,service_code,service_name,department,default_duration_minutes,
  min_duration_minutes,max_duration_minutes,telehealth_allowed,in_person_allowed
) values(
  '21000000-0000-0000-0000-000000000001','RLS-RECOVERY','RLS Recovery Service','Testing',
  60,60,60,true,true
);
insert into resources(id,name,resource_type,location_id,capacity)
values('22000000-0000-0000-0000-000000000001','RLS Test Room','ROOM','20000000-0000-0000-0000-000000000001',1);

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000005',true);
select extensions.throws_ok($sql$
  select update_location_configuration(
    '20000000-0000-0000-0000-000000000001','Blocked Operations Edit','CLINIC',
    'Boston','MA','America/New_York',true
  )
$sql$,'42501','System administrator access required','operations cannot commit configuration changes');
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000006',true);
select extensions.lives_ok($sql$
  select update_location_configuration(
    '20000000-0000-0000-0000-000000000001','RLS Test Clinic','CLINIC',
    'Boston','MA','America/New_York',true
  )
$sql$,'administrator can update a location');
select extensions.lives_ok($sql$
  select update_resource_configuration(
    '22000000-0000-0000-0000-000000000001','RLS Test Room','ROOM',2,
    '20000000-0000-0000-0000-000000000001',true
  )
$sql$,'administrator can update a resource');
select extensions.lives_ok($sql$
  select update_service_configuration(
    '21000000-0000-0000-0000-000000000001','RLS Recovery Service','RLS-RECOVERY','Testing',
    array[30,60],60,'MAXIMIZE_SERVICE_HOURS',false,true,true,false,true,
    array['22000000-0000-0000-0000-000000000001'::uuid]
  )
$sql$,'administrator can atomically update a service');
reset role;
set local role postgres;
set local search_path = public, extensions;
select extensions.ok(
  (select count(distinct action)=3 from audit_log
    where user_id='10000000-0000-0000-0000-000000000006'
      and action=any(array['LOCATIONS_UPDATE','RESOURCES_UPDATE','SERVICES_UPDATE'])),
  'administrator configuration changes are attributed in the audit log'
);

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select extensions.lives_ok($sql$
  select record_optimization_plan_decision(
    '40000000-0000-0000-0000-000000000001','2035-01-07','2035-01-13',
    'pgtap-plan-1','REJECTED','Does not preserve the preferred provider',null,
    '{"label":"RLS plan"}'::jsonb
  )
$sql$,'scheduler can reject a generated plan');
select extensions.throws_ok($sql$
  insert into optimization_requests(
    requested_by,mode,patient_id,date_start,date_end,objective,allow_moves,
    allow_provider_changes,allow_location_changes,max_solutions,status,solver_status,
    request_payload,completed_at,approved_by,approved_at,decision_reason,idempotency_key
  ) values (
    '10000000-0000-0000-0000-000000000001','OPTIMIZE_PATIENT',
    '40000000-0000-0000-0000-000000000001','2035-01-07','2035-01-13',
    'MULTI_SERVICE_CLINICAL_COVERAGE',false,true,false,1,'COMPLETE','FEASIBLE',
    '{"summary":{"plan_id":"pgtap-plan-1"}}'::jsonb,now(),
    '10000000-0000-0000-0000-000000000001',now(),'Race test','pgtap-race-approval'
  )
$sql$,'P0001','Plan already has an active rejected decision','approval cannot race past an earlier rejection');
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
select extensions.is(
  (record_optimization_plan_decision(
    '40000000-0000-0000-0000-000000000001','2035-01-07','2035-01-13',
    'pgtap-plan-1','DEFERRED','Review this tomorrow','2035-01-08 12:00+00',
    '{"label":"RLS plan"}'::jsonb
  )->>'already_decided')::boolean,
  true,
  'a concurrent later decision preserves the first active decision'
);
reset role;
set local role postgres;
set local search_path = public, extensions;
select extensions.ok(exists(
  select 1 from audit_log
  where action='OPTIMIZATION_PLAN_REJECTED'
    and patient_id='40000000-0000-0000-0000-000000000001'
    and user_id='10000000-0000-0000-0000-000000000001'
    and override_reason='Does not preserve the preferred provider'
), 'optimizer plan decisions retain actor, patient, and reason in audit history');

insert into appointments(
  id,patient_id,service_id,provider_id,location_id,start_time,end_time,status,
  scheduling_flexibility,telehealth,cancellation_reason,last_change_reason
) values
('41000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','2035-01-07 15:00+00','2035-01-07 16:00+00','CANCELLED','FLEXIBLE',false,'Test recovery fixture','RLS test'),
('41000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000002','21000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','2035-01-08 15:00+00','2035-01-08 16:00+00','CANCELLED','FLEXIBLE',false,'Test recovery fixture','RLS test');

insert into schedule_disruptions(
  id,disruption_type,provider_id,patient_id,source_appointment_id,starts_at,ends_at,
  status,reason_category,reported_by,idempotency_key
) values
('50000000-0000-0000-0000-000000000001','PROVIDER_CALLOUT','30000000-0000-0000-0000-000000000002',null,null,'2035-01-07 14:00+00','2035-01-07 18:00+00','OPEN','ILLNESS','10000000-0000-0000-0000-000000000001','rls-callout-provider'),
('50000000-0000-0000-0000-000000000002','PROVIDER_CALLOUT','30000000-0000-0000-0000-000000000001',null,null,'2035-01-08 14:00+00','2035-01-08 18:00+00','OPEN','TRAINING','10000000-0000-0000-0000-000000000001','rls-callout-clinical'),
('50000000-0000-0000-0000-000000000003','PATIENT_CANCELLATION',null,'40000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000001','2035-01-07 15:00+00','2035-01-07 16:00+00','OPEN','PATIENT_CANCELLATION','10000000-0000-0000-0000-000000000001','rls-patient-cancel-1'),
('50000000-0000-0000-0000-000000000004','PATIENT_CANCELLATION',null,'40000000-0000-0000-0000-000000000002','41000000-0000-0000-0000-000000000002','2035-01-08 15:00+00','2035-01-08 16:00+00','OPEN','PATIENT_CANCELLATION','10000000-0000-0000-0000-000000000001','rls-patient-cancel-2');
insert into recovery_cases(
  id,disruption_id,original_appointment_id,patient_id,status,priority,
  requires_clinical_review,original_status,original_flexibility,original_provider_id,
  original_location_id,original_start_time,original_end_time,decision_reason,last_changed_by
) values
('60000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000003','41000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','OFFERED','HIGH',false,'SCHEDULED','FLEXIBLE','30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','2035-01-07 15:00+00','2035-01-07 16:00+00','RLS visibility fixture','10000000-0000-0000-0000-000000000001'),
('60000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000004','41000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000002','OFFERED','NORMAL',false,'SCHEDULED','FLEXIBLE','30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','2035-01-08 15:00+00','2035-01-08 16:00+00','RLS visibility fixture','10000000-0000-0000-0000-000000000001');
insert into recovery_offers(
  id,recovery_case_id,candidate_key,proposed_provider_id,proposed_location_id,
  proposed_start_time,proposed_end_time,proposed_telehealth,proposed_resource_ids,
  source_appointment_updated_at,status,expires_at,created_reason,created_by
)
select '70000000-0000-0000-0000-000000000001'::uuid,rc.id,'rls-candidate-assigned',
  '30000000-0000-0000-0000-000000000002'::uuid,'20000000-0000-0000-0000-000000000001'::uuid,
  '2035-01-10 15:00+00'::timestamptz,'2035-01-10 16:00+00'::timestamptz,false,'[]'::jsonb,a.updated_at,
  'PENDING','2035-01-09 15:00+00'::timestamptz,'RLS visibility fixture','10000000-0000-0000-0000-000000000001'::uuid
from recovery_cases rc join appointments a on a.id=rc.original_appointment_id
where rc.id='60000000-0000-0000-0000-000000000001'
union all
select '70000000-0000-0000-0000-000000000002'::uuid,rc.id,'rls-candidate-unrelated',
  '30000000-0000-0000-0000-000000000003'::uuid,'20000000-0000-0000-0000-000000000001'::uuid,
  '2035-01-11 15:00+00'::timestamptz,'2035-01-11 16:00+00'::timestamptz,false,'[]'::jsonb,a.updated_at,
  'PENDING','2035-01-09 15:00+00'::timestamptz,'RLS visibility fixture','10000000-0000-0000-0000-000000000001'::uuid
from recovery_cases rc join appointments a on a.id=rc.original_appointment_id
where rc.id='60000000-0000-0000-0000-000000000002';
insert into notification_receipts(notification_id,user_id,read_at)
select n.id,'10000000-0000-0000-0000-000000000003'::uuid,now()
from notifications n where n.dedupe_key='rls-provider-task'
union all
select n.id,'10000000-0000-0000-0000-000000000006'::uuid,now()
from notifications n where n.dedupe_key='rls-admin-task';

update patient_contacts set
  phone=case when patient_id='40000000-0000-0000-0000-000000000001' then '+15555550101' else '+15555550102' end,
  email=case when patient_id='40000000-0000-0000-0000-000000000001' then 'assigned@example.invalid' else 'other@example.invalid' end,
  is_primary=true,authorized_to_receive_information=true,is_legal_guardian=true,
  guardian_authority='CUSTODIAL',preferred_language='en',timezone='America/New_York',
  relationship_verified_at=now(),relationship_verified_by='10000000-0000-0000-0000-000000000001';
insert into communication_consents(
  id,patient_contact_id,patient_id,channel,status,source,granted_at,changed_by
)
select case when pc.patient_id='40000000-0000-0000-0000-000000000001'
    then '81000000-0000-0000-0000-000000000001'::uuid
    else '81000000-0000-0000-0000-000000000002'::uuid end,
  pc.id,pc.patient_id,'SMS','GRANTED','RLS_TEST',now(),'10000000-0000-0000-0000-000000000001'
from patient_contacts pc where pc.patient_id::text like '40000000-%';
insert into communication_consent_events(
  consent_id,patient_id,patient_contact_id,channel,prior_status,new_status,source,changed_by
)
select cc.id,cc.patient_id,cc.patient_contact_id,cc.channel,null,cc.status,'RLS_TEST',
  '10000000-0000-0000-0000-000000000001'
from communication_consents cc where cc.id::text like '81000000-%';
insert into communication_jobs(
  id,patient_id,patient_contact_id,appointment_id,message_type,channel,status,
  template_key,subject_snapshot,body_snapshot,source_entity_version,
  source_contact_version,source_consent_version,destination_fingerprint,
  scheduled_for,next_attempt_at,expires_at,
  max_attempts,attempt_count,delivered_at,last_error_category,dedupe_key,created_by
)
select case when pc.patient_id='40000000-0000-0000-0000-000000000001'
    then '82000000-0000-0000-0000-000000000001'::uuid
    else '82000000-0000-0000-0000-000000000002'::uuid end,
  pc.patient_id,pc.id,a.id,'APPOINTMENT_REMINDER','SMS',
  case
    when pc.patient_id='40000000-0000-0000-0000-000000000001'
      then 'DELIVERED'::communication_job_status
    else 'FAILED'::communication_job_status
  end,
  'appointment-reminder-v1','Appointment reminder',
  'Reminder: an appointment is coming up. Contact the scheduling team if you need help. Reply STOP to opt out.',
  a.updated_at::text,pc.version,cc.version,communication_destination_fingerprint('SMS',pc.phone),
  a.start_time-interval '24 hours',a.start_time-interval '24 hours',a.start_time,
  3,1,case when pc.patient_id='40000000-0000-0000-0000-000000000001' then a.start_time-interval '24 hours' else null end,
  case when pc.patient_id='40000000-0000-0000-0000-000000000002' then 'TEMPORARY_FAILURE' else null end,
  'rls-communication-'||pc.patient_id,'10000000-0000-0000-0000-000000000001'
from patient_contacts pc
join communication_consents cc on cc.patient_contact_id=pc.id and cc.channel='SMS'
join appointments a on a.patient_id=pc.patient_id
where pc.patient_id::text like '40000000-%';
insert into communication_delivery_attempts(
  communication_job_id,attempt_number,provider,provider_message_id,outcome,error_category,
  http_status,destination_hash,processing_token_hash,started_at,completed_at,metadata
)
select j.id,1,'RLS_PROVIDER','rls-'||j.id,
  case when j.status='DELIVERED' then 'DELIVERED'::communication_attempt_outcome else 'TEMPORARY_FAILURE'::communication_attempt_outcome end,
  case when j.status='FAILED' then 'TEMPORARY_FAILURE' else null end,
  case when j.status='DELIVERED' then 200 else 503 end,
  repeat(case when j.status='DELIVERED' then 'a' else 'b' end,64),
  repeat(case when j.status='DELIVERED' then 'c' else 'd' end,64),
  j.scheduled_for,j.scheduled_for+interval '1 second','{}'
from communication_jobs j where j.id::text like '82000000-%';
insert into communication_delivery_receipts(
  communication_job_id,communication_attempt_id,provider_event_id,receipt_type,occurred_at,metadata
)
select j.id,a.id,'rls-delivered-event','DELIVERED',a.completed_at,'{}'
from communication_jobs j join communication_delivery_attempts a on a.communication_job_id=j.id
where j.id='82000000-0000-0000-0000-000000000001';

-- Exercise the service-only outcome path, including the newly persisted lease
-- fingerprint used to distinguish a real replay from a stale worker token.
delete from communication_delivery_attempts
where communication_job_id='82000000-0000-0000-0000-000000000002';
update communication_jobs set status='PROCESSING',
  processing_token='83000000-0000-0000-0000-000000000002',
  processing_worker='pgtap-worker',processing_started_at=now(),version=version+1
where id='82000000-0000-0000-0000-000000000002';
create temp table delivery_rpc_results(stage text primary key,result jsonb);
select set_config('request.jwt.claim.role','service_role',true);
insert into delivery_rpc_results(stage,result)
select 'receipt',record_communication_receipt(
  j.id,'rls-raced-delivery-event','DELIVERED',now(),'{}'::jsonb
)
from communication_jobs j where j.id='82000000-0000-0000-0000-000000000002';
select extensions.ok((select status='PROCESSING'
    and processing_token='83000000-0000-0000-0000-000000000002'
    and exists(select 1 from communication_delivery_receipts r
      where r.provider_event_id='rls-raced-delivery-event' and r.communication_attempt_id is null)
  from communication_jobs where id='82000000-0000-0000-0000-000000000002'),
  'a delivery receipt racing the provider response preserves the active worker lease');
insert into delivery_rpc_results(stage,result)
select 'outcome',record_communication_delivery_outcome(
  j.id,'83000000-0000-0000-0000-000000000002','PGTAP_PROVIDER','pgtap-temporary',
  'TEMPORARY_FAILURE','UPSTREAM_TIMEOUT',503,j.destination_fingerprint,
  now()-interval '1 second',now(),'{}'::jsonb
)
from communication_jobs j where j.id='82000000-0000-0000-0000-000000000002';
select extensions.ok((select j.status='DELIVERED' and j.processing_token is null
    and d.result->>'status'='DELIVERED'
    and exists(select 1 from communication_delivery_receipts r
      where r.provider_event_id='rls-raced-delivery-event' and r.communication_attempt_id is not null)
  from communication_jobs j cross join delivery_rpc_results d
  where j.id='82000000-0000-0000-0000-000000000002' and d.stage='outcome'),
  'worker outcome records the attempt, links the raced receipt, releases its lease, and preserves DELIVERED');
select extensions.throws_ok($sql$
  select record_communication_delivery_outcome(
    '82000000-0000-0000-0000-000000000002',
    '83000000-0000-0000-0000-000000000099','PGTAP_PROVIDER','stale-token',
    'TEMPORARY_FAILURE','UPSTREAM_TIMEOUT',503,
    (select destination_fingerprint from communication_jobs where id='82000000-0000-0000-0000-000000000002'),
    now()-interval '1 second',now(),'{}'::jsonb
  )
$sql$,'Communication lease is invalid','a stale worker token cannot replay a different delivery attempt');
select set_config('request.jwt.claim.role','authenticated',true);

create temp table rls_results(name text primary key, value integer);
grant select,insert on rls_results to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
insert into rls_results values ('scheduler_patients',(select count(*) from patients where id::text like '40000000-%')),('scheduler_audit',(select count(*) from audit_log where action='RLS_TEST'));
insert into rls_results values
('scheduler_recovery_cases',(select count(*) from recovery_cases where id::text like '60000000-%')),
('scheduler_recovery_offers',(select count(*) from recovery_offers where id::text like '70000000-%')),
('scheduler_recovery_disruptions',(select count(*) from schedule_disruptions where id::text like '50000000-%')),
('scheduler_callout_intervals',(select count(*) from provider_callout_intervals('2035-01-01','2035-02-01')));
insert into rls_results values
('scheduler_contacts',(select count(*) from patient_contacts where patient_id::text like '40000000-%')),
('scheduler_consents',(select count(*) from communication_consents where id::text like '81000000-%')),
('scheduler_jobs',(select count(*) from communication_jobs where id::text like '82000000-%')),
('scheduler_consent_events',(select count(*) from communication_consent_events where source='RLS_TEST'));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
insert into rls_results values ('clinical_patients',(select count(*) from patients));
insert into rls_results values
('clinical_recovery_cases',(select count(*) from recovery_cases where id::text like '60000000-%')),
('clinical_recovery_offers',(select count(*) from recovery_offers where id::text like '70000000-%')),
('clinical_recovery_disruptions',(select count(*) from schedule_disruptions where id::text like '50000000-%')),
('clinical_callout_intervals',(select count(*) from provider_callout_intervals('2035-01-01','2035-02-01')));
insert into rls_results values
('clinical_contacts',(select count(*) from patient_contacts where patient_id::text like '40000000-%')),
('clinical_consents',(select count(*) from communication_consents where id::text like '81000000-%')),
('clinical_jobs',(select count(*) from communication_jobs where id::text like '82000000-%')),
('clinical_attempts',(select count(*) from communication_delivery_attempts));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
insert into rls_results values ('provider_patients',(select count(*) from patients where id::text like '40000000-%')),('provider_records',(select count(*) from providers where id::text like '30000000-%')),('provider_team_links',(select count(*) from patient_care_team where patient_id::text like '40000000-%')),('provider_contacts',(select count(*) from patient_contacts where patient_id::text like '40000000-%')),('provider_notifications',(select count(*) from notifications where kind='TEST')),('provider_push',(select count(*) from push_subscriptions));
insert into rls_results values
('provider_recovery_cases',(select count(*) from recovery_cases where id::text like '60000000-%')),
('provider_recovery_offers',(select count(*) from recovery_offers where id::text like '70000000-%')),
('provider_recovery_disruptions',(select count(*) from schedule_disruptions where id::text like '50000000-%')),
('provider_callout_intervals',(select count(*) from provider_callout_intervals('2035-01-01','2035-02-01'))),
('provider_receipts',(select count(*) from notification_receipts));
insert into rls_results values
('provider_consents',(select count(*) from communication_consents)),
('provider_jobs',(select count(*) from communication_jobs)),
('provider_contact_summary',(select count(*) from communication_contact_summary('40000000-0000-0000-0000-000000000001')));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000004',true);
insert into rls_results values ('authorization_patients',(select count(*) from patients where id::text like '40000000-%'));
insert into rls_results values
('authorization_recovery_cases',(select count(*) from recovery_cases where id::text like '60000000-%')),
('authorization_recovery_offers',(select count(*) from recovery_offers where id::text like '70000000-%')),
('authorization_recovery_disruptions',(select count(*) from schedule_disruptions where id::text like '50000000-%')),
('authorization_callout_intervals',(select count(*) from provider_callout_intervals('2035-01-01','2035-02-01')));
insert into rls_results values
('authorization_contacts',(select count(*) from patient_contacts)),
('authorization_consents',(select count(*) from communication_consents)),
('authorization_jobs',(select count(*) from communication_jobs));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000005',true);
insert into rls_results values ('operations_patients',(select count(*) from patients where id::text like '40000000-%'));
insert into rls_results values
('operations_recovery_cases',(select count(*) from recovery_cases where id::text like '60000000-%')),
('operations_recovery_offers',(select count(*) from recovery_offers where id::text like '70000000-%')),
('operations_recovery_disruptions',(select count(*) from schedule_disruptions where id::text like '50000000-%')),
('operations_callout_intervals',(select count(*) from provider_callout_intervals('2035-01-01','2035-02-01')));
insert into rls_results values
('operations_contacts',(select count(*) from patient_contacts)),
('operations_consents',(select count(*) from communication_consents)),
('operations_jobs',(select count(*) from communication_jobs)),
('operations_delivery_groups',(select count(*) from communication_delivery_overview(now()-interval '1 day')));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000006',true);
insert into rls_results values ('admin_patients',(select count(*) from patients where id::text like '40000000-%')),('admin_audit',(select count(*) from audit_log where action='RLS_TEST')),('admin_contacts',(select count(*) from patient_contacts where patient_id::text like '40000000-%')),('admin_notifications',(select count(*) from notifications where kind='TEST')),('admin_push',(select count(*) from push_subscriptions));
insert into rls_results values
('admin_recovery_cases',(select count(*) from recovery_cases where id::text like '60000000-%')),
('admin_recovery_offers',(select count(*) from recovery_offers where id::text like '70000000-%')),
('admin_recovery_disruptions',(select count(*) from schedule_disruptions where id::text like '50000000-%')),
('admin_callout_intervals',(select count(*) from provider_callout_intervals('2035-01-01','2035-02-01'))),
('admin_receipts',(select count(*) from notification_receipts));
insert into rls_results values
('admin_communication_contacts',(select count(*) from patient_contacts)),
('admin_communication_consents',(select count(*) from communication_consents)),
('admin_communication_jobs',(select count(*) from communication_jobs));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000007',true);
insert into rls_results values ('compliance_patients',(select count(*) from patients where id::text like '40000000-%')),('compliance_audit',(select count(*) from audit_log where action='RLS_TEST'));
insert into rls_results values
('compliance_recovery_cases',(select count(*) from recovery_cases where id::text like '60000000-%')),
('compliance_recovery_offers',(select count(*) from recovery_offers where id::text like '70000000-%')),
('compliance_recovery_disruptions',(select count(*) from schedule_disruptions where id::text like '50000000-%')),
('compliance_callout_intervals',(select count(*) from provider_callout_intervals('2035-01-01','2035-02-01')));
insert into rls_results values
('compliance_contacts',(select count(*) from patient_contacts)),
('compliance_consents',(select count(*) from communication_consents)),
('compliance_jobs',(select count(*) from communication_jobs)),
('compliance_consent_events',(select count(*) from communication_consent_events where source='RLS_TEST')),
('compliance_attempts',(select count(*) from communication_delivery_attempts)),
('compliance_delivery_receipts',(select count(*) from communication_delivery_receipts));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000008',true);
insert into rls_results values
('inactive_contacts',(select count(*) from patient_contacts)),
('inactive_consents',(select count(*) from communication_consents)),
('inactive_jobs',(select count(*) from communication_jobs));
reset role;
set local role postgres;
set local search_path = public, extensions;

select extensions.is((select value from rls_results where name='scheduler_patients'),2,'scheduler sees all patients');
select extensions.is((select value from rls_results where name='clinical_patients'),1,'clinical supervisor sees assigned caseload only');
select extensions.is((select value from rls_results where name='provider_patients'),1,'provider sees assigned caseload only');
select extensions.is((select value from rls_results where name='authorization_patients'),2,'authorization specialist sees all patients');
select extensions.is((select value from rls_results where name='operations_patients'),2,'operations sees all patients');
select extensions.is((select value from rls_results where name='admin_patients'),0,'administrator cannot read patients');
select extensions.is((select value from rls_results where name='compliance_patients'),0,'compliance cannot read patients');
select extensions.is((select value from rls_results where name='provider_records'),1,'provider sees only their own staff record');
select extensions.is((select value from rls_results where name='provider_team_links'),2,'provider sees only links belonging to their assigned patient');
select extensions.is((select value from rls_results where name='provider_contacts'),0,'provider cannot read raw patient contact destinations');
select extensions.is((select value from rls_results where name='admin_contacts'),0,'administrator cannot read patient contacts');
select extensions.is((select value from rls_results where name='provider_notifications'),1,'provider sees provider work queue only');
select extensions.is((select value from rls_results where name='admin_notifications'),1,'administrator sees administrator work queue only');
select extensions.is((select value from rls_results where name='provider_push'),1,'provider sees only their own push subscription');
select extensions.is((select value from rls_results where name='admin_push'),1,'administrator sees only their own push subscription');
select extensions.is((select value from rls_results where name='compliance_audit'),1,'compliance can read audit');
select extensions.is((select value from rls_results where name='scheduler_audit'),0,'scheduler cannot read audit');
select extensions.is((select value from rls_results where name='scheduler_recovery_cases'),2,'scheduler sees every recovery case');
select extensions.is((select value from rls_results where name='scheduler_recovery_offers'),2,'scheduler sees every recovery offer');
select extensions.is((select value from rls_results where name='scheduler_recovery_disruptions'),4,'scheduler sees every recovery disruption');
select extensions.is((select value from rls_results where name='scheduler_callout_intervals'),2,'scheduler receives all minimal provider callout intervals');
select extensions.is((select value from rls_results where name='clinical_recovery_cases'),1,'clinical sees only assigned recovery cases');
select extensions.is((select value from rls_results where name='clinical_recovery_offers'),1,'clinical sees only assigned recovery offers');
select extensions.is((select value from rls_results where name='clinical_recovery_disruptions'),2,'clinical sees assigned disruptions and their own callout');
select extensions.is((select value from rls_results where name='clinical_callout_intervals'),2,'clinical receives all minimal provider callout intervals');
select extensions.is((select value from rls_results where name='provider_recovery_cases'),0,'provider cannot read recovery cases');
select extensions.is((select value from rls_results where name='provider_recovery_offers'),0,'provider cannot read recovery offers');
select extensions.is((select value from rls_results where name='provider_recovery_disruptions'),1,'provider sees only their own callout disruption');
select extensions.is((select value from rls_results where name='provider_callout_intervals'),1,'provider receives only their own minimal callout interval');
select extensions.is((select value from rls_results where name='provider_receipts'),1,'provider sees only their notification receipt');
select extensions.is((select value from rls_results where name='authorization_recovery_cases'),0,'authorization specialist cannot read recovery cases');
select extensions.is((select value from rls_results where name='authorization_recovery_offers'),0,'authorization specialist cannot read recovery offers');
select extensions.is((select value from rls_results where name='authorization_recovery_disruptions'),0,'authorization specialist cannot read disruptions');
select extensions.is((select value from rls_results where name='authorization_callout_intervals'),0,'authorization specialist receives no callout intervals');
select extensions.is((select value from rls_results where name='operations_recovery_cases'),0,'operations cannot read patient recovery cases');
select extensions.is((select value from rls_results where name='operations_recovery_offers'),0,'operations cannot read patient recovery offers');
select extensions.is((select value from rls_results where name='operations_recovery_disruptions'),0,'operations cannot directly read disruption records');
select extensions.is((select value from rls_results where name='operations_callout_intervals'),2,'operations receives PHI-free callout intervals');
select extensions.is((select value from rls_results where name='admin_recovery_cases'),0,'administrator cannot read recovery cases');
select extensions.is((select value from rls_results where name='admin_recovery_offers'),0,'administrator cannot read recovery offers');
select extensions.is((select value from rls_results where name='admin_recovery_disruptions'),0,'administrator cannot read disruptions');
select extensions.is((select value from rls_results where name='admin_callout_intervals'),0,'administrator receives no callout intervals');
select extensions.is((select value from rls_results where name='admin_receipts'),1,'administrator sees only their notification receipt');
select extensions.is((select value from rls_results where name='compliance_recovery_cases'),0,'compliance cannot read recovery cases');
select extensions.is((select value from rls_results where name='compliance_recovery_offers'),0,'compliance cannot read recovery offers');
select extensions.is((select value from rls_results where name='compliance_recovery_disruptions'),0,'compliance cannot read disruptions');
select extensions.is((select value from rls_results where name='compliance_callout_intervals'),0,'compliance receives no callout intervals');

select extensions.is((select value from rls_results where name='scheduler_contacts'),2,'scheduler sees all communication contacts');
select extensions.is((select value from rls_results where name='scheduler_consents'),2,'scheduler sees all current consents');
select extensions.is((select value from rls_results where name='scheduler_jobs'),2,'scheduler sees all communication jobs');
select extensions.is((select value from rls_results where name='scheduler_consent_events'),2,'scheduler sees all sanitized consent history');
select extensions.is((select value from rls_results where name='clinical_contacts'),1,'clinical sees contacts only for assigned caseload');
select extensions.is((select value from rls_results where name='clinical_consents'),1,'clinical sees consent only for assigned caseload');
select extensions.is((select value from rls_results where name='clinical_jobs'),1,'clinical sees communication jobs only for assigned caseload');
select extensions.is((select value from rls_results where name='clinical_attempts'),1,'clinical sees delivery attempts only for assigned caseload');
select extensions.is((select value from rls_results where name='provider_consents'),0,'provider cannot read raw consent rows');
select extensions.is((select value from rls_results where name='provider_jobs'),0,'provider cannot read message bodies or jobs');
select extensions.is((select value from rls_results where name='provider_contact_summary'),1,'provider can read a destination-free contact summary for assigned caseload');
select extensions.is((select value from rls_results where name='authorization_contacts'),0,'authorization cannot read contact destinations');
select extensions.is((select value from rls_results where name='authorization_consents'),0,'authorization cannot read communication consent');
select extensions.is((select value from rls_results where name='authorization_jobs'),0,'authorization cannot read communication jobs');
select extensions.is((select value from rls_results where name='operations_contacts'),0,'operations cannot read contact destinations');
select extensions.is((select value from rls_results where name='operations_consents'),0,'operations cannot read individual consent');
select extensions.is((select value from rls_results where name='operations_jobs'),0,'operations cannot read individual jobs or bodies');
select extensions.is((select value from rls_results where name='operations_delivery_groups'),1,'operations receives aggregate delivery status only');
select extensions.is((select value from rls_results where name='admin_communication_contacts'),0,'administrator cannot read communication contacts');
select extensions.is((select value from rls_results where name='admin_communication_consents'),0,'administrator cannot read communication consent');
select extensions.is((select value from rls_results where name='admin_communication_jobs'),0,'administrator cannot read communication jobs');
select extensions.is((select value from rls_results where name='compliance_contacts'),0,'compliance cannot read contact destinations');
select extensions.is((select value from rls_results where name='compliance_consents'),0,'compliance cannot read live consent rows');
select extensions.is((select value from rls_results where name='compliance_jobs'),0,'compliance cannot read message bodies or jobs');
select extensions.is((select value from rls_results where name='compliance_consent_events'),2,'compliance can read sanitized consent history');
select extensions.is((select value from rls_results where name='compliance_attempts'),2,'compliance can read sanitized immutable delivery attempts');
select extensions.is((select value from rls_results where name='compliance_delivery_receipts'),2,'compliance can read sanitized delivery receipts');
select extensions.is((select value from rls_results where name='inactive_contacts'),0,'inactive users cannot read communication contacts');
select extensions.is((select value from rls_results where name='inactive_consents'),0,'inactive users cannot read communication consent');
select extensions.is((select value from rls_results where name='inactive_jobs'),0,'inactive users cannot read communication jobs');
select extensions.ok((select bool_and(relationship_verified_at is not null and relationship_verified_by is not null) from patient_contacts where patient_id::text like '40000000-%'), 'authorized communication fixtures have verified recipient relationships');
select extensions.ok(not exists(
  select 1 from audit_log
  where action like 'PATIENT_CONTACT%'
    and (coalesce(old_values,'{}'::jsonb) ?| array['name','phone','email','push_endpoint']
      or coalesce(new_values,'{}'::jsonb) ?| array['name','phone','email','push_endpoint'])
), 'contact audit history and new audit events contain no raw destination fields');

-- Exercise the move wrapper, not just its privilege surface. The source move,
-- added visit, result/change records, and audit event must share one commit.
insert into provider_services(id,provider_id,service_id,eligible)
values(
  '23000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '21000000-0000-0000-0000-000000000001',true
);
insert into provider_availability(
  id,provider_id,day_of_week,start_time,end_time,availability_type,location_id
) values
('24000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002',2,'08:00','18:00','CLINICAL','20000000-0000-0000-0000-000000000001'),
('24000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002',3,'08:00','18:00','CLINICAL','20000000-0000-0000-0000-000000000001');
insert into patient_availability(
  id,patient_id,day_of_week,start_time,end_time,availability_type
) values
('25000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',2,'08:00','18:00','AVAILABLE'),
('25000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001',3,'08:00','18:00','AVAILABLE');
insert into appointments(
  id,patient_id,service_id,provider_id,location_id,start_time,end_time,status,
  scheduling_flexibility,telehealth,last_change_reason
) values(
  '26000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  '2035-01-09 15:00+00','2035-01-09 16:00+00','SCHEDULED','FLEXIBLE',false,
  'Optimizer move integration fixture'
);
insert into appointment_resources(appointment_id,resource_id) values(
  '26000000-0000-0000-0000-000000000001',
  '22000000-0000-0000-0000-000000000001'
);

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select extensions.lives_ok($sql$
  select approve_optimization_plan_with_move(
    '40000000-0000-0000-0000-000000000001','2035-01-08','2035-01-14',
    'pgtap-move-approval',
    '[{"service_id":"21000000-0000-0000-0000-000000000001","provider_id":"30000000-0000-0000-0000-000000000002","authorization_id":null,"location_id":"20000000-0000-0000-0000-000000000001","resource_ids":["22000000-0000-0000-0000-000000000001"],"telehealth":false,"start_time":"2035-01-10T15:00:00Z","end_time":"2035-01-10T16:00:00Z"}]'::jsonb,
    '{"appointment_id":"26000000-0000-0000-0000-000000000001","service_id":"21000000-0000-0000-0000-000000000001","status":"SCHEDULED","flexibility":"FLEXIBLE","authorization_id":null,"telehealth":false,"old_start_time":"2035-01-09T15:00:00Z","old_end_time":"2035-01-09T16:00:00Z","old_provider_id":"30000000-0000-0000-0000-000000000002","old_location_id":"20000000-0000-0000-0000-000000000001","old_resource_ids":["22000000-0000-0000-0000-000000000001"],"new_start_time":"2035-01-09T17:00:00Z","new_end_time":"2035-01-09T18:00:00Z","new_provider_id":"30000000-0000-0000-0000-000000000002","new_location_id":"20000000-0000-0000-0000-000000000001","new_resource_ids":["22000000-0000-0000-0000-000000000001"]}'::jsonb,
    '{"plan_id":"pgtap-move-plan","added_hours":1,"required_services_met":true,"provider_changes":0,"service_metrics":[]}'::jsonb,
    'Move one flexible visit to unlock required care'
  )
$sql$,'move-enabled approval commits through the guarded transaction');
reset role;
set local role postgres;
set local search_path = public, extensions;
select extensions.ok(exists(
  select 1 from appointments
  where id='26000000-0000-0000-0000-000000000001'
    and start_time='2035-01-09 17:00+00'
    and original_start_time='2035-01-09 15:00+00'
), 'move approval preserves the original time and applies the destination');
select extensions.ok(exists(
  select 1 from optimization_requests rq
  join optimization_results rs on rs.optimization_request_id=rq.id
  where rq.idempotency_key='pgtap-move-approval' and rq.allow_moves
    and rs.appointments_added=1 and rs.appointments_moved=1
    and (select count(*) from optimization_changes c
      where c.optimization_result_id=rs.id and c.action in ('ADD','MOVE'))=2
), 'move approval records one addition and one move in optimization history');
select extensions.ok(exists(
  select 1 from audit_log
  where action='OPTIMIZATION_APPOINTMENT_MOVED'
    and appointment_id='26000000-0000-0000-0000-000000000001'
    and override_reason='Move one flexible visit to unlock required care'
), 'move approval retains its actor-scoped reason in immutable audit history');

-- A scheduler's planned edit remains unapplied when it would push an active
-- service below target. The assigned clinical supervisor can then approve the
-- exact stale-protected proposal through the guarded command.
insert into patient_service_requirements(
  patient_id,service_id,target_hours_per_week,required,effective_start
) values(
  '40000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',2,true,'2035-01-01'
);

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select extensions.is(
  update_appointment_booking(
    '26000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001',
    '2035-01-09 17:00+00','2035-01-09 17:30+00',
    'SCHEDULED','FLEXIBLE',
    '["22000000-0000-0000-0000-000000000001"]'::jsonb,
    'Shorter visit requested by the family'
  )->>'status',
  'PENDING_REVIEW',
  'scheduler reduction below target is queued instead of applied'
);
reset role;
set local role postgres;
set local search_path = public, extensions;
select extensions.ok(exists(
  select 1 from appointment_reduction_requests rr
  join appointments a on a.id=rr.appointment_id
  where rr.appointment_id='26000000-0000-0000-0000-000000000001'
    and rr.status='PENDING' and rr.scheduled_minutes_before=120
    and rr.scheduled_minutes_after=90 and rr.target_minutes=120
    and a.end_time='2035-01-09 18:00+00'
), 'pending reduction preserves the source appointment and records its clinical impact');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
select extensions.is(
  decide_appointment_reduction(
    (select id from appointment_reduction_requests
      where appointment_id='26000000-0000-0000-0000-000000000001' and status='PENDING'),
    1,'APPROVED','Clinically appropriate for this week'
  )->>'status',
  'APPROVED',
  'assigned clinical supervisor can approve the exact pending reduction'
);
reset role;
set local role postgres;
set local search_path = public, extensions;
select extensions.ok(exists(
  select 1 from appointment_reduction_requests rr
  join appointments a on a.id=rr.appointment_id
  where rr.appointment_id='26000000-0000-0000-0000-000000000001'
    and rr.status='APPROVED' and rr.reviewed_by='10000000-0000-0000-0000-000000000002'
    and a.end_time='2035-01-09 17:30+00'
) and exists(
  select 1 from audit_log
  where action='APPOINTMENT_REDUCTION_APPROVED'
    and appointment_id='26000000-0000-0000-0000-000000000001'
    and override_reason='Clinically appropriate for this week'
), 'clinical approval atomically applies the proposal and retains its decision reason');

-- Planned time off remains inert until Scheduler approval, then hands the
-- exact window to the existing atomic callout/recovery transaction.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select extensions.is(
  request_provider_time_off(
    '30000000-0000-0000-0000-000000000002',
    date_trunc('day',now()+interval '30 days')+interval '15 hours',
    date_trunc('day',now()+interval '30 days')+interval '17 hours',
    'PTO','Planned leave integration test','pgtap-provider-time-off'
  )->>'status',
  'PENDING',
  'linked provider can submit a future time-off request'
);
select extensions.is(
  (select count(*) from provider_time_off_requests)::bigint,
  1::bigint,
  'provider sees their own pending time-off request through RLS'
);
select extensions.throws_ok($sql$
  select decide_provider_time_off_request(
    (select id from provider_time_off_requests where idempotency_key='pgtap-provider-time-off'),
    1,'APPROVED','Provider self approval must fail'
  )
$sql$,'P0001','Scheduler access required to decide time-off requests','provider cannot approve their own time-off request');
select extensions.throws_ok($sql$
  select report_provider_callout(
    '30000000-0000-0000-0000-000000000002',
    now()+interval '2 hours',now()+interval '3 hours',
    'PTO','Planned leave must use approval','pgtap-block-direct-pto'
  )
$sql$,'P0001','Planned PTO and training must use the time-off request workflow','provider cannot bypass time-off approval with a PTO callout');
select extensions.throws_ok($sql$
  select report_provider_callout(
    '30000000-0000-0000-0000-000000000002',
    now()+interval '40 days',now()+interval '40 days 2 hours',
    'EMERGENCY','Future callout must use approval','pgtap-block-future-callout'
  )
$sql$,'P0001','Urgent self-reported callouts may start at most 24 hours ahead','provider cannot bypass time-off approval with a distant future callout');
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000005',true);
select extensions.is(
  (select count(*) from provider_time_off_requests)::bigint,
  0::bigint,
  'operations cannot read provider time-off requests'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select extensions.is(
  decide_provider_time_off_request(
    (select id from provider_time_off_requests where idempotency_key='pgtap-provider-time-off'),
    1,'APPROVED','Coverage reviewed for planned leave'
  )->>'status',
  'APPROVED',
  'scheduler can approve and apply a pending time-off request'
);
reset role;
set local role postgres;
set local search_path = public, extensions;
select extensions.ok(exists(
  select 1 from provider_time_off_requests r
  join schedule_disruptions sd on sd.id=r.disruption_id
  where r.idempotency_key='pgtap-provider-time-off'
    and r.status='APPROVED'
    and r.reviewed_by='10000000-0000-0000-0000-000000000001'
    and sd.provider_id=r.provider_id
    and sd.starts_at=r.starts_at and sd.ends_at=r.ends_at
) and exists(
  select 1 from audit_log
  where action='PROVIDER_TIME_OFF_APPROVED'
    and override_reason='Coverage reviewed for planned leave'
), 'time-off approval links the exact callout window and permanent audit reason');

-- Administrator access changes are command-only, versioned, idempotent, and
-- cannot remove the final active administrator.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000006',true);
select extensions.is(
  manage_user_access(
    '10000000-0000-0000-0000-000000000008',1,'OPERATIONS',null,true,
    'Approved for operations reporting','pgtap-user-access-activate'
  )->>'status',
  'ACTIVE',
  'administrator can activate a pending account through the guarded command'
);
select extensions.ok(exists(
  select 1 from user_profiles
  where user_id='10000000-0000-0000-0000-000000000008'
    and active and role='OPERATIONS' and provider_id is null and version=2
), 'access command applies the exact role, status, clinician link, and next version');
select extensions.is(
  manage_user_access(
    '10000000-0000-0000-0000-000000000008',1,'OPERATIONS',null,true,
    'Approved for operations reporting','pgtap-user-access-activate'
  )->>'already_applied',
  'true',
  'retried access command returns its original result without a duplicate mutation'
);
select extensions.throws_ok($sql$
  select manage_user_access(
    '10000000-0000-0000-0000-000000000008',2,'PROVIDER',null,true,
    'Provider access without a link must fail','pgtap-user-access-no-provider'
  )
$sql$,'P0001','Active provider accounts must be linked to a clinician','active provider access requires a clinician link');
select extensions.throws_ok($sql$
  select manage_user_access(
    '10000000-0000-0000-0000-000000000006',1,'OPERATIONS',null,false,
    'Attempt to remove the sole administrator','pgtap-user-access-last-admin'
  )
$sql$,'P0001','The last active administrator cannot be removed','last active administrator cannot be deactivated or demoted');
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000005',true);
select extensions.throws_ok($sql$
  select manage_user_access(
    '10000000-0000-0000-0000-000000000008',2,'OPERATIONS',null,false,
    'Unauthorized access attempt','pgtap-user-access-unauthorized'
  )
$sql$,'P0001','System administrator access required','non-administrator cannot manage user access');
reset role;
set local role postgres;
set local search_path = public, extensions;
select extensions.ok(exists(
  select 1 from audit_log
  where user_id='10000000-0000-0000-0000-000000000006'
    and action='USER_ACCESS_ACTIVATED'
    and new_values->>'target_user_id'='10000000-0000-0000-0000-000000000008'
    and new_values->>'role'='OPERATIONS'
    and override_reason='Approved for operations reporting'
) and (
  select count(*) from audit_log
  where action='USER_ACCESS_ACTIVATED'
    and new_values->>'target_user_id'='10000000-0000-0000-0000-000000000008'
)=1, 'access activation records one permanent actor-scoped reason across retries');

select * from extensions.finish();
rollback;
