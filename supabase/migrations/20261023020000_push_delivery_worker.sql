begin;

-- Push is an operational delivery channel for authenticated staff. The
-- browser-facing notification content remains in `notifications`; this
-- private ledger stores only delivery state and opaque record identifiers.
create table push_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications(id) on delete cascade,
  subscription_id uuid references push_subscriptions(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'PENDING' check (status in (
    'PENDING','PROCESSING','RETRY','ACCEPTED','PERMANENT_FAILURE','SUPPRESSED'
  )),
  attempt_count int not null default 0 check (attempt_count between 0 and 5),
  available_at timestamptz not null default now(),
  processing_token uuid,
  worker_id text,
  lease_expires_at timestamptz,
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,100}$'
  ),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(notification_id, subscription_id),
  check (
    (status='PROCESSING' and processing_token is not null and worker_id is not null and lease_expires_at is not null)
    or
    (status<>'PROCESSING' and processing_token is null and worker_id is null and lease_expires_at is null)
  ),
  check (
    (status='ACCEPTED' and accepted_at is not null)
    or
    (status<>'ACCEPTED' and accepted_at is null)
  )
);
create index push_notification_deliveries_ready_idx
  on push_notification_deliveries(status, available_at, created_at)
  where status in ('PENDING','RETRY');
create index push_notification_deliveries_user_idx
  on push_notification_deliveries(user_id, created_at desc);
create trigger push_notification_deliveries_set_updated_at
before update on push_notification_deliveries
for each row execute function set_updated_at();

alter table push_notification_deliveries enable row level security;
revoke all on push_notification_deliveries from public, anon, authenticated;
grant select, insert, update, delete on push_notification_deliveries to service_role;

-- Fan out new user/role notifications, release expired leases, suppress work
-- that is no longer eligible, and atomically lease one bounded batch. A new
-- device never receives notifications created before it subscribed.
create function claim_push_notification_deliveries(
  p_limit int,
  p_worker_id text
)
returns table(
  delivery_id uuid,
  processing_token uuid,
  endpoint text,
  p256dh text,
  auth text,
  severity text,
  expires_at timestamptz
)
language plpgsql security definer set search_path=public,pg_catalog as $claim$
declare
  v_now timestamptz:=clock_timestamp();
begin
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'Push delivery batch size must be between 1 and 100';
  end if;
  if length(trim(coalesce(p_worker_id,''))) not between 3 and 100 then
    raise exception 'A valid push worker identifier is required';
  end if;

  delete from push_notification_deliveries d
  where d.status in ('ACCEPTED','PERMANENT_FAILURE','SUPPRESSED')
    and d.updated_at<v_now-interval '90 days';

  update push_notification_deliveries d set
    status=case when d.attempt_count>=5 then 'PERMANENT_FAILURE' else 'RETRY' end,
    available_at=case
      when d.attempt_count>=5 then d.available_at
      else v_now+make_interval(secs=>least(3600,60*(2^greatest(0,d.attempt_count-1)))::int)
    end,
    processing_token=null,
    worker_id=null,
    lease_expires_at=null,
    last_error_code='LEASE_EXPIRED'
  where d.status='PROCESSING' and d.lease_expires_at<v_now;

  update push_notification_deliveries d set
    status='SUPPRESSED',
    processing_token=null,
    worker_id=null,
    lease_expires_at=null,
    last_error_code='NO_LONGER_ELIGIBLE'
  where d.status in ('PENDING','RETRY')
    and not exists(
      select 1
      from notifications n
      join user_profiles up on up.user_id=d.user_id and up.active
      join push_subscriptions ps on ps.id=d.subscription_id
        and ps.user_id=d.user_id and ps.enabled
      where n.id=d.notification_id
        and (n.expires_at is null or n.expires_at>v_now)
        and n.read_at is null
        and (
          n.user_id=d.user_id
          or (n.user_id is null and n.role=up.role)
        )
        and not exists(
          select 1 from notification_receipts nr
          where nr.notification_id=n.id and nr.user_id=d.user_id
            and (nr.read_at is not null or nr.dismissed_at is not null)
        )
    );

  insert into push_notification_deliveries(notification_id,subscription_id,user_id)
  select n.id,ps.id,ps.user_id
  from notifications n
  join user_profiles up on up.active
    and (n.user_id=up.user_id or (n.user_id is null and n.role=up.role))
  join push_subscriptions ps on ps.user_id=up.user_id and ps.enabled
  where n.created_at>=v_now-interval '7 days'
    and n.created_at>=ps.created_at
    and n.created_at>=coalesce(up.access_changed_at,up.created_at)
    and (n.expires_at is null or n.expires_at>v_now)
    and n.read_at is null
    and not exists(
      select 1 from notification_receipts nr
      where nr.notification_id=n.id and nr.user_id=up.user_id
        and (nr.read_at is not null or nr.dismissed_at is not null)
    )
  order by n.created_at,ps.created_at,ps.id
  limit least(p_limit*20,2000)
  on conflict(notification_id,subscription_id) do nothing;

  return query
  with candidates as (
    select d.id
    from push_notification_deliveries d
    join notifications n on n.id=d.notification_id
    join user_profiles up on up.user_id=d.user_id and up.active
      and (n.user_id=d.user_id or (n.user_id is null and n.role=up.role))
    join push_subscriptions ps on ps.id=d.subscription_id
      and ps.user_id=d.user_id and ps.enabled
    where d.status in ('PENDING','RETRY')
      and d.available_at<=v_now
      and d.attempt_count<5
      and (n.expires_at is null or n.expires_at>v_now)
      and n.read_at is null
      and not exists(
        select 1 from notification_receipts nr
        where nr.notification_id=n.id and nr.user_id=d.user_id
          and (nr.read_at is not null or nr.dismissed_at is not null)
      )
    order by
      case n.severity when 'CRITICAL' then 0 when 'WARNING' then 1 else 2 end,
      n.created_at,d.created_at,d.id
    for update of d skip locked
    limit p_limit
  ), claimed as (
    update push_notification_deliveries d set
      status='PROCESSING',
      attempt_count=d.attempt_count+1,
      processing_token=gen_random_uuid(),
      worker_id=trim(p_worker_id),
      lease_expires_at=v_now+interval '5 minutes',
      last_error_code=null
    from candidates c
    where d.id=c.id
    returning d.id,d.processing_token,d.subscription_id,d.notification_id
  )
  select c.id,c.processing_token,ps.endpoint,ps.p256dh,ps.auth,n.severity,n.expires_at
  from claimed c
  join push_subscriptions ps on ps.id=c.subscription_id
  join notifications n on n.id=c.notification_id;
