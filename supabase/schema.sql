-- BetTracker database schema.
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- It creates the tables (the bets, per-user settings, deposits and
-- withdrawals, and everyday expenses (cards, expenses, monthly budgets)),
-- locks them down so each user only sees their own rows, and turns on
-- realtime so devices stay in sync. It is safe to run again, and on an older
-- install it does what migrations 001..009 do.

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
-- shows it that way). "Fits" is the app's rule: won nets more than 0, lost less than 0
-- (or exactly 0 for a free bet, a stake of 0: migration 006), push and void
-- exactly 0, pending nothing. The current app always sends a
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
           or (new.status = 'lost' and (new.amount < 0 or (new.amount = 0 and new.stake = 0)))
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
  -- The ISO 4217 code expenses are shown in (migration 008); bets stay in
  -- dollars. Changing it converts nothing.
  expense_currency  text not null default 'USD',
  updated_at        timestamptz not null default now(),
  constraint user_settings_odds_format check (odds_format in ('american', 'decimal', 'fractional')),
  constraint user_settings_unit_size   check (unit_size is null or unit_size > 0),
  constraint user_settings_bankroll    check (starting_bankroll is null or starting_bankroll >= 0),
  constraint user_settings_stake       check (default_stake is null or default_stake >= 0),
  constraint user_settings_loss_limit  check (loss_limit is null or loss_limit > 0),
  constraint user_settings_expense_currency check (expense_currency ~ '^[A-Z]{3}$')
);

-- Existing installs: the currency expenses are shown in (migration 008).
alter table public.user_settings add column if not exists expense_currency text not null default 'USD';
alter table public.user_settings drop constraint if exists user_settings_expense_currency;
alter table public.user_settings add  constraint user_settings_expense_currency check (expense_currency ~ '^[A-Z]{3}$');

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

-- Deposits and withdrawals (migration 005): + money put in, − money taken out,
-- never 0. The bankroll is the starting bankroll plus every move plus the
-- settled bets. updated_at is the device's edit time, the conflict key, as
-- for bets.
create table if not exists public.bankroll_moves (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  date       date not null,
  -- + deposit, − withdrawal; never 0 (checked after numeric(12,2) rounding)
  amount     numeric(12, 2) not null,
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bankroll_moves_amount_nonzero check (amount <> 0)
);

create index if not exists bankroll_moves_user_date_idx on public.bankroll_moves (user_id, date);

alter table public.bankroll_moves enable row level security;

drop policy if exists "moves are private - select" on public.bankroll_moves;
create policy "moves are private - select"
  on public.bankroll_moves for select
  using (auth.uid() = user_id);

drop policy if exists "moves are private - insert" on public.bankroll_moves;
create policy "moves are private - insert"
  on public.bankroll_moves for insert
  with check (auth.uid() = user_id);

drop policy if exists "moves are private - update" on public.bankroll_moves;
create policy "moves are private - update"
  on public.bankroll_moves for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "moves are private - delete" on public.bankroll_moves;
create policy "moves are private - delete"
  on public.bankroll_moves for delete
  using (auth.uid() = user_id);

do $$
begin
  alter publication supabase_realtime add table public.bankroll_moves;
exception
  when duplicate_object then null;
end $$;

-- A deleted bet, deposit or withdrawal stays deleted (migration 007): the
-- database remembers each deleted row's last updated_at, and an insert of
-- that id that is not newer (an old insert sent again after its answer was
-- lost) is let go. A newer one is a deliberate re-add and goes in. No client
-- can read or write the record: only these triggers, as their owner.
create table if not exists public.deleted_rows (
  table_name text not null,
  id         uuid not null,
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- The deleted row's updated_at: the device time of its content when it went.
  stamp      timestamptz not null,
  deleted_at timestamptz not null default now(),
  primary key (table_name, id)
);

-- Row-level security with no policies: requests from the app (anon,
-- authenticated) can't see or change it. The triggers' functions run as
-- their owner, which can.
alter table public.deleted_rows enable row level security;
revoke all on public.deleted_rows from public;
do $$
begin
  revoke all on public.deleted_rows from anon;
exception when undefined_object then null;
end $$;
do $$
begin
  revoke all on public.deleted_rows from authenticated;
exception when undefined_object then null;
end $$;

create or replace function public.remember_deleted_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The account itself is going (on delete cascade): nothing to remember.
  if not exists (select 1 from auth.users u where u.id = old.user_id) then
    return old;
  end if;
  insert into public.deleted_rows (table_name, id, user_id, stamp)
  values (tg_table_name, old.id, old.user_id, old.updated_at)
  on conflict (table_name, id) do update
    set stamp = greatest(public.deleted_rows.stamp, excluded.stamp),
        user_id = excluded.user_id,
        deleted_at = now();
  return old;
