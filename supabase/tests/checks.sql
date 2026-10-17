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

select 'checks passed' as result;
