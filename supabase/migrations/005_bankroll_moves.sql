-- Migration: deposits and withdrawals, so the app can track a bankroll.
-- Run this once in your Supabase SQL editor. It doesn't depend on 004, so the
-- two can run in either order, and it's a no-op if you've already run the
-- latest schema.sql (or this file before).
--
-- bankroll_moves — one row per deposit or withdrawal. The bankroll the app
-- shows is the starting bankroll (user_settings, 004), plus every move, plus
-- the net result of every settled bet. No change to entries or user_settings.
--   amount      signed: + a deposit, − a withdrawal. Never 0. The check runs on
--               the value as stored, rounded to cents, so 0.004 is refused like
--               0 (the app rounds the same way before it queues a move).
--   note        free text, '' when there is none.
--   updated_at  set by the device to the moment of the edit, not the moment it
--               synced: an update applies only if the row's updated_at is not
--               newer, as for bets (see 003). No trigger touches it.
--
-- The app keeps working before this runs: deposits and withdrawals wait on the
-- device, and are sent once the table exists.

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
