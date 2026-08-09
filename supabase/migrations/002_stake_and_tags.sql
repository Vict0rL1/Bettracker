-- Migration: track the stake behind each bet, plus optional tags.
-- Run this once in your Supabase SQL editor (SQL Editor -> New query -> paste ->
-- Run). It's a no-op if you've already run the latest schema.sql.
--
-- Existing rows are untouched. `amount` keeps meaning exactly what it did — the
-- NET result of the bet (profit when green, loss when red). What's new is
-- `stake`: how much was risked to get that result, which is what makes ROI
-- ("yield") computable.
--
--   ROI = sum(amount) / sum(stake) * 100, over bets that have a stake.
--
-- `stake` is nullable on purpose: bets logged before this migration have no
-- recorded stake, and guessing one would invent numbers. Those rows still count
-- toward P/L and win rate; they're simply excluded from ROI, and the app tells
-- you how many are missing a stake.

alter table public.entries add column if not exists stake    numeric(12, 2);
alter table public.entries add column if not exists sport    text not null default '';
alter table public.entries add column if not exists book     text not null default '';
alter table public.entries add column if not exists bet_type text not null default '';

-- A stake is an amount risked: never negative, and absent (null) rather than 0
-- when unknown. 0 is allowed for free bets / risk-free promos.
alter table public.entries drop constraint if exists entries_stake_nonneg;
alter table public.entries add  constraint entries_stake_nonneg
  check (stake is null or stake >= 0);

-- Speeds up the per-tag breakdowns for users with a lot of history.
create index if not exists entries_user_sport_idx on public.entries (user_id, sport) where sport <> '';
create index if not exists entries_user_book_idx  on public.entries (user_id, book)  where book  <> '';
