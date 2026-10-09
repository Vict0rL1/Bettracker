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
end $$;

-- 7. Several bets on one day (001), settings table (004).
do $$ begin
  assert (select count(*) from public.entries where date = '2026-08-04') = 3, 'many bets per day';
  assert to_regclass('public.user_settings') is not null, 'user_settings exists';
end $$;
select 'checks passed' as result;
