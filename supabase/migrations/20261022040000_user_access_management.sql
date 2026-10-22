begin;

-- User access changes are security decisions. They must be serialized,
-- idempotent, and auditable rather than performed as direct table updates.
alter table user_profiles add column version int not null default 1 check (version > 0);
alter table user_profiles add column access_changed_at timestamptz;
alter table user_profiles add column access_changed_by uuid references auth.users(id) on delete set null;

create table user_access_commands (
  actor_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null,
  target_user_id uuid not null references auth.users(id) on delete restrict,
  request_payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_id,idempotency_key),
  check (length(idempotency_key) between 8 and 200)
);
alter table user_access_commands enable row level security;
revoke all on user_access_commands from public,anon,authenticated;

drop policy if exists "admins update profiles" on user_profiles;
revoke insert,update,delete on user_profiles from authenticated;

create or replace function manage_user_access(
  p_target_user_id uuid,
  p_expected_version int,
  p_role app_role,
  p_provider_id uuid,
  p_active boolean,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql security definer set search_path=public,extensions as $manage_access$
declare
  v_actor uuid:=auth.uid();
  v_target user_profiles%rowtype;
  v_existing user_access_commands%rowtype;
  v_request jsonb;
  v_result jsonb;
  v_action text;
  v_other_admins int;
begin
  if v_actor is null or current_app_role()<>'ADMIN' then
    raise exception 'System administrator access required';
  end if;
  if p_target_user_id is null or p_expected_version is null or p_expected_version<1
    or p_role is null or p_active is null then
    raise exception 'A target, current version, role, and access status are required';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 500 then
    raise exception 'An access decision reason between 3 and 500 characters is required';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) not between 8 and 200 then
    raise exception 'A valid idempotency key is required';
  end if;
  if p_role not in ('PROVIDER','CLINICAL') and p_provider_id is not null then
    raise exception 'Only provider and clinical accounts may be linked to a clinician';
  end if;
  if p_active and p_role='PROVIDER' and p_provider_id is null then
    raise exception 'Active provider accounts must be linked to a clinician';
  end if;
  if p_provider_id is not null and not exists(
    select 1 from providers where id=p_provider_id and status='ACTIVE'
  ) then
    raise exception 'The linked clinician must be active';
  end if;

  v_request:=jsonb_build_object(
    'target_user_id',p_target_user_id,'expected_version',p_expected_version,
    'role',p_role,'provider_id',p_provider_id,'active',p_active,
    'reason',trim(p_reason)
  );
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text||':USER_ACCESS:'||trim(p_idempotency_key),0));
  select * into v_existing from user_access_commands
  where actor_id=v_actor and idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.request_payload<>v_request then
      raise exception 'The access command key was already used for different data';
    end if;
    return v_existing.result||jsonb_build_object('already_applied',true);
  end if;

  -- Serialize every possible administrator demotion so two administrators
  -- cannot remove one another concurrently and leave no active administrator.
  perform pg_advisory_xact_lock(hashtextextended('USER_ACCESS_ADMIN_QUORUM',0));
  select * into v_target from user_profiles where user_id=p_target_user_id for update;
  if not found then raise exception 'User profile was not found'; end if;
  if v_target.version<>p_expected_version then
    raise exception 'User access changed; refresh before saving';
  end if;

  if v_target.active and v_target.role='ADMIN' and (not p_active or p_role<>'ADMIN') then
    select count(*) into v_other_admins from user_profiles
    where active and role='ADMIN' and user_id<>p_target_user_id;
    if v_other_admins=0 then
      raise exception 'The last active administrator cannot be removed';
    end if;
  end if;
  if p_target_user_id=v_actor
    and (p_active is distinct from v_target.active or p_role is distinct from v_target.role) then
    raise exception 'Administrators cannot change their own role or access status';
  end if;

  v_action:=case
    when p_active and not v_target.active then 'USER_ACCESS_ACTIVATED'
    when not p_active and v_target.active then 'USER_ACCESS_DEACTIVATED'
    else 'USER_ACCESS_UPDATED'
  end;

  update user_profiles set
    role=p_role,
    requested_role=p_role,
    provider_id=case when p_role in ('PROVIDER','CLINICAL') then p_provider_id else null end,
    active=p_active,
    approved_at=case when p_active then now() else approved_at end,
    approved_by=case when p_active then v_actor else approved_by end,
    access_changed_at=now(),
    access_changed_by=v_actor,
    version=version+1
  where user_id=p_target_user_id;

  insert into audit_log(user_id,action,old_values,new_values,override_reason)
  values(
    v_actor,v_action,
    jsonb_build_object(
      'target_user_id',v_target.user_id,'role',v_target.role,
      'provider_id',v_target.provider_id,'active',v_target.active,'version',v_target.version
    ),
    jsonb_build_object(
      'target_user_id',p_target_user_id,'role',p_role,
      'provider_id',case when p_role in ('PROVIDER','CLINICAL') then p_provider_id else null end,
      'active',p_active,'version',v_target.version+1
    ),
    trim(p_reason)
  );

  if p_active then
    insert into notifications(user_id,kind,title,body,href,severity,dedupe_key,expires_at)
    values(
      p_target_user_id,'ACCESS_UPDATED','Account access updated',
      'Your application role or access status was updated by an administrator.',
      '/settings','INFO','access-updated-'||p_target_user_id||'-'||(v_target.version+1),
      now()+interval '30 days'
    )
    on conflict(user_id,dedupe_key) where user_id is not null and dedupe_key is not null do nothing;
  end if;

  v_result:=jsonb_build_object(
    'target_user_id',p_target_user_id,
    'status',case when p_active then 'ACTIVE' else 'INACTIVE' end,
    'role',p_role,'version',v_target.version+1,'already_applied',false
  );
  insert into user_access_commands(actor_id,idempotency_key,target_user_id,request_payload,result)
  values(v_actor,trim(p_idempotency_key),p_target_user_id,v_request,v_result);
  return v_result;
end
$manage_access$;
revoke all on function manage_user_access(uuid,int,app_role,uuid,boolean,text,text) from public;
grant execute on function manage_user_access(uuid,int,app_role,uuid,boolean,text,text) to authenticated;

alter function app_schema_status() rename to app_schema_status_20261022030000;
revoke all on function app_schema_status_20261022030000() from public,anon,authenticated;
create function app_schema_status()
returns jsonb
language sql stable security definer set search_path=public,pg_catalog as $status$
  select app_schema_status_20261022030000() || jsonb_build_object(
    'version','20261022040000',
    'access_management',
      to_regclass('public.user_access_commands') is not null
      and to_regprocedure('public.manage_user_access(uuid,integer,app_role,uuid,boolean,text,text)') is not null
      and exists(
        select 1 from information_schema.columns
        where table_schema='public' and table_name='user_profiles' and column_name='version'
      )
      and not has_table_privilege('authenticated','public.user_profiles','INSERT,UPDATE,DELETE')
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
