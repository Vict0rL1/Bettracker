-- What every upgrade path must leave behind. Each block fails the run with
-- its message if the database does not behave.
\set ON_ERROR_STOP 1
-- 1. The backfill: existing rows got the status their amount implies.
do $$ begin
  assert (select status from public.entries where note = 'win') = 'won', 'backfill won';
  assert (select status from public.entries where note = 'loss') = 'lost', 'backfill lost';
  assert (select status from public.entries where note = 'push') = 'push', 'backfill push';
end $$;

-- 2. An app from before 002 (sends date, amount, note) can still insert.
insert into public.entries (id, user_id, date, amount, note) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '2026-08-04', 75, 'old win'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '2026-08-04', -20, 'old loss'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '2026-08-04', 0, 'old zero');
-- ...and one from the 002 era (adds stake and tags), still no status.
insert into public.entries (id, user_id, date, amount, stake, note, sport, book, bet_type) values
  ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '2026-08-05', -30, 30, 'stake era', 'NBA', 'DK', 'Spread');
do $$ begin
  assert (select status from public.entries where note = 'old win') = 'won', 'old insert won';
  assert (select status from public.entries where note = 'old loss') = 'lost', 'old insert lost';
  assert (select status from public.entries where note = 'old zero') = 'push', 'old insert zero';
  assert (select status from public.entries where note = 'stake era') = 'lost', 'stake-era insert';
end $$;

-- 3. An older app edits amounts without sending a status.
update public.entries set amount = -75, note = 'old win', updated_at = now() where id = '20000000-0000-0000-0000-000000000001';
update public.entries set amount = 0 where note = 'win';
update public.entries set amount = 40 where note = 'push';
update public.entries set amount = -10 where note = 'old loss';
update public.entries set amount = 0 where note = 'stake era';
do $$ begin
  assert (select status from public.entries where id = '20000000-0000-0000-0000-000000000001') = 'lost', 'won edited to a loss';
  assert (select status from public.entries where note = 'win') = 'push', 'won edited to 0';
  assert (select status from public.entries where note = 'push') = 'won', 'push edited to a win';
  assert (select status from public.entries where note = 'old loss') = 'lost', 'loss edited, still a loss';
  assert (select status from public.entries where note = 'stake era') = 'push', 'lost edited to 0';
end $$;

-- 3b. A write with neither status nor amount is pending (no app sends one,
-- but the trigger must not leave status null).
insert into public.entries (id, user_id, date, note) values
  ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '2026-08-05', 'no amount');
update public.entries set amount = null where note = 'old win';
do $$ begin
  assert (select status from public.entries where note = 'no amount') = 'pending', 'no status, no amount';
  assert (select status from public.entries where note = 'old win') = 'pending', 'amount cleared, no status';
end $$;

-- 4. The current app's writes are never changed.
insert into public.entries (id, user_id, date, amount, stake, odds, status, note) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '2026-08-06', null, 25, 2.1, 'pending', 'new pending'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '2026-08-06', 0, 25, null, 'void', 'new void');
update public.entries set status = 'won', amount = 27.5 where note = 'new pending';
update public.entries set note = 'new void, retagged' where note = 'new void';
-- A status the write sets itself is trusted, even one the trigger would not
-- have worked out from the amount (push -> void at 0, and won at 0, which
-- the database's own check allows).
insert into public.entries (id, user_id, date, amount, status, note) values
  ('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '2026-08-06', 0, 'push', 'explicit');
update public.entries set status = 'void' where note = 'explicit';
do $$ begin
  assert (select status from public.entries where note = 'explicit') = 'void', 'explicit push to void';
end $$;
update public.entries set status = 'won', amount = 0 where note = 'explicit';
do $$ begin
  assert (select status from public.entries where note = 'explicit') = 'won', 'explicit status kept even when the amount does not fit';
end $$;
insert into public.entries (id, user_id, date, amount, stake, status, note) values
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '2026-08-07', null, 10, 'pending', 'still open');
update public.entries set stake = 12 where note = 'still open';
do $$ begin
  assert (select status from public.entries where note = 'new pending') = 'won', 'settled by the new app';
  assert (select status from public.entries where note = 'new void, retagged') = 'void', 'void kept on an edit that leaves amount alone';
  assert (select status from public.entries where note = 'still open') = 'pending', 'pending kept on a stake edit';
end $$;

-- 4a. A free bet (stake 0) that lost nets $0 and stays lost (006), when it
-- is logged, settled, or edited later; a lost bet at $0 with a real stake is
-- still worked out again (it is a push), as before.
insert into public.entries (id, user_id, date, amount, stake, status, note) values
  ('30000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', '2026-08-06', 0, 0, 'lost', 'free bet lost'),
  ('30000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', '2026-08-06', null, 0, 'pending', 'free bet open'),
  ('30000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', '2026-08-06', -10, 10, 'lost', 'cash loss');
update public.entries set note = 'free bet lost, noted' where note = 'free bet lost';
update public.entries set status = 'lost', amount = 0 where note = 'free bet open';
update public.entries set note = 'free bet open, noted' where note = 'free bet open';
update public.entries set amount = 0 where note = 'cash loss';
do $$ begin
  assert (select status from public.entries where note = 'free bet lost, noted') = 'lost', 'a lost free bet stays lost when edited';
  assert (select amount from public.entries where note = 'free bet lost, noted') = 0, 'and keeps its $0';
  assert (select status from public.entries where note = 'free bet open, noted') = 'lost', 'a free bet settled as lost stays lost';
  assert (select status from public.entries where note = 'cash loss') = 'push', 'a cash loss edited to $0 is a push';
end $$;

-- 4b. The current app settling a pending bet as a push or a void at $0
-- (an explicit status) is not mistaken for an older app's $0.
insert into public.entries (id, user_id, date, amount, status, note) values
  ('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '2026-08-06', null, 'pending', 'to push'),
  ('30000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', '2026-08-06', null, 'pending', 'to void');
update public.entries set status = 'push', amount = 0 where note = 'to push';
update public.entries set status = 'void', amount = 0 where note = 'to void';
do $$ begin
  assert (select status from public.entries where note = 'to push') = 'push', 'pending settled as push';
  assert (select amount from public.entries where note = 'to push') = 0, 'push keeps its $0';
  assert (select status from public.entries where note = 'to void') = 'void', 'pending settled as void';
  assert (select amount from public.entries where note = 'to void') = 0, 'void keeps its $0';
end $$;

-- 5. An older app edits a pending bet it reads as $0. Sending that $0 back
-- (a note fix) keeps it pending; typing a result settles it as that result.
update public.entries set amount = 0, note = 'still open' where note = 'still open';
do $$ begin
  assert (select status from public.entries where note = 'still open') = 'pending', 'pending sent back as $0 stays pending';
  assert (select amount from public.entries where note = 'still open') is null, 'pending keeps no amount';
end $$;
update public.entries set amount = 15 where note = 'still open';
do $$ begin
  assert (select status from public.entries where note = 'still open') = 'won', 'pending edited by an old app';
end $$;

-- 6. The constraints still refuse what the current app would never send.
do $$ begin
  begin
    insert into public.entries (user_id, date, amount, status) values ('00000000-0000-0000-0000-000000000001', '2026-08-08', 5, 'pending');
    raise exception 'a pending bet with an amount was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.entries (user_id, date, amount, stake) values ('00000000-0000-0000-0000-000000000001', '2026-08-08', 5, -1);
    raise exception 'negative stake was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.entries (user_id, date, amount, status) values ('00000000-0000-0000-0000-000000000001', '2026-08-08', null, 'push');
    raise exception 'a push with no amount was accepted';
  exception when check_violation then null;
  end;
end $$;

-- 7. Several bets on one day (001), settings table (004).
do $$ begin
  assert (select count(*) from public.entries where date = '2026-08-04') = 3, 'many bets per day';
  assert to_regclass('public.user_settings') is not null, 'user_settings exists';
end $$;

-- 8. Deposits and withdrawals (005). The amount is signed and stored in
-- cents, rounded by size then sign as the app rounds it; the device's
-- updated_at (the conflict key) is kept as sent.
insert into public.bankroll_moves (id, user_id, date, amount, note, updated_at) values
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '2026-08-01', 500, 'deposit', '2026-08-01 09:00:00+00'),
  ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '2026-08-09', -120.50, 'withdrawal', '2026-08-09 09:00:00+00');
