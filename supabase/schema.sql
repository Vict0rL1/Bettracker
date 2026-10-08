-- BetTracker database schema.
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- It creates the entries table, locks it down so each user only sees their own
-- rows, and turns on realtime so devices stay in sync.

create table if not exists public.entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  date       date not null,
  -- NET result of the bet: positive when it won, negative when it lost, 0 for
  -- a push or a void. Null ONLY while the bet is pending (see the check below).
  amount     numeric(12, 2),
  -- How much was risked. Nullable: bets logged before stake tracking existed
  -- have no recorded stake, and those rows are excluded from ROI rather than
  -- given an invented one. 0 is valid (free bets / risk-free promos).
  stake      numeric(12, 2),
  -- Decimal odds the bet was placed at. Nullable: older bets never recorded it.
  odds       numeric(8, 3),
  -- pending | won | lost | push | void. Names shared with the Sports Predictor
  -- where they overlap, so rows can move between the two apps later.
  status     text not null,
  note       text not null default '',
  -- Optional tags, all free text so you are not boxed into a fixed list.
  sport      text not null default '',
  book       text not null default '',
  bet_type   text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint entries_stake_nonneg check (stake is null or stake >= 0),
  constraint entries_odds_gt_one  check (odds is null or odds > 1),
  constraint entries_status_known check (status in ('pending', 'won', 'lost', 'push', 'void')),
  -- A pending bet has no amount; a settled one always does. Push and void give
  -- the stake back, so their net result is exactly 0.
  constraint entries_amount_matches_status check (
    (status = 'pending' and amount is null)
    or (status in ('won', 'lost') and amount is not null)
    or (status in ('push', 'void') and amount = 0)
  )
  -- Several bets can share a date; each row is one bet, and a day's total is
  -- the sum of its settled rows.
);

-- Existing installs: pick up the columns added after the first release
-- (migrations 002 and 003, in order; each is a no-op once applied).
alter table public.entries add column if not exists stake    numeric(12, 2);
alter table public.entries add column if not exists sport    text not null default '';
alter table public.entries add column if not exists book     text not null default '';
alter table public.entries add column if not exists bet_type text not null default '';
alter table public.entries add column if not exists odds     numeric(8, 3);
alter table public.entries add column if not exists status   text;
update public.entries
   set status = case when amount > 0 then 'won' when amount < 0 then 'lost' else 'push' end
 where status is null;
alter table public.entries alter column status set not null;
alter table public.entries alter column amount drop not null;
alter table public.entries drop constraint if exists entries_odds_gt_one;
alter table public.entries add  constraint entries_odds_gt_one check (odds is null or odds > 1);
alter table public.entries drop constraint if exists entries_status_known;
alter table public.entries add  constraint entries_status_known
  check (status in ('pending', 'won', 'lost', 'push', 'void'));
alter table public.entries drop constraint if exists entries_amount_matches_status;
alter table public.entries add  constraint entries_amount_matches_status check (
  (status = 'pending' and amount is null)
  or (status in ('won', 'lost') and amount is not null)
  or (status in ('push', 'void') and amount = 0)
);

create index if not exists entries_user_date_idx  on public.entries (user_id, date);
create index if not exists entries_user_sport_idx on public.entries (user_id, sport) where sport <> '';
create index if not exists entries_user_book_idx  on public.entries (user_id, book)  where book  <> '';
create index if not exists entries_user_pending_idx on public.entries (user_id, date) where status = 'pending';

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
