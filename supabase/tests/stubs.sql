-- TEST FIXTURE — just enough of Supabase for the schema files to run on a
-- plain Postgres: auth.users, auth.uid(), the role the app's requests run as
-- and the realtime publication.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
-- Supabase takes the signed-in user from the request; checks.sql sets
-- request.jwt.claim.sub to act as another user. Unset, it is the fixture's.
create or replace function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), '00000000-0000-0000-0000-000000000001')::uuid $$;
-- A signed-in app's requests run as `authenticated`, which row-level security
-- binds (the superuser running the checks bypasses it). Supabase grants it
-- the public tables by default, so every table the schema files create gets
-- the same grants. Roles belong to the server, not the database: it may exist.
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
grant usage on schema auth to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
insert into auth.users values ('00000000-0000-0000-0000-000000000001') on conflict do nothing;