insert into public.bankroll_moves (id, user_id, date, amount) values
  ('40000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '2026-08-10', -0.005);
do $$ begin
  assert (select sum(amount) from public.bankroll_moves where note in ('deposit', 'withdrawal')) = 379.50, 'deposit plus withdrawal';
  assert (select updated_at from public.bankroll_moves where note = 'withdrawal') = '2026-08-09 09:00:00+00', 'the device''s updated_at is kept';
  assert (select note from public.bankroll_moves where id = '40000000-0000-0000-0000-000000000003') = '', 'a move with no note gets an empty one';
  assert (select amount from public.bankroll_moves where id = '40000000-0000-0000-0000-000000000003') = -0.01, 'half a cent out is a cent, like half a cent in';
end $$;

-- 8b. A move is never 0, also once rounded to cents, and always has an amount.
do $$ begin
  begin
    insert into public.bankroll_moves (user_id, date, amount) values ('00000000-0000-0000-0000-000000000001', '2026-08-10', 0);
    raise exception 'a move of 0 was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.bankroll_moves (user_id, date, amount) values ('00000000-0000-0000-0000-000000000001', '2026-08-10', 0.004);
    raise exception 'a move that rounds to 0 was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.bankroll_moves (user_id, date, amount) values ('00000000-0000-0000-0000-000000000001', '2026-08-10', null);
    raise exception 'a move with no amount was accepted';
  exception when not_null_violation then null;
  end;
end $$;

-- 8c. The conflict rule the app sends with every edit (apply only if the row
-- is not newer): a later edit lands, a resend of it too, an earlier one
-- doesn't, whatever the row said before.
do $$
declare n int;
begin
  update public.bankroll_moves set amount = -100, note = 'withdrawal, edited', updated_at = '2026-08-09 12:00:00+00'
   where id = '40000000-0000-0000-0000-000000000002' and updated_at <= '2026-08-09 12:00:00+00';
  get diagnostics n = row_count;
  assert n = 1, 'a later edit applies';
  update public.bankroll_moves set amount = -100, note = 'withdrawal, edited', updated_at = '2026-08-09 12:00:00+00'
   where id = '40000000-0000-0000-0000-000000000002' and updated_at <= '2026-08-09 12:00:00+00';
  get diagnostics n = row_count;
  assert n = 1, 'the same edit sent again applies';
  update public.bankroll_moves set amount = -200, note = 'stale', updated_at = '2026-08-09 11:00:00+00'
   where id = '40000000-0000-0000-0000-000000000002' and updated_at <= '2026-08-09 11:00:00+00';
  get diagnostics n = row_count;
  assert n = 0, 'an earlier edit is refused';
  assert (select note from public.bankroll_moves where id = '40000000-0000-0000-0000-000000000002') = 'withdrawal, edited', 'the later edit stands';
end $$;

-- 8d. Private and live like the bets: row-level security on, one policy per
-- operation, broadcast by realtime, indexed for the per-user date reads.
do $$ begin
  assert (select relrowsecurity from pg_class where oid = 'public.bankroll_moves'::regclass), 'moves have row-level security';
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename = 'bankroll_moves') = 4, 'four move policies, and no other';
  assert exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bankroll_moves'), 'moves are broadcast';
  assert to_regclass('public.bankroll_moves_user_date_idx') is not null, 'moves are indexed by user and date';
