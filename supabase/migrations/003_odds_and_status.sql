-- Migration: a bet can be pending, and it can carry its odds.
-- Run this once in your Supabase SQL editor, after 002. It's a no-op if you've
-- already run the latest schema.sql.
--
-- WHAT CHANGES
--   odds    decimal price the bet was placed at (1.91, 2.50 …). Nullable: older
--           bets never recorded it. Must be > 1 when present.
--   status  'pending' | 'won' | 'lost' | 'push' | 'void'. Backfilled from the
--           sign of `amount` for every existing row, so nothing you've logged
--           changes meaning.
--   amount  becomes nullable, but ONLY for pending bets: a bet that hasn't been
--           settled has no result yet, and storing 0 would make an open week
--           read as break-even. The check below ties the two together.
--
-- Statuses: pending / won / lost / push / void. `push` is a tie where the
-- stake comes back, kept distinct from a bet the book cancelled (void).
--
-- CONFLICTS BETWEEN DEVICES
-- No new column is needed. `updated_at` is now set by the client to the
-- moment the user made the edit (not the moment it synced), and an update is
-- applied only if the row's updated_at is not newer — last write wins, by
-- when the edit was made. See bettracker/README.md ("Conflicts").

alter table public.entries add column if not exists odds   numeric(8, 3);
alter table public.entries add column if not exists status text;

update public.entries
   set status = case when amount > 0 then 'won'
                     when amount < 0 then 'lost'
                     else 'push' end
 where status is null;

alter table public.entries alter column status set not null;
alter table public.entries alter column amount drop not null;

alter table public.entries drop constraint if exists entries_odds_gt_one;
alter table public.entries add  constraint entries_odds_gt_one
  check (odds is null or odds > 1);

alter table public.entries drop constraint if exists entries_status_known;
alter table public.entries add  constraint entries_status_known
  check (status in ('pending', 'won', 'lost', 'push', 'void'));

-- A pending bet has no amount; a settled one always does. Push and void give
-- the stake back, so their net result is exactly 0.
alter table public.entries drop constraint if exists entries_amount_matches_status;
alter table public.entries add  constraint entries_amount_matches_status
  check (
    (status = 'pending' and amount is null)
    or (status in ('won', 'lost') and amount is not null)
    or (status in ('push', 'void') and amount = 0)
  );

create index if not exists entries_user_pending_idx
  on public.entries (user_id, date) where status = 'pending';
