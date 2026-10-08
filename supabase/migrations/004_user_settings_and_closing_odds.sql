-- Migration: per-user settings, and the closing line on each bet.
-- Run this once in your Supabase SQL editor, after 003. It's a no-op if you've
-- already run the latest schema.sql.
--
-- user_settings — one row per user, every preference in one place so the app
-- caches it offline exactly like the bets. All nullable except the two with
-- a sensible default; the app treats a missing row as "all defaults".
--   odds_format        how odds are entered and shown: american | decimal | fractional.
--                      Odds are always STORED as decimal; this is display only.
--   unit_size          dollars per unit, for showing stakes and P/L in units.
--   show_units         whether the interface shows units instead of dollars.
--   starting_bankroll  the bankroll before the first logged bet.
--   default_stake      what the quick-add form starts with.
--   loss_limit         monthly net loss at which the app warns (never blocks).
--
-- closing_odds — the price when the market closed, for closing line value
-- (CLV = odds / closing_odds − 1). Optional, > 1 when present.

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

alter table public.entries add column if not exists closing_odds numeric(8, 3);
alter table public.entries drop constraint if exists entries_closing_odds_gt_one;
alter table public.entries add  constraint entries_closing_odds_gt_one
  check (closing_odds is null or closing_odds > 1);