end $$;

-- 8e. ...and the policies hold for a signed-in user (the role the app's
-- requests run as; see stubs.sql): they see, change and remove only their own
-- moves, and cannot file one under someone else. Rolled back.
insert into auth.users values ('00000000-0000-0000-0000-000000000003') on conflict do nothing;
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
do $$
declare n int;
begin
  assert (select count(*) from public.bankroll_moves) = 0, 'another user''s moves are hidden';
  insert into public.bankroll_moves (user_id, date, amount) values ('00000000-0000-0000-0000-000000000003', '2026-08-10', 25);
  assert (select count(*) from public.bankroll_moves) = 1, 'a user sees their own move';
  update public.bankroll_moves set note = 'not mine' where id = '40000000-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'another user''s move cannot be edited';
  delete from public.bankroll_moves where id = '40000000-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'another user''s move cannot be removed';
  begin
    insert into public.bankroll_moves (user_id, date, amount) values ('00000000-0000-0000-0000-000000000001', '2026-08-10', 25);
    raise exception 'a move under someone else''s id was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.bankroll_moves set user_id = '00000000-0000-0000-0000-000000000001' where user_id = '00000000-0000-0000-0000-000000000003';
    raise exception 'a move was handed to someone else';
  exception when insufficient_privilege then null;
  end;
  -- With a WHERE, Postgres applies the select policy too, which would hide a
  -- loose update or delete policy. Without one, only those two decide.
  begin
    update public.bankroll_moves set user_id = '00000000-0000-0000-0000-000000000001';
    raise exception 'a move was handed to someone else (no where)';
  exception when insufficient_privilege then null;
  end;
  update public.bankroll_moves set note = 'mine';
  get diagnostics n = row_count;
  assert n = 1, 'an unfiltered edit touches only the user''s own moves';
  delete from public.bankroll_moves;
  get diagnostics n = row_count;
  assert n = 1, 'an unfiltered delete removes only the user''s own moves';
end $$;
rollback;
do $$ begin
  assert (select note from public.bankroll_moves where id = '40000000-0000-0000-0000-000000000001') = 'deposit', 'the other user left the deposit alone';
end $$;

-- 8f. Deleting an account takes its moves with it, and only its moves.
insert into auth.users values ('00000000-0000-0000-0000-000000000002') on conflict do nothing;
insert into public.bankroll_moves (id, user_id, date, amount) values
  ('40000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000002', '2026-08-10', 50);
delete from auth.users where id = '00000000-0000-0000-0000-000000000002';
do $$ begin
  assert not exists (select 1 from public.bankroll_moves where id = '40000000-0000-0000-0000-000000000004'), 'a deleted user''s moves go with them';
  assert (select count(*) from public.bankroll_moves where user_id = '00000000-0000-0000-0000-000000000001') = 3, 'other users'' moves stay';
end $$;
-- 9. An import sent again after an interruption, as the app sends it
-- (data/bets.ts, addBets): INSERT ... ON CONFLICT (id) DO NOTHING, as the
-- signed-in user. The rows that never landed go in; a row that did, and was
-- edited on another device since, stays as it is — its newer updated_at too.
-- Rolled back.
begin;
set local role authenticated;
insert into public.entries (id, user_id, date, amount, stake, note, updated_at)
values ('50000000-0000-4000-8000-000000000001', auth.uid(), '2026-07-01', 5, 10, 'import', '2026-07-01 10:00:00+00');
update public.entries set note = 'edited elsewhere', updated_at = '2099-01-01 00:00:00+00' where id = '50000000-0000-4000-8000-000000000001';
insert into public.entries (id, user_id, date, amount, stake, note, updated_at)
values ('50000000-0000-4000-8000-000000000001', auth.uid(), '2026-07-01', 5, 10, 'import', '2026-07-01 10:00:00+00'),
       ('50000000-0000-4000-8000-000000000002', auth.uid(), '2026-07-02', 6, 10, 'import', '2026-07-01 10:00:00+00')
on conflict (id) do nothing;
do $$ begin
  assert (select count(*) from public.entries where id in ('50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002')) = 2, 'the row that never landed goes in';
  assert (select note from public.entries where id = '50000000-0000-4000-8000-000000000001') = 'edited elsewhere', 'the row edited since keeps the edit';
  assert (select updated_at from public.entries where id = '50000000-0000-4000-8000-000000000001') = '2099-01-01 00:00:00+00', 'and its newer updated_at';
end $$;
rollback;