end
$claim$;

-- A processing token prevents a late worker from overwriting the result of a
-- newer lease. Retry delay is database-owned and capped at one hour.
create function record_push_notification_delivery(
  p_delivery_id uuid,
  p_processing_token uuid,
  p_outcome text,
  p_error_code text default null
)
returns text
language plpgsql security definer set search_path=public,pg_catalog as $record$
declare
  v_delivery push_notification_deliveries%rowtype;
  v_status text;
  v_error text;
begin
  if p_outcome not in ('ACCEPTED','RETRY','PERMANENT_FAILURE','SUPPRESSED') then
    raise exception 'Invalid push delivery outcome';
  end if;
  if p_outcome<>'ACCEPTED' then
    v_error:=upper(regexp_replace(
      coalesce(nullif(trim(p_error_code),''),'PUSH_DELIVERY_FAILED'),
      '[^A-Za-z0-9_]','_','g'
    ));
    v_error:=left(v_error,100);
  end if;

  select * into v_delivery
  from push_notification_deliveries
  where id=p_delivery_id
  for update;
  if not found then raise exception 'Push delivery was not found'; end if;
  if v_delivery.status<>'PROCESSING'
    or v_delivery.processing_token is distinct from p_processing_token then
    raise exception 'Push delivery lease is stale';
  end if;

  v_status:=case
    when p_outcome='RETRY' and v_delivery.attempt_count>=5 then 'PERMANENT_FAILURE'
    else p_outcome
  end;

  update push_notification_deliveries set
    status=v_status,
    available_at=case
      when v_status='RETRY' then
        clock_timestamp()+make_interval(secs=>least(3600,60*(2^greatest(0,v_delivery.attempt_count-1)))::int)
      else available_at
    end,
    processing_token=null,
    worker_id=null,
    lease_expires_at=null,
    last_error_code=case when v_status='ACCEPTED' then null else v_error end,
    accepted_at=case when v_status='ACCEPTED' then clock_timestamp() else null end
  where id=p_delivery_id;
  return v_status;
end
$record$;

revoke all on function claim_push_notification_deliveries(int,text) from public,anon,authenticated;
revoke all on function record_push_notification_delivery(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function claim_push_notification_deliveries(int,text) to service_role;
grant execute on function record_push_notification_delivery(uuid,uuid,text,text) to service_role;

alter function app_schema_status() rename to app_schema_status_20261023010000;
revoke all on function app_schema_status_20261023010000() from public,anon,authenticated;
create function app_schema_status()
returns jsonb
language sql stable security definer set search_path=public,pg_catalog as $status$
  select app_schema_status_20261023010000() || jsonb_build_object(
    'version','20261023020000',
    'push_delivery',
      to_regclass('public.push_notification_deliveries') is not null
      and to_regprocedure('public.claim_push_notification_deliveries(integer,text)') is not null
      and to_regprocedure('public.record_push_notification_delivery(uuid,uuid,text,text)') is not null
      and not has_table_privilege('authenticated','public.push_notification_deliveries','SELECT,INSERT,UPDATE,DELETE')
  )
$status$;
revoke all on function app_schema_status() from public;
grant execute on function app_schema_status() to anon,authenticated;

commit;
