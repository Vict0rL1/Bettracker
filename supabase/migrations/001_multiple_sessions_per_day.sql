-- Migration: allow multiple sessions per day.
-- Run this once in your Supabase SQL editor if you set up BetTracker BEFORE
-- multi-session support (i.e. your entries table still has the one-entry-per-day
-- unique constraint). It's a no-op if you've already run the latest schema.sql.
--
-- Existing rows are untouched — you just gain the ability to log more than one
-- bet on the same date, which the app now sums into that day's total.

alter table public.entries drop constraint if exists entries_user_id_date_key;