-- 10. Migration 007: a deleted row stays deleted. As the signed-in user, the
-- way the app sends it: an insert, its delete (from another device), then the
-- same insert again (its answer was lost) is let go — no row, no error, also
-- in an import's ON CONFLICT DO NOTHING; a re-add stamped later (an Undo of
-- the delete) goes in. The record is out of the user's reach. Rolled back.
begin;
set local role authenticated;
do $$
declare n int;
begin
  insert into public.entries (id, user_id, date, amount, stake, note, updated_at)
  values ('60000000-0000-4000-8000-000000000001', auth.uid(), '2026-07-01', 5, 10, 'landed', '2026-07-01 10:00:00+00');
  delete from public.entries where id = '60000000-0000-4000-8000-000000000001';
  insert into public.entries (id, user_id, date, amount, stake, note, updated_at)
  values ('60000000-0000-4000-8000-000000000001', auth.uid(), '2026-07-01', 5, 10, 'landed', '2026-07-01 10:00:00+00');
  get diagnostics n = row_count;
  assert n = 0, 'an old insert sent again after its row was deleted is let go';
  insert into public.entries (id, user_id, date, amount, stake, note, updated_at)
  values ('60000000-0000-4000-8000-000000000001', auth.uid(), '2026-07-01', 5, 10, 'landed', '2026-07-01 09:00:00+00')
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  assert n = 0, 'an older one too, in an import';
  assert not exists (select 1 from public.entries where id = '60000000-0000-4000-8000-000000000001'), 'the deleted bet did not come back';
  insert into public.entries (id, user_id, date, amount, stake, note, updated_at)
  values ('60000000-0000-4000-8000-000000000001', auth.uid(), '2026-07-01', 5, 10, 'undo', '2026-07-01 10:00:00.001+00');
  get diagnostics n = row_count;
  assert n = 1, 'a re-add stamped after the delete goes in';
  -- The same for a deposit.
  insert into public.bankroll_moves (id, user_id, date, amount, updated_at)
  values ('60000000-0000-4000-8000-000000000002', auth.uid(), '2026-07-01', 50, '2026-07-01 10:00:00+00');
  delete from public.bankroll_moves where id = '60000000-0000-4000-8000-000000000002';
  insert into public.bankroll_moves (id, user_id, date, amount, updated_at)
  values ('60000000-0000-4000-8000-000000000002', auth.uid(), '2026-07-01', 50, '2026-07-01 10:00:00+00');
  get diagnostics n = row_count;
  assert n = 0, 'an old deposit insert sent again is let go';
  -- An app from before 007 sends no updated_at: now() is newer, it goes in.
  delete from public.entries where id = '60000000-0000-4000-8000-000000000001';
  insert into public.entries (id, user_id, date, amount, note)
  values ('60000000-0000-4000-8000-000000000001', auth.uid(), '2026-07-01', 5, 'old app');
  get diagnostics n = row_count;
  assert n = 1, 'an insert with no stamp from an older app goes in';
  -- Out of reach: the user can't read the record, or forge one.
  begin
    perform 1 from public.deleted_rows;
    raise exception 'the user could read deleted_rows';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.deleted_rows (table_name, id, user_id, stamp) values ('entries', gen_random_uuid(), auth.uid(), now());
    raise exception 'the user could write deleted_rows';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- 10b. The Undo of an import or restore: a delete only of the row that still
-- carries the batch's stamp, in one statement (data/bets.ts, deleteBet). A
-- row edited since, or one the batch never wrote, stays. Rolled back.
begin;
set local role authenticated;
do $$
declare n int;
begin
  insert into public.entries (id, user_id, date, amount, stake, note, updated_at) values
    ('61000000-0000-4000-8000-000000000001', auth.uid(), '2026-07-02', 5, 10, 'restored', '2026-07-02 10:00:00.123+00'),
    ('61000000-0000-4000-8000-000000000002', auth.uid(), '2026-07-02', 5, 10, 'restored, then edited', '2026-07-02 10:00:00.123+00'),
    ('61000000-0000-4000-8000-000000000003', auth.uid(), '2026-07-02', 5, 10, 'there before', '2026-06-30 08:00:00+00');
  update public.entries set note = 'edited', updated_at = '2026-07-02 11:00:00+00'
   where id = '61000000-0000-4000-8000-000000000002' and updated_at <= '2026-07-02 11:00:00+00';
  delete from public.entries where id = '61000000-0000-4000-8000-000000000001' and updated_at = '2026-07-02T10:00:00.123Z';
  get diagnostics n = row_count;
  assert n = 1, 'the row the batch wrote, unchanged, is removed';
  delete from public.entries where id = '61000000-0000-4000-8000-000000000002' and updated_at = '2026-07-02T10:00:00.123Z';
  get diagnostics n = row_count;
  assert n = 0, 'a row edited since stays';
  delete from public.entries where id = '61000000-0000-4000-8000-000000000003' and updated_at = '2026-07-02T10:00:00.123Z';
  get diagnostics n = row_count;
  assert n = 0, 'a row the batch never wrote stays';
end $$;
rollback;

-- 10c. Another user's deleted row is no business of this one's: their
-- tombstone does not stop this user's insert of the same id... which the
-- primary key refuses anyway; and the record holds no content.
do $$ begin
  assert (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'deleted_rows') = 5, 'deleted_rows holds ids and times only';
  assert (select relrowsecurity from pg_class where oid = 'public.deleted_rows'::regclass), 'deleted_rows has row-level security';
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename = 'deleted_rows') = 0, 'and no policy: no client reaches it';
end $$;

-- 10d. Deleting an account deletes its rows and keeps no record of them, or
-- of the ones it deleted before.
insert into auth.users values ('00000000-0000-0000-0000-000000000004') on conflict do nothing;
insert into public.entries (id, user_id, date, amount, note, updated_at) values
  ('62000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000004', '2026-07-03', 5, 'to delete', '2026-07-03 10:00:00+00'),
  ('62000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000004', '2026-07-03', 6, 'goes with the account', '2026-07-03 10:00:00+00');
delete from public.entries where id = '62000000-0000-4000-8000-000000000001';
do $$ begin
  assert exists (select 1 from public.deleted_rows where id = '62000000-0000-4000-8000-000000000001'), 'a deleted bet is remembered';
end $$;
delete from auth.users where id = '00000000-0000-0000-0000-000000000004';
do $$ begin
  assert not exists (select 1 from public.entries where user_id = '00000000-0000-0000-0000-000000000004'), 'the account''s bets went with it';
  assert not exists (select 1 from public.deleted_rows where user_id = '00000000-0000-0000-0000-000000000004'), 'and no record of its rows is left';
end $$;

