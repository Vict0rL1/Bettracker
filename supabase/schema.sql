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
  -- The price when the market closed, for closing line value. Optional.
  closing_odds numeric(8, 3),
  -- pending | won | lost | push | void. `push` is a tie (stake returned),
  -- kept distinct from a bet the book cancelled (void).
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
  constraint entries_closing_odds_gt_one check (closing_odds is null or closing_odds > 1),
  constraint entries_status_known check (status in ('pending', 'won', 'lost', 'push', 'void')),
  -- A pending bet has no amount; a settled one always does. Push and void give
  -- the stake back, so their net result is exactly 0.
  constraint entries_amount_matches_status check (
    (status = 'pending' and amount is null)
    or (status in ('won', 'lost') and amount is not null)
    or (status in ('push', 'void') and amount is not null and amount = 0)
  )
  -- Several bets can share a date; each row is one bet, and a day's total is
  -- the sum of its settled rows.
);

-- Existing installs: pick up the columns added after the first release
-- (migrations 002, 003 and 004, in order; each is a no-op once applied).
alter table public.entries add column if not exists stake    numeric(12, 2);
alter table public.entries drop constraint if exists entries_stake_nonneg;
alter table public.entries add  constraint entries_stake_nonneg check (stake is null or stake >= 0);
alter table public.entries add column if not exists sport    text not null default '';
alter table public.entries add column if not exists book     text not null default '';
alter table public.entries add column if not exists bet_type text not null default '';
alter table public.entries add column if not exists odds     numeric(8, 3);
alter table public.entries add column if not exists status   text;

-- Apps built before this migration don't know about statuses: they send an
-- amount and no status. Rather than refuse their writes once status is NOT
-- NULL, the row gets the status its amount implies (the backfill's rule). An
-- update that changes the amount but keeps a status that no longer fits it
-- (an older app editing a won bet into a loss) gets it worked out the same
-- way, except that a pending bet sent back as $0 stays pending (an older app
-- shows it that way). "Fits" is the app's rule: won nets more than 0, lost less than 0,
-- push and void exactly 0, pending nothing. The current app always sends a
-- status that fits, so this never changes its writes. Created before the
-- backfill, so a row written while this file runs is covered too.
create or replace function public.entries_status_from_amount()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- An older app shows a pending bet as $0 and sends that 0 back on any edit,
  -- even one that only fixes the note: the bet stays pending.
  if tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'pending' and new.amount = 0 then
    new.amount := null;
  end if;
  if new.status is null
     or (tg_op = 'UPDATE'
         and new.status = old.status
         and not coalesce(
           (new.status = 'pending' and new.amount is null)
           or (new.status = 'won' and new.amount > 0)
           or (new.status = 'lost' and new.amount < 0)
           or (new.status in ('push', 'void') and new.amount = 0),
           false)) then
    new.status := case when new.amount is null then 'pending'
                       when new.amount > 0 then 'won'
                       when new.amount < 0 then 'lost'
                       else 'push' end;
  end if;
  return new;
end;
$$;

drop trigger if exists entries_status_from_amount on public.entries;
create trigger entries_status_from_amount
  before insert or update on public.entries
  for each row execute function public.entries_status_from_amount();

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
  or (status in ('push', 'void') and amount is not null and amount = 0)
);
alter table public.entries add column if not exists closing_odds numeric(8, 3);
alter table public.entries drop constraint if exists entries_closing_odds_gt_one;
alter table public.entries add  constraint entries_closing_odds_gt_one
  check (closing_odds is null or closing_odds > 1);

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

-- Per-user settings: one row per user, cached offline like the bets. Odds are
-- always stored as decimal; odds_format only decides how they are shown.
-- A missing row means "all defaults".
create table if not exists public.user_settings (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  odds_format       text not null default 'american',
  unit_size         numeric(12, 2),
  show_units        boolean not null default false,
  starting_bankroll numeric(12, 2),
  default_stake     numeric(12, 2),
  loss_limit        numeric(12, 2),
  updated_at        timestamptz not null default now(),
  constraint user_settings_odds_format check (odds_format in ('american', 'decimal', 'fractional')),
  constraint user_settings_unit_size   check (unit_size is null or unit_size > 0),
  constraint user_settings_bankroll    check (starting_bankroll is null or starting_bankroll >= 0),
  constraint user_settings_stake       check (default_stake is null or default_stake >= 0),
  constraint user_settings_loss_limit  check (loss_limit is null or loss_limit > 0)
);

alter table public.user_settings enable row level security;

drop policy if exists "settings are private - select" on public.user_settings;
create policy "settings are private - select"
  on public.user_settings for select
  using (auth.uid() = user_id);

drop policy if exists "settings are private - insert" on public.user_settings;
create policy "settings are private - insert"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

drop policy if exists "settings are private - update" on public.user_settings;
create policy "settings are private - update"
  on public.user_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "settings are private - delete" on public.user_settings;
create policy "settings are private - delete"
  on public.user_settings for delete
  using (auth.uid() = user_id);

do $$
begin
  alter publication supabase_realtime add table public.user_settings;
exception
  when duplicate_object then null;
end $$;