end;
$$;

create or replace function public.skip_deleted_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- An insert of a row deleted since, no newer than what was deleted: an old
  -- insert sent again. Let go without an error (nothing comes back).
  if exists (
    select 1 from public.deleted_rows d
     where d.table_name = tg_table_name
       and d.id = new.id
       and d.user_id = new.user_id
       and d.stamp >= new.updated_at
  ) then
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.remember_deleted_row() from public;
revoke all on function public.skip_deleted_row() from public;

drop trigger if exists entries_remember_deleted on public.entries;
create trigger entries_remember_deleted
  after delete on public.entries
  for each row execute function public.remember_deleted_row();

drop trigger if exists entries_skip_deleted on public.entries;
create trigger entries_skip_deleted
  before insert on public.entries
  for each row execute function public.skip_deleted_row();

drop trigger if exists bankroll_moves_remember_deleted on public.bankroll_moves;
create trigger bankroll_moves_remember_deleted
  after delete on public.bankroll_moves
  for each row execute function public.remember_deleted_row();

drop trigger if exists bankroll_moves_skip_deleted on public.bankroll_moves;
create trigger bankroll_moves_skip_deleted
  before insert on public.bankroll_moves
  for each row execute function public.skip_deleted_row();

-- Everyday expenses (migration 008): the user's cards, one row per expense
-- (amount signed: + spent, − refund or credit, never 0; card_id is a card's
-- id or null, with NO foreign key, since cards and expenses sync through
-- separate queues on the device), and monthly budgets (total, per card, per
-- category), whose ids the app makes from (user, scope, target) so two
-- devices setting the same budget meet on one row. updated_at is the device's
-- edit time, the conflict key: no trigger touches it. A deleted card, expense
-- or budget stays deleted (the 007 triggers above).
create table if not exists public.expense_cards (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  last4      text not null default '',
  kind       text not null default 'credit',
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expense_cards_name_length check (name = btrim(name) and char_length(name) between 1 and 40),
  constraint expense_cards_last4_digits check (last4 = '' or last4 ~ '^[0-9]{4}$'),
  constraint expense_cards_kind_known check (kind in ('credit', 'debit'))
);

create index if not exists expense_cards_user_idx on public.expense_cards (user_id);

create table if not exists public.expenses (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  date       date not null,
  -- + spent, − refund or credit; never 0 (checked after numeric(12,2) rounding)
  amount     numeric(12, 2) not null,
  -- a card's id, or null; no foreign key (see above)
  card_id    uuid,
  merchant   text not null default '',
  category   text not null default 'other',
  note       text not null default '',
  source     text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expenses_amount_nonzero check (amount <> 0),
  constraint expenses_amount_range check (abs(amount) <= 100000000),
  constraint expenses_merchant_length check (char_length(merchant) <= 80),
  constraint expenses_note_length check (char_length(note) <= 500),
  constraint expenses_category_known check (category in ('coffee', 'food', 'groceries', 'transport', 'shopping', 'entertainment', 'health', 'home', 'subscriptions', 'travel', 'other')),
  constraint expenses_source_known check (source in ('manual', 'ai'))
);

create index if not exists expenses_user_date_idx on public.expenses (user_id, date);

create table if not exists public.expense_budgets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  scope         text not null,
  target        text not null default '',
  monthly_limit numeric(12, 2) not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint expense_budgets_scope_known check (scope in ('total', 'card', 'category')),
  constraint expense_budgets_target_fits check (
    (scope = 'total' and target = '')
    or (scope = 'card' and target ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (scope = 'category' and target in ('coffee', 'food', 'groceries', 'transport', 'shopping', 'entertainment', 'health', 'home', 'subscriptions', 'travel', 'other'))
  ),
  constraint expense_budgets_limit_positive check (monthly_limit > 0 and monthly_limit <= 100000000),
  constraint expense_budgets_one_per_target unique (user_id, scope, target)
);

alter table public.expense_cards enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_budgets enable row level security;

drop policy if exists "expense cards are private - select" on public.expense_cards;
create policy "expense cards are private - select" on public.expense_cards for select using (auth.uid() = user_id);
drop policy if exists "expense cards are private - insert" on public.expense_cards;
create policy "expense cards are private - insert" on public.expense_cards for insert with check (auth.uid() = user_id);
drop policy if exists "expense cards are private - update" on public.expense_cards;
create policy "expense cards are private - update" on public.expense_cards for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "expense cards are private - delete" on public.expense_cards;
create policy "expense cards are private - delete" on public.expense_cards for delete using (auth.uid() = user_id);