-- 11. Migration 008: everyday expenses. Cards, expenses and monthly budgets,
-- written as the app writes them (the device's updated_at kept as sent), with
-- the defaults an older or a minimal write gets, and the currency setting.
insert into auth.users values ('00000000-0000-0000-0000-000000000005'), ('00000000-0000-0000-0000-000000000006'), ('00000000-0000-0000-0000-000000000007') on conflict do nothing;
-- Session-local (pg_temp is never dumped): the statement must be refused with
-- exactly that SQLSTATE. Raised outside the inner block, so an accepted
-- statement is reported as accepted, not as "refused with P0001".
create function pg_temp.refuses(stmt text, wanted text) returns void language plpgsql as $$
declare ok boolean := false;
begin
  begin
    execute stmt;
    ok := true;
  exception when others then
    if sqlstate <> wanted then raise exception 'refused with % (wanted %): %', sqlstate, wanted, stmt; end if;
  end;
  -- Raised outside the inner block, so an accepted statement is reported as accepted, not as "refused with P0001".
  if ok then raise exception 'accepted: %', stmt; end if;
end $$;
insert into public.expense_cards (id, user_id, name, last4, kind, created_at, updated_at) values
  ('71000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000005', 'Visa', '1234', 'credit', '2026-11-01 09:00:00+00', '2026-11-01 09:00:00+00');
insert into public.expense_cards (id, user_id, name) values
  ('71000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000005', 'Debit');
insert into public.expenses (id, user_id, date, amount, card_id, merchant, category, note, source, updated_at) values
  ('70000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000005', '2026-11-17', 4.50, '71000000-0000-4000-8000-000000000001', 'Café Central', 'coffee', 'with a croissant', 'ai', '2026-11-17 08:00:00+00'),
  ('70000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000005', '2026-11-17', -12.00, null, 'Shop', 'shopping', '', 'manual', '2026-11-17 09:00:00+00');
insert into public.expenses (id, user_id, date, amount) values
  ('70000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000005', '2026-11-18', 0.005);
insert into public.expense_budgets (id, user_id, scope, target, monthly_limit, updated_at) values
  ('72000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000005', 'total', '', 500, '2026-11-01 10:00:00+00'),
  ('72000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000005', 'card', '71000000-0000-4000-8000-000000000001', 300, '2026-11-01 10:00:00+00'),
  ('72000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000005', 'category', 'coffee', 40.50, '2026-11-01 10:00:00+00');
insert into public.user_settings (user_id) values ('00000000-0000-0000-0000-000000000005');
do $$ begin
  assert (select sum(amount) from public.expenses where id in ('70000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002')) = -7.50, 'a refund lowers the spending';
  assert (select updated_at from public.expenses where id = '70000000-0000-4000-8000-000000000002') = '2026-11-17 09:00:00+00', 'the device''s updated_at is kept (expenses)';
  assert (select updated_at from public.expense_cards where id = '71000000-0000-4000-8000-000000000001') = '2026-11-01 09:00:00+00', 'the device''s updated_at is kept (cards)';
  assert (select created_at from public.expense_cards where id = '71000000-0000-4000-8000-000000000001') = '2026-11-01 09:00:00+00', 'the device''s created_at is kept (cards)';
  assert (select updated_at from public.expense_budgets where id = '72000000-0000-4000-8000-000000000003') = '2026-11-01 10:00:00+00', 'the device''s updated_at is kept (budgets)';
  assert (select monthly_limit from public.expense_budgets where id = '72000000-0000-4000-8000-000000000003') = 40.50, 'a budget keeps its cents';
  assert (select source from public.expenses where id = '70000000-0000-4000-8000-000000000001') = 'ai', 'an expense read by AI says so';
  assert (select card_id is null from public.expenses where id = '70000000-0000-4000-8000-000000000002'), 'an expense may have no card';
  assert (select merchant = '' and category = 'other' and note = '' and source = 'manual' and card_id is null
            from public.expenses where id = '70000000-0000-4000-8000-000000000003'), 'a minimal expense gets the defaults';
  assert (select amount from public.expenses where id = '70000000-0000-4000-8000-000000000003') = 0.01, 'half a cent is a cent';
  assert (select last4 = '' and kind = 'credit' and archived = false
            from public.expense_cards where id = '71000000-0000-4000-8000-000000000002'), 'a minimal card gets the defaults';
  assert (select expense_currency from public.user_settings where user_id = '00000000-0000-0000-0000-000000000005') = 'USD', 'expenses are in dollars until the user says otherwise';
end $$;

-- 11b. The constraints refuse what the app never sends.
do $$ begin
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', 0)$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', 0.004)$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', -0.004)$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', 100000000.01)$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', -100000000.01)$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', null)$q$, '23502');
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount) values ('00000000-0000-0000-0000-000000000005', null, 4)$q$, '23502');
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount, category) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', 4, 'fuel')$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount, source) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', 4, 'scan')$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount, merchant) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', 4, repeat('m', 81))$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expenses (user_id, date, amount, note) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', 4, repeat('n', 501))$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_cards (user_id, name) values ('00000000-0000-0000-0000-000000000005', '')$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_cards (user_id, name) values ('00000000-0000-0000-0000-000000000005', ' Visa')$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_cards (user_id, name) values ('00000000-0000-0000-0000-000000000005', repeat('c', 41))$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_cards (user_id, name, last4) values ('00000000-0000-0000-0000-000000000005', 'Visa', 'abcd')$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_cards (user_id, name, last4) values ('00000000-0000-0000-0000-000000000005', 'Visa', '123')$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_cards (user_id, name, kind) values ('00000000-0000-0000-0000-000000000005', 'Visa', 'cash')$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_budgets (user_id, scope, target, monthly_limit) values ('00000000-0000-0000-0000-000000000005', 'week', '', 10)$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_budgets (user_id, scope, target, monthly_limit) values ('00000000-0000-0000-0000-000000000005', 'total', 'x', 10)$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_budgets (user_id, scope, target, monthly_limit) values ('00000000-0000-0000-0000-000000000005', 'card', 'not-a-uuid', 10)$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_budgets (user_id, scope, target, monthly_limit) values ('00000000-0000-0000-0000-000000000005', 'category', 'fuel', 10)$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_budgets (user_id, scope, target, monthly_limit) values ('00000000-0000-0000-0000-000000000005', 'category', 'travel', 0)$q$, '23514');
  perform pg_temp.refuses($q$insert into public.expense_budgets (id, user_id, scope, target, monthly_limit) values ('72000000-0000-4000-8000-000000000099', '00000000-0000-0000-0000-000000000005', 'total', '', 10)$q$, '23505');
  perform pg_temp.refuses($q$update public.user_settings set expense_currency = 'usd' where user_id = '00000000-0000-0000-0000-000000000005'$q$, '23514');
  perform pg_temp.refuses($q$update public.user_settings set expense_currency = 'US' where user_id = '00000000-0000-0000-0000-000000000005'$q$, '23514');
  perform pg_temp.refuses($q$update public.user_settings set expense_currency = 'EURO' where user_id = '00000000-0000-0000-0000-000000000005'$q$, '23514');
