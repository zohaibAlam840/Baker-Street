begin;
create extension if not exists pgtap with schema extensions;
set local role postgres;
set local search_path = public, extensions;
select plan(30);

select extensions.ok((select bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace and relname = any(array[
  'patients','providers','appointments','authorizations','patient_service_requirements','patient_care_team','audit_log'
])), 'all sensitive representative tables have RLS enabled');

select extensions.ok((select count(*) >= 4 from pg_policies where schemaname='public' and tablename='appointments'), 'appointments have read and write policies');
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
  ('10000000-0000-0000-0000-000000000007'::uuid,'compliance@test.invalid')
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

create temp table rls_results(name text primary key, value integer);
grant select,insert on rls_results to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
insert into rls_results values ('scheduler_patients',(select count(*) from patients where id::text like '40000000-%')),('scheduler_audit',(select count(*) from audit_log where action='RLS_TEST'));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
insert into rls_results values ('clinical_patients',(select count(*) from patients));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
insert into rls_results values ('provider_patients',(select count(*) from patients where id::text like '40000000-%')),('provider_records',(select count(*) from providers where id::text like '30000000-%')),('provider_team_links',(select count(*) from patient_care_team where patient_id::text like '40000000-%')),('provider_contacts',(select count(*) from patient_contacts where patient_id::text like '40000000-%')),('provider_notifications',(select count(*) from notifications where kind='TEST')),('provider_push',(select count(*) from push_subscriptions));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000004',true);
insert into rls_results values ('authorization_patients',(select count(*) from patients where id::text like '40000000-%'));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000005',true);
insert into rls_results values ('operations_patients',(select count(*) from patients where id::text like '40000000-%'));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000006',true);
insert into rls_results values ('admin_patients',(select count(*) from patients where id::text like '40000000-%')),('admin_audit',(select count(*) from audit_log where action='RLS_TEST')),('admin_contacts',(select count(*) from patient_contacts where patient_id::text like '40000000-%')),('admin_notifications',(select count(*) from notifications where kind='TEST')),('admin_push',(select count(*) from push_subscriptions));
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000007',true);
insert into rls_results values ('compliance_patients',(select count(*) from patients where id::text like '40000000-%')),('compliance_audit',(select count(*) from audit_log where action='RLS_TEST'));
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
select extensions.is((select value from rls_results where name='provider_contacts'),1,'provider sees contacts for assigned patients only');
select extensions.is((select value from rls_results where name='admin_contacts'),0,'administrator cannot read patient contacts');
select extensions.is((select value from rls_results where name='provider_notifications'),1,'provider sees provider work queue only');
select extensions.is((select value from rls_results where name='admin_notifications'),1,'administrator sees administrator work queue only');
select extensions.is((select value from rls_results where name='provider_push'),1,'provider sees only their own push subscription');
select extensions.is((select value from rls_results where name='admin_push'),1,'administrator sees only their own push subscription');
select extensions.is((select value from rls_results where name='compliance_audit'),1,'compliance can read audit');
select extensions.is((select value from rls_results where name='scheduler_audit'),0,'scheduler cannot read audit');

select * from extensions.finish();
rollback;
