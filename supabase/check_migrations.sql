-- BetTracker: which migrations does this project already have?
-- Read-only: it changes nothing. Paste it in the Supabase SQL editor and run
-- it; every row that says NO is a file in supabase/migrations/ still to run,
-- in order (001 was applied before this list existed).
--
-- BetTracker: ¿qué migraciones tiene ya este proyecto? Solo lee; no cambia
-- nada. Pégalo en el editor SQL de Supabase y ejecútalo: cada fila con NO es
-- un archivo de supabase/migrations/ que falta por ejecutar, en orden.
select m.migration, case when m.applied then 'yes' else 'NO' end as applied, m.adds
from (values
  ('002_stake_and_tags', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'entries' and column_name = 'stake'),
          'entries.stake, sport, book, bet_type'),
  ('003_odds_and_status', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'entries' and column_name = 'status'),
          'entries.odds, status and its trigger'),
  ('004_user_settings_and_closing_odds', to_regclass('public.user_settings') is not null
          and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'entries' and column_name = 'closing_odds'),
          'user_settings and entries.closing_odds'),
  ('005_bankroll_moves', to_regclass('public.bankroll_moves') is not null,
          'bankroll_moves (deposits and withdrawals)'),
  ('006_lost_free_bets', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'entries_status_from_amount' and p.prosrc like '%new.amount = 0 and new.stake = 0%'),
          'a lost free bet stays lost when edited'),
  ('007_deleted_rows', to_regclass('public.deleted_rows') is not null,
          'deleted_rows (a deleted row stays deleted)'),
  ('008_expenses', to_regclass('public.expenses') is not null and to_regclass('public.expense_cards') is not null
          and to_regclass('public.expense_budgets') is not null
          and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_settings' and column_name = 'expense_currency'),
          'expenses, cards, budgets and the expense currency'),
  ('009_expense_original_currency', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'expenses'
                     and column_name in ('original_amount', 'original_currency', 'fx_rate')) = 3,
          'expenses.original_amount, original_currency, fx_rate (an expense paid in another currency)')
) as m(migration, applied, adds)
order by m.migration;