end $$;

-- 11c. The conflict rule the app sends with every edit, as for moves (8c): a
-- later edit lands, a resend of it too, an earlier one doesn't.
do $$
declare n int;
begin
  update public.expenses set amount = 5.25, merchant = 'Café Central, edited', updated_at = '2026-11-17 12:00:00+00'
   where id = '70000000-0000-4000-8000-000000000001' and updated_at <= '2026-11-17 12:00:00+00';
  get diagnostics n = row_count;
  assert n = 1, 'a later expense edit applies';
  update public.expenses set amount = 5.25, merchant = 'Café Central, edited', updated_at = '2026-11-17 12:00:00+00'
   where id = '70000000-0000-4000-8000-000000000001' and updated_at <= '2026-11-17 12:00:00+00';
  get diagnostics n = row_count;
  assert n = 1, 'the same expense edit sent again applies';
  update public.expenses set amount = 9, merchant = 'stale', updated_at = '2026-11-17 11:00:00+00'
   where id = '70000000-0000-4000-8000-000000000001' and updated_at <= '2026-11-17 11:00:00+00';
  get diagnostics n = row_count;
  assert n = 0, 'an earlier expense edit is refused';
  assert (select merchant from public.expenses where id = '70000000-0000-4000-8000-000000000001') = 'Café Central, edited', 'the later expense edit stands';
  update public.expense_budgets set monthly_limit = 600, updated_at = '2026-11-02 10:00:00+00'
   where id = '72000000-0000-4000-8000-000000000001' and updated_at <= '2026-11-02 10:00:00+00';
  get diagnostics n = row_count;
  assert n = 1, 'a later budget edit applies';
  update public.expense_budgets set monthly_limit = 50, updated_at = '2026-11-01 11:00:00+00'
   where id = '72000000-0000-4000-8000-000000000001' and updated_at <= '2026-11-01 11:00:00+00';
  get diagnostics n = row_count;
  assert n = 0, 'an earlier budget edit is refused';
  assert (select monthly_limit from public.expense_budgets where id = '72000000-0000-4000-8000-000000000001') = 600, 'the later budget edit stands';
end $$;

-- 11d. Private and live like the moves: row-level security on, one policy per
-- operation, broadcast by realtime, and only 007's two triggers (none touches
-- updated_at). No foreign key but the owner's: an expense can reach the
-- server before its card, so a card id that matches no card is accepted.
do $$
declare t text;
begin
  foreach t in array array['expense_cards', 'expenses', 'expense_budgets'] loop
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' has row-level security';
    assert (select count(*) from pg_policies where schemaname = 'public' and tablename = t) = 4, t || ': four policies, and no other';
    assert exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t), t || ' is broadcast';
    assert (select count(*) from pg_trigger where tgrelid = ('public.' || t)::regclass and not tgisinternal) = 2, t || ': exactly two triggers';
    assert (select count(*) from pg_trigger where tgrelid = ('public.' || t)::regclass and not tgisinternal
              and tgfoid in ('public.remember_deleted_row()'::regprocedure, 'public.skip_deleted_row()'::regprocedure)) = 2, t || ': the two are 007''s';
    assert (select array_agg(conname::text) from pg_constraint where conrelid = ('public.' || t)::regclass and contype = 'f') = array[t || '_user_id_fkey'], t || ': no foreign key but the owner''s';
  end loop;
  assert to_regclass('public.expenses_user_date_idx') is not null, 'expenses are indexed by user and date';
  assert to_regclass('public.expense_cards_user_idx') is not null, 'cards are indexed by user';
  insert into public.expenses (id, user_id, date, amount, card_id) values
    ('70000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000005', '2026-11-17', 3, '79999999-0000-4000-8000-000000000001');
  assert exists (select 1 from public.expenses where id = '70000000-0000-4000-8000-000000000004'), 'an expense whose card is not there yet is accepted';
  delete from public.expenses where id = '70000000-0000-4000-8000-000000000004';
end $$;

