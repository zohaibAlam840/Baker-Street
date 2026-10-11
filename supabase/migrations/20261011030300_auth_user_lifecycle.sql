begin;

alter table user_profiles add column requested_role app_role;
alter table user_profiles add column approved_at timestamptz;
alter table user_profiles add column approved_by uuid references auth.users(id) on delete set null;
alter table user_profiles alter column active set default false;

create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare requested app_role;
begin
  requested := case
    when new.raw_user_meta_data->>'requested_role' in
      ('SCHEDULER','CLINICAL','PROVIDER','AUTHORIZATION','OPERATIONS','ADMIN','COMPLIANCE')
    then (new.raw_user_meta_data->>'requested_role')::app_role
    else 'PROVIDER'::app_role
  end;

  insert into user_profiles (user_id, display_name, role, requested_role, active)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)),
    'PROVIDER',
    requested,
    false
  )
  on conflict (user_id) do nothing;
  return new;
end;
$fn$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function handle_new_auth_user();

-- One-time bootstrap: only the first signed-in account can establish the
-- initial administrator. Once any active profile exists this can never run.
create or replace function bootstrap_first_admin()
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists (select 1 from user_profiles where active) then return false; end if;

  update user_profiles
  set role = 'ADMIN', requested_role = 'ADMIN', active = true,
      approved_at = now(), approved_by = auth.uid()
  where user_id = auth.uid();
  return found;
end;
$fn$;

revoke all on function bootstrap_first_admin() from public;
grant execute on function bootstrap_first_admin() to authenticated;

create policy "admins read all profiles"
on user_profiles for select to authenticated
using (current_app_role() = 'ADMIN');

create policy "admins update profiles"
on user_profiles for update to authenticated
using (current_app_role() = 'ADMIN')
with check (current_app_role() = 'ADMIN');

commit;
