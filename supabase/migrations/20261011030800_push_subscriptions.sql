begin;
create table push_subscriptions(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id,endpoint)
);
alter table push_subscriptions enable row level security;
create policy "own push subscriptions read" on push_subscriptions for select to authenticated using(user_id=auth.uid());
create policy "own push subscriptions insert" on push_subscriptions for insert to authenticated with check(user_id=auth.uid());
create policy "own push subscriptions update" on push_subscriptions for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy "own push subscriptions delete" on push_subscriptions for delete to authenticated using(user_id=auth.uid());
create trigger push_subscriptions_set_updated_at before update on push_subscriptions for each row execute function set_updated_at();
commit;