-- 11e. ...and the policies hold for a signed-in user (…06): they see, change
-- and remove only their own cards, expenses and budgets, and cannot file one
-- under someone else. Rolled back.
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000006';
do $$
declare n int;
begin
  -- expenses
  assert (select count(*) from public.expenses) = 0, 'another user''s expenses are hidden';
  insert into public.expenses (user_id, date, amount) values ('00000000-0000-0000-0000-000000000006', '2026-11-17', 4);
  assert (select count(*) from public.expenses) = 1, 'a user sees their own expense';
  update public.expenses set note = 'not mine' where id = '70000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'another user''s expense cannot be edited';
  delete from public.expenses where id = '70000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'another user''s expense cannot be removed';
  begin
    insert into public.expenses (user_id, date, amount) values ('00000000-0000-0000-0000-000000000005', '2026-11-17', 4);
    raise exception 'an expense under someone else''s id was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.expenses set user_id = '00000000-0000-0000-0000-000000000005' where user_id = '00000000-0000-0000-0000-000000000006';
    raise exception 'an expense was handed to someone else';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.expenses set user_id = '00000000-0000-0000-0000-000000000005';
    raise exception 'an expense was handed to someone else (no where)';
  exception when insufficient_privilege then null;
  end;
  update public.expenses set note = 'mine';
  get diagnostics n = row_count;
  assert n = 1, 'an unfiltered edit touches only the user''s own expenses';
  delete from public.expenses;
  get diagnostics n = row_count;
  assert n = 1, 'an unfiltered delete removes only the user''s own expenses';

  -- cards
  assert (select count(*) from public.expense_cards) = 0, 'another user''s cards are hidden';
  insert into public.expense_cards (user_id, name) values ('00000000-0000-0000-0000-000000000006', 'Mine');
  assert (select count(*) from public.expense_cards) = 1, 'a user sees their own card';
  update public.expense_cards set name = 'Not mine' where id = '71000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'another user''s card cannot be edited';
  delete from public.expense_cards where id = '71000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'another user''s card cannot be removed';
  begin
    insert into public.expense_cards (user_id, name) values ('00000000-0000-0000-0000-000000000005', 'Theirs');
    raise exception 'a card under someone else''s id was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.expense_cards set user_id = '00000000-0000-0000-0000-000000000005' where user_id = '00000000-0000-0000-0000-000000000006';
    raise exception 'a card was handed to someone else';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.expense_cards set user_id = '00000000-0000-0000-0000-000000000005';
    raise exception 'a card was handed to someone else (no where)';
  exception when insufficient_privilege then null;
  end;
  update public.expense_cards set name = 'Still mine';
  get diagnostics n = row_count;
  assert n = 1, 'an unfiltered edit touches only the user''s own cards';
  delete from public.expense_cards;
  get diagnostics n = row_count;
  assert n = 1, 'an unfiltered delete removes only the user''s own cards';

  -- budgets
  assert (select count(*) from public.expense_budgets) = 0, 'another user''s budgets are hidden';
  insert into public.expense_budgets (user_id, scope, target, monthly_limit) values ('00000000-0000-0000-0000-000000000006', 'total', '', 100);
  assert (select count(*) from public.expense_budgets) = 1, 'a user sees their own budget';
  update public.expense_budgets set monthly_limit = 1 where id = '72000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'another user''s budget cannot be edited';
  delete from public.expense_budgets where id = '72000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'another user''s budget cannot be removed';
  begin
    insert into public.expense_budgets (user_id, scope, target, monthly_limit) values ('00000000-0000-0000-0000-000000000005', 'category', 'travel', 10);
    raise exception 'a budget under someone else''s id was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.expense_budgets set user_id = '00000000-0000-0000-0000-000000000005' where user_id = '00000000-0000-0000-0000-000000000006';
    raise exception 'a budget was handed to someone else';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.expense_budgets set user_id = '00000000-0000-0000-0000-000000000005';
    raise exception 'a budget was handed to someone else (no where)';
  exception when insufficient_privilege then null;
  end;
  update public.expense_budgets set monthly_limit = 2;
  get diagnostics n = row_count;
  assert n = 1, 'an unfiltered edit touches only the user''s own budgets';
  delete from public.expense_budgets;
  get diagnostics n = row_count;
  assert n = 1, 'an unfiltered delete removes only the user''s own budgets';
end $$;
rollback;
do $$ begin
  assert (select count(*) from public.expenses where user_id = '00000000-0000-0000-0000-000000000005') = 3, 'the other user left the expenses alone';
  assert (select merchant from public.expenses where id = '70000000-0000-4000-8000-000000000001') = 'Café Central, edited', 'and their content';
  assert (select count(*) from public.expense_cards where user_id = '00000000-0000-0000-0000-000000000005') = 2, 'the other user left the cards alone';
  assert (select name from public.expense_cards where id = '71000000-0000-4000-8000-000000000001') = 'Visa', 'and their names';
  assert (select count(*) from public.expense_budgets where user_id = '00000000-0000-0000-0000-000000000005') = 3, 'the other user left the budgets alone';
  assert (select monthly_limit from public.expense_budgets where id = '72000000-0000-4000-8000-000000000001') = 600, 'and their limits';
end $$;

