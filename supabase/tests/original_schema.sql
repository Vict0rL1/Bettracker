-- TEST FIXTURE — do not run this in Supabase.
-- The schema as BetTracker first shipped it (before migration 001): one
-- entry per day, an amount and a note. supabase/tests/run.sh upgrades it with
-- the migrations and with schema.sql to check both paths.

create table if not exists public.entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  date       date not null,
  amount     numeric(12, 2) not null,
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, date)          -- one entry per day, per user
);

create index if not exists entries_user_date_idx on public.entries (user_id, date);

-- Row-level security: a signed-in user can only touch rows they own.
alter table public.entries enable row level security;

drop policy if exists "entries are private - select" on public.entries;
create policy "entries are private - select"
  on public.entries for select
  using (auth.uid() = user_id);

drop policy if exists "entries are private - insert" on public.entries;
create policy "entries are private - insert"
  on public.entries for insert
  with check (auth.uid() = user_id);

drop policy if exists "entries are private - update" on public.entries;
create policy "entries are private - update"
  on public.entries for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "entries are private - delete" on public.entries;
create policy "entries are private - delete"
  on public.entries for delete
  using (auth.uid() = user_id);

-- Broadcast row changes to subscribed clients (the live cross-device sync).
alter publication supabase_realtime add table public.entries;
