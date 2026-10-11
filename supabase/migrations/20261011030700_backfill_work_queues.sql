begin;

insert into intake_tasks(patient_id,task_key,label)
select p.id, task.task_key, task.label
from patients p cross join (values
  ('demographics','Demographics reviewed'),
  ('contact','Primary contact recorded'),
  ('availability','Availability recorded'),
  ('clinical','Clinical requirements signed'),
  ('authorization','Authorization recorded'),
  ('care_team','Care team assigned')
) task(task_key,label)
on conflict(patient_id,task_key) do nothing;

insert into notifications(role,kind,title,body,href,severity,dedupe_key,expires_at)
select 'AUTHORIZATION'::app_role,'AUTHORIZATION_EXPIRY',
  p.first_name||' '||p.last_name||': authorization expires soon',
  coalesce(a.payer,'Payer')||' authorization ends '||a.end_date,
  '/authorizations/'||a.id,
  case when a.end_date <= current_date+14 then 'CRITICAL' else 'WARNING' end,
  'authorization-expiry-'||a.id,
  a.end_date::timestamptz + interval '1 day'
from authorizations a join patients p on p.id=a.patient_id
where a.status='ACTIVE' and a.end_date between current_date and current_date+45
on conflict(role,dedupe_key) where role is not null and dedupe_key is not null do nothing;

insert into notifications(role,kind,title,body,href,severity,dedupe_key)
select 'CLINICAL'::app_role,'CREDENTIAL_EXPIRY',
  p.first_name||' '||p.last_name||': credential needs attention',
  pc.credential_type||coalesce(' expires '||pc.expiration_date,''),
  '/providers/'||p.id,
  case when pc.status<>'ACTIVE' or pc.expiration_date<current_date then 'CRITICAL' else 'WARNING' end,
  'credential-'||pc.id
from provider_credentials pc join providers p on p.id=pc.provider_id
where pc.status<>'ACTIVE' or pc.expiration_date <= current_date+45
on conflict(role,dedupe_key) where role is not null and dedupe_key is not null do nothing;

commit;