-- 11f. A deleted card, expense or budget stays deleted (007), as the
-- signed-in user …05: the same insert sent again after its delete is let go,
-- also with ON CONFLICT DO NOTHING and an older stamp; a re-add stamped
-- later (an Undo) goes in. Rolled back.
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000005';
do $$
declare n int;
begin
  insert into public.expenses (id, user_id, date, amount, updated_at) values ('70000000-0000-4000-8000-000000000010', auth.uid(), '2026-11-17', 4, '2026-11-17 10:00:00+00');
  delete from public.expenses where id = '70000000-0000-4000-8000-000000000010';
  insert into public.expenses (id, user_id, date, amount, updated_at) values ('70000000-0000-4000-8000-000000000010', auth.uid(), '2026-11-17', 4, '2026-11-17 10:00:00+00');
  get diagnostics n = row_count;
  assert n = 0, 'an old expense insert sent again after its delete is let go';
  insert into public.expenses (id, user_id, date, amount, updated_at) values ('70000000-0000-4000-8000-000000000010', auth.uid(), '2026-11-17', 4, '2026-11-17 09:00:00+00')
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  assert n = 0, 'an older expense insert too';
  insert into public.expenses (id, user_id, date, amount, updated_at) values ('70000000-0000-4000-8000-000000000010', auth.uid(), '2026-11-17', 4, '2026-11-17 10:00:00.001+00');
  get diagnostics n = row_count;
  assert n = 1, 'an expense re-added after the delete goes in';

  insert into public.expense_cards (id, user_id, name, updated_at) values ('71000000-0000-4000-8000-000000000010', auth.uid(), 'Temp', '2026-11-17 10:00:00+00');
  delete from public.expense_cards where id = '71000000-0000-4000-8000-000000000010';
  insert into public.expense_cards (id, user_id, name, updated_at) values ('71000000-0000-4000-8000-000000000010', auth.uid(), 'Temp', '2026-11-17 10:00:00+00');
  get diagnostics n = row_count;
  assert n = 0, 'an old card insert sent again after its delete is let go';
  insert into public.expense_cards (id, user_id, name, updated_at) values ('71000000-0000-4000-8000-000000000010', auth.uid(), 'Temp', '2026-11-17 09:00:00+00')
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  assert n = 0, 'an older card insert too';
  insert into public.expense_cards (id, user_id, name, updated_at) values ('71000000-0000-4000-8000-000000000010', auth.uid(), 'Temp', '2026-11-17 10:00:00.001+00');
  get diagnostics n = row_count;
  assert n = 1, 'a card re-added after the delete goes in';

  insert into public.expense_budgets (id, user_id, scope, target, monthly_limit, updated_at) values ('72000000-0000-4000-8000-000000000010', auth.uid(), 'category', 'travel', 10, '2026-11-17 10:00:00+00');
  delete from public.expense_budgets where id = '72000000-0000-4000-8000-000000000010';
  insert into public.expense_budgets (id, user_id, scope, target, monthly_limit, updated_at) values ('72000000-0000-4000-8000-000000000010', auth.uid(), 'category', 'travel', 10, '2026-11-17 10:00:00+00');
  get diagnostics n = row_count;
  assert n = 0, 'an old budget insert sent again after its delete is let go';
  insert into public.expense_budgets (id, user_id, scope, target, monthly_limit, updated_at) values ('72000000-0000-4000-8000-000000000010', auth.uid(), 'category', 'travel', 10, '2026-11-17 09:00:00+00')
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  assert n = 0, 'an older budget insert too';
  insert into public.expense_budgets (id, user_id, scope, target, monthly_limit, updated_at) values ('72000000-0000-4000-8000-000000000010', auth.uid(), 'category', 'travel', 10, '2026-11-17 10:00:00.001+00');
  get diagnostics n = row_count;
  assert n = 1, 'a budget set again after it was cleared goes in';
end $$;
rollback;

-- 11g. Deleting an account takes its cards, expenses and budgets with it,
-- keeps no record of them, and leaves other users' alone.
insert into public.expense_cards (id, user_id, name) values ('71000000-0000-4000-8000-000000000020', '00000000-0000-0000-0000-000000000007', 'Theirs');
insert into public.expenses (id, user_id, date, amount, card_id) values
  ('70000000-0000-4000-8000-000000000020', '00000000-0000-0000-0000-000000000007', '2026-11-17', 4, '71000000-0000-4000-8000-000000000020'),
  ('70000000-0000-4000-8000-000000000021', '00000000-0000-0000-0000-000000000007', '2026-11-17', 6, null);
insert into public.expense_budgets (id, user_id, scope, target, monthly_limit) values ('72000000-0000-4000-8000-000000000020', '00000000-0000-0000-0000-000000000007', 'total', '', 100);
delete from public.expenses where id = '70000000-0000-4000-8000-000000000021';
do $$ begin
  assert exists (select 1 from public.deleted_rows where table_name = 'expenses' and id = '70000000-0000-4000-8000-000000000021'), 'a deleted expense is remembered';
end $$;
delete from auth.users where id = '00000000-0000-0000-0000-000000000007';
do $$ begin
  assert not exists (select 1 from public.expense_cards where user_id = '00000000-0000-0000-0000-000000000007'), 'the account''s cards went with it';
  assert not exists (select 1 from public.expenses where user_id = '00000000-0000-0000-0000-000000000007'), 'the account''s expenses went with it';
  assert not exists (select 1 from public.expense_budgets where user_id = '00000000-0000-0000-0000-000000000007'), 'the account''s budgets went with it';
  assert not exists (select 1 from public.deleted_rows where user_id = '00000000-0000-0000-0000-000000000007'), 'and no record of its rows is left';
  assert (select count(*) from public.expenses where user_id = '00000000-0000-0000-0000-000000000005') = 3, 'other users'' expenses stay';
  assert (select count(*) from public.expense_cards where user_id = '00000000-0000-0000-0000-000000000005') = 2, 'other users'' cards stay';
  assert (select count(*) from public.expense_budgets where user_id = '00000000-0000-0000-0000-000000000005') = 3, 'other users'' budgets stay';
end $$;

-- 11h. The currency setting: an app from before 008 writes settings without
-- the column and leaves it alone; the current app sets it.
update public.user_settings set expense_currency = 'EUR' where user_id = '00000000-0000-0000-0000-000000000005';
update public.user_settings set unit_size = 10 where user_id = '00000000-0000-0000-0000-000000000005';
do $$ begin
  assert (select expense_currency from public.user_settings where user_id = '00000000-0000-0000-0000-000000000005') = 'EUR', 'an older app''s settings write keeps the currency';
  assert (select unit_size from public.user_settings where user_id = '00000000-0000-0000-0000-000000000005') = 10, 'and its own change lands';
end $$;

select 'checks passed' as result;
