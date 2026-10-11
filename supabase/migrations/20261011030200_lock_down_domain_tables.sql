-- Secure-by-default gate for clinical data.
-- Service-role jobs can seed and administer these tables. Authenticated access
-- is added table-by-table only after the corresponding app session is real.

begin;

do $do$
declare table_name text;
begin
  foreach table_name in array array[
    'locations', 'patients', 'services', 'service_durations',
    'service_requirements', 'patient_service_requirements', 'authorizations',
    'providers', 'provider_credentials', 'provider_services',
    'provider_availability', 'patient_availability', 'patient_preferences',
    'patient_restrictions', 'resources', 'service_resources', 'appointments',
    'appointment_resources', 'optimization_requests', 'optimization_results',
    'optimization_changes', 'audit_log'
  ] loop
    execute format('alter table %I enable row level security', table_name);
  end loop;
end $do$;

commit;
