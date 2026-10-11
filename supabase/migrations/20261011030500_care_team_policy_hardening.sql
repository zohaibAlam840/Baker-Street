-- FOR ALL policies also participate in SELECT, so management operations are
-- intentionally split to prevent supervisors enumerating other caseloads.
drop policy if exists "team members read links" on patient_care_team;
drop policy if exists "clinical scheduler manage teams" on patient_care_team;

create policy "scoped team links read" on patient_care_team
for select to authenticated using (
  has_app_role(array['SCHEDULER']::app_role[])
  or (has_app_role(array['CLINICAL','PROVIDER']::app_role[]) and can_access_patient(patient_id))
);

create policy "scheduler clinical insert team links" on patient_care_team
for insert to authenticated with check (
  has_app_role(array['SCHEDULER']::app_role[])
  or (has_app_role(array['CLINICAL']::app_role[]) and can_access_patient(patient_id))
);

create policy "scheduler clinical update team links" on patient_care_team
for update to authenticated
using (
  has_app_role(array['SCHEDULER']::app_role[])
  or (has_app_role(array['CLINICAL']::app_role[]) and can_access_patient(patient_id))
)
with check (
  has_app_role(array['SCHEDULER']::app_role[])
  or (has_app_role(array['CLINICAL']::app_role[]) and can_access_patient(patient_id))
);

create policy "scheduler clinical delete team links" on patient_care_team
for delete to authenticated using (
  has_app_role(array['SCHEDULER']::app_role[])
  or (has_app_role(array['CLINICAL']::app_role[]) and can_access_patient(patient_id))
);