drop policy if exists "expenses are private - select" on public.expenses;
create policy "expenses are private - select" on public.expenses for select using (auth.uid() = user_id);
drop policy if exists "expenses are private - insert" on public.expenses;
create policy "expenses are private - insert" on public.expenses for insert with check (auth.uid() = user_id);
drop policy if exists "expenses are private - update" on public.expenses;
create policy "expenses are private - update" on public.expenses for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "expenses are private - delete" on public.expenses;
create policy "expenses are private - delete" on public.expenses for delete using (auth.uid() = user_id);

drop policy if exists "expense budgets are private - select" on public.expense_budgets;
create policy "expense budgets are private - select" on public.expense_budgets for select using (auth.uid() = user_id);
drop policy if exists "expense budgets are private - insert" on public.expense_budgets;
create policy "expense budgets are private - insert" on public.expense_budgets for insert with check (auth.uid() = user_id);
drop policy if exists "expense budgets are private - update" on public.expense_budgets;
create policy "expense budgets are private - update" on public.expense_budgets for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "expense budgets are private - delete" on public.expense_budgets;
create policy "expense budgets are private - delete" on public.expense_budgets for delete using (auth.uid() = user_id);

-- Supabase usually exposes new tables to signed-in users by default; said
-- explicitly so a project that doesn't still works (a no-op where it does).
grant select, insert, update, delete on public.expense_cards, public.expenses, public.expense_budgets to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.expense_cards;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.expenses;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.expense_budgets;
exception when duplicate_object then null;
end $$;

-- A deleted card, expense or budget stays deleted (007's generic functions).
drop trigger if exists expense_cards_remember_deleted on public.expense_cards;
create trigger expense_cards_remember_deleted after delete on public.expense_cards for each row execute function public.remember_deleted_row();
drop trigger if exists expense_cards_skip_deleted on public.expense_cards;
create trigger expense_cards_skip_deleted before insert on public.expense_cards for each row execute function public.skip_deleted_row();
drop trigger if exists expenses_remember_deleted on public.expenses;
create trigger expenses_remember_deleted after delete on public.expenses for each row execute function public.remember_deleted_row();
drop trigger if exists expenses_skip_deleted on public.expenses;
create trigger expenses_skip_deleted before insert on public.expenses for each row execute function public.skip_deleted_row();
drop trigger if exists expense_budgets_remember_deleted on public.expense_budgets;
create trigger expense_budgets_remember_deleted after delete on public.expense_budgets for each row execute function public.remember_deleted_row();
drop trigger if exists expense_budgets_skip_deleted on public.expense_budgets;
create trigger expense_budgets_skip_deleted before insert on public.expense_budgets for each row execute function public.skip_deleted_row();

-- An expense paid in another currency (migration 009). amount stays the
-- amount in the user's expense currency (user_settings.expense_currency):
-- every total, budget and chart reads it. original_amount and
-- original_currency say what was actually paid (signed like amount), and
-- fx_rate is units of the expense currency per 1 unit of the original. All
-- three null (an expense in the user's own currency) or all three set. amount
-- is normally round(original_amount * fx_rate), but the user may type what
-- the bank statement says (banks add their own fee), so nothing insists the
-- three multiply out.
alter table public.expenses add column if not exists original_amount   numeric(12, 2);
alter table public.expenses add column if not exists original_currency text;
alter table public.expenses add column if not exists fx_rate           numeric(18, 8);

alter table public.expenses drop constraint if exists expenses_original_all_or_none;
alter table public.expenses add  constraint expenses_original_all_or_none check (
  (original_amount is null and original_currency is null and fx_rate is null)
  or (original_amount is not null and original_currency is not null and fx_rate is not null)
);
-- Never 0 and the same bound as amount (checked after numeric(12,2) rounding).
alter table public.expenses drop constraint if exists expenses_original_amount_range;
alter table public.expenses add  constraint expenses_original_amount_range check (original_amount <> 0 and abs(original_amount) <= 100000000);
-- A refund is a refund in both currencies.
alter table public.expenses drop constraint if exists expenses_original_same_sign;
alter table public.expenses add  constraint expenses_original_same_sign check (sign(original_amount) = sign(amount));
alter table public.expenses drop constraint if exists expenses_original_currency_code;
alter table public.expenses add  constraint expenses_original_currency_code check (original_currency ~ '^[A-Z]{3}$');
alter table public.expenses drop constraint if exists expenses_fx_rate_positive;
alter table public.expenses add  constraint expenses_fx_rate_positive check (fx_rate > 0);
