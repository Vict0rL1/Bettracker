-- Migration: a deleted bet, deposit or withdrawal stays deleted.
-- Run this once in your Supabase SQL editor, after 005. It's a no-op if
-- you've already run the latest schema.sql (or this file before).
--
-- WHY
-- The app gives each bet (and each deposit or withdrawal) its id on the
-- device, so an insert whose answer was lost can be sent again safely: the
-- second time it meets its own row and changes nothing. But if the row was
-- deleted in between (on another device, say, which saw it land), sending the
-- insert again would bring it back. From now on the database remembers the
-- last `updated_at` of each deleted row, and an insert of that id that is not
-- newer is let go: no row, no error. A newer one is a deliberate re-add (the
-- app's Undo of a delete stamps it after what was deleted) and goes in.
--
-- WHAT CHANGES
-- A new table, public.deleted_rows (table name, id, owner, last stamp, when),
-- that no client can read or write: only the two trigger functions below do,
-- as their owner. One AFTER DELETE trigger on entries and bankroll_moves
-- writes to it; one BEFORE INSERT trigger on each checks it. Nothing that
-- exists is rewritten, and no app version's writes change, except that an
-- old insert replayed after its row was deleted no longer brings it back.
-- An app from before this keeps working: an insert with no updated_at gets
-- now(), which is newer than any deleted row, so it goes in as before.
--
-- Deleting an account deletes its rows (on delete cascade): no record of
-- those is kept. The records of rows deleted earlier carry no content (ids
-- and times only) and are removed with the account too.

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
