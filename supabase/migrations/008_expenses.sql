-- Migration: everyday expenses (the Expenses view): cards, expenses and
-- monthly budgets, plus the currency expenses are shown in.
-- Run this once in your Supabase SQL editor, after 007 (the new tables use
-- 007's triggers) and 004 (it adds a column to user_settings). It's a no-op
-- if you've already run the latest schema.sql (or this file before).
--
-- expense_cards    the user's cards: a name, the last 4 digits (optional),
--                  credit or debit. "Deleting" a card that has expenses
--                  archives it, so old expenses keep its name.
-- expenses         one row per expense. amount is signed: + money spent,
--                  − a refund or credit, never 0. card_id is a card's id or
--                  null, and deliberately has NO foreign key: cards and
--                  expenses sync through separate queues on the device, so
--                  an expense can reach the server before its card. An id
--                  with no card shows as "No card". source says whether it
--                  was typed or read from a picture by AI.
-- expense_budgets  monthly limits, the same every month: one for the whole
--                  month (scope 'total', target ''), per card (target = the
--                  card's id) or per category (target = the category key).
--                  The app makes each row's id from (user, scope, target), so
--                  two devices setting the same budget meet on one row.
-- user_settings.expense_currency  the ISO 4217 code expenses are shown in.
--                  Changing it converts nothing.
--
-- updated_at is set by the device to the moment of the edit and is the
-- conflict key, as for bets and moves (see 003, 005): no trigger touches it.
-- A deleted row stays deleted (007). The app keeps working before this runs:
-- what is added waits on the device and is sent once this has run.

do $$
begin
  if to_regprocedure('public.remember_deleted_row()') is null
     or to_regprocedure('public.skip_deleted_row()') is null then
    raise exception 'Run 007_deleted_rows.sql before 008_expenses.sql';
  end if;
  if to_regclass('public.user_settings') is null then
    raise exception 'Run 004_user_settings_and_closing_odds.sql before 008_expenses.sql';
  end if;
end $$;

-- The currency expenses are shown in (bets stay in dollars).
alter table public.user_settings add column if not exists expense_currency text not null default 'USD';
alter table public.user_settings drop constraint if exists user_settings_expense_currency;
alter table public.user_settings add  constraint user_settings_expense_currency check (expense_currency ~ '^[A-Z]{3}$');

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
