-- TEST FIXTURE — just enough of Supabase for the schema files to run on a
-- plain Postgres: auth.users, auth.uid() and the realtime publication.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
insert into auth.users values ('00000000-0000-0000-0000-000000000001') on conflict do nothing;
