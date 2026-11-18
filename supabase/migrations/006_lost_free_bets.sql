-- Migration: a free bet that loses stays lost.
-- Run this once in your Supabase SQL editor, after 003. It's a no-op if
-- you've already run the latest schema.sql (or this file before).
--
-- WHAT CHANGES
-- Only the trigger 003 added. A free bet (a stake of 0, a promotion from the
-- book) that loses costs nothing, so the app stores it as status 'lost' with
-- an amount of 0. The database already accepts that row (a lost bet needs an
-- amount, any amount), but the trigger read "lost at $0" as a status that no
-- longer fits and turned it into a push on the next edit of anything else
-- (its note, a tag). From now on a lost bet at $0 whose stake is 0 fits.
-- Nothing else the trigger does changes, and no row is rewritten.
--
-- Before this runs, the app works as before: logging a lost free bet works,
-- and editing one later turns it into a push (its P/L stays $0 either way).

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
