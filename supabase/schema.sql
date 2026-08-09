-- BetTracker database schema.
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- It creates the entries table, locks it down so each user only sees their own
-- rows, and turns on realtime so devices stay in sync.

create table if not exists public.entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  date       date not null,
  -- NET result of the bet: positive when it won, negative when it lost, 0 push.
  amount     numeric(12, 2) not null,
  -- How much was risked. Nullable: bets logged before stake tracking existed
  -- have no recorded stake, and those rows are excluded from ROI rather than
  -- given an invented one. 0 is valid (free bets / risk-free promos).
  stake      numeric(12, 2),
  note       text not null default '',
  -- Optional tags, all free text so you are not boxed into a fixed list.
  sport      text not null default '',
  book       text not null default '',
  bet_type   text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint entries_stake_nonneg check (stake is null or stake >= 0)
  -- Multiple sessions per day are allowed; each row is one bet/trade, and a
  -- day's total is the sum of its rows.
);

-- Existing installs: pick up the columns added after the first release.
alter table public.entries add column if not exists stake    numeric(12, 2);
alter table public.entries add column if not exists sport    text not null default '';
alter table public.entries add column if not exists book     text not null default '';
alter table public.entries add column if not exists bet_type text not null default '';

create index if not exists entries_user_date_idx  on public.entries (user_id, date);
create index if not exists entries_user_sport_idx on public.entries (user_id, sport) where sport <> '';
create index if not exists entries_user_book_idx  on public.entries (user_id, book)  where book  <> '';

-- If you created the table before multi-session support, drop the old
-- one-per-day constraint (no-op on fresh installs).
alter table public.entries drop constraint if exists entries_user_id_date_key;

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
-- Wrapped so re-running this whole file is safe (adding a table already in the
-- publication would otherwise error).
do $$
begin
  alter publication supabase_realtime add table public.entries;
exception
  when duplicate_object then null;
end $$;
