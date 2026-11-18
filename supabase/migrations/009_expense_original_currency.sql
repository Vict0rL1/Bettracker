-- Migration: an expense paid in another currency (the Expenses view).
-- Run this once in your Supabase SQL editor, after 008 (it adds three columns
-- to the expenses table). It's a no-op if you've already run the latest
-- schema.sql (or this file before).
--
-- expenses.amount stays what it was: the amount IN THE USER'S EXPENSE
-- CURRENCY (user_settings.expense_currency). Every total, budget and chart
-- keeps reading it, unchanged. For an expense paid in another currency, three
-- more columns say what was actually paid:
--
-- original_amount    what was paid, in the currency it was paid in. Signed
--                    like amount (a refund is negative), never 0.
-- original_currency  that currency's ISO 4217 code ("USD").
-- fx_rate            units of the expense currency per 1 unit of the original
--                    currency (1 USD = 1.4034 CAD is 1.40340000).
--
-- All three are null (an expense in the user's own currency: every row from
-- before this migration) or all three are set. amount is normally
-- round(original_amount * fx_rate), but the user may type what the bank
-- statement says instead (banks add their own fee), so the database does not
-- insist the three multiply out. The app keeps working before this runs: an
-- expense added or edited meanwhile waits on the device and is sent once
-- this has run.

do $$
begin
  if to_regclass('public.expenses') is null then
    raise exception 'Run 008_expenses.sql before 009_expense_original_currency.sql';
  end if;
end $$;

alter table public.expenses add column if not exists original_amount   numeric(12, 2);
alter table public.expenses add column if not exists original_currency text;
alter table public.expenses add column if not exists fx_rate           numeric(18, 8);

alter table public.expenses drop constraint if exists expenses_original_all_or_none;
alter table public.expenses add  constraint expenses_original_all_or_none check (
  (original_amount is null and original_currency is null and fx_rate is null)
  or (original_amount is not null and original_currency is not null and fx_rate is not null)
);
-- Never 0 and the same bound as amount (checked after numeric(12,2) rounding).
alter table public.expenses drop constraint if exists expenses_original_amount_range;
alter table public.expenses add  constraint expenses_original_amount_range check (original_amount <> 0 and abs(original_amount) <= 100000000);
-- A refund is a refund in both currencies.
alter table public.expenses drop constraint if exists expenses_original_same_sign;
alter table public.expenses add  constraint expenses_original_same_sign check (sign(original_amount) = sign(amount));
alter table public.expenses drop constraint if exists expenses_original_currency_code;
alter table public.expenses add  constraint expenses_original_currency_code check (original_currency ~ '^[A-Z]{3}$');
alter table public.expenses drop constraint if exists expenses_fx_rate_positive;
alter table public.expenses add  constraint expenses_fx_rate_positive check (fx_rate > 0);
