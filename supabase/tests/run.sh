#!/usr/bin/env bash
# Checks the schema files against a real, throwaway Postgres:
#   A. the original schema upgraded with migrations 001..009, each run twice;
#   B. the original schema upgraded by running schema.sql, twice;
#   C. a fresh install from schema.sql (twice), then every migration on top;
# then runs checks.sql on each (backfill, writes from older and current app
# versions, constraints, deposits and withdrawals, row-level security for a
# signed-in user) and compares the three resulting structures. Along the way
# it checks check_migrations.sql (the read-only "which migrations have run?"
# query) after every migration of A, and on B and C.
#
# Needs psql, createdb, dropdb and pg_dump on PATH, with the usual PG*
# variables pointing at a server where it may create and drop databases
# (they are all named bettracker_test_*) as a superuser: stubs.sql creates the
# `authenticated` role if it isn't there yet, and checks.sql switches to it
# (set role), which a role that merely created it may not do. Locally, as root:
#   su postgres -c 'bash supabase/tests/run.sh'
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SUPA=$(dirname "$HERE")
M=$SUPA/migrations
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

run() { psql -q -X -v ON_ERROR_STOP=1 -d "$1" -f "$2" >/dev/null; }
fresh() {
  dropdb --if-exists "$1" 2>/dev/null
  createdb "$1"
  run "$1" "$HERE/stubs.sql"
}
check() { psql -q -X -v ON_ERROR_STOP=1 -d "$1" -f "$HERE/checks.sql" | grep -q 'checks passed'; }
# Sorted dump lines: the same tables, columns, constraints, indexes, policies,
# trigger and function whichever way the database got there (column order
# aside, which additive migrations can't match), plus what realtime publishes.
# Left out: what names one installation rather than the structure, such as
# the per-column `pg_attver` options newer pg_dump builds write (a number that
# differs from one database to the next).
structure() {
  pg_dump -s -n public -d "$1" | grep -v -e '^--' -e '^$' -e '^\\restrict ' -e '^\\unrestrict ' -e 'SET (pg_attver=[0-9]*);$' | sort
  psql -X -At -d "$1" -c "select 'publication ' || tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1"
}

# What check_migrations.sql says of a database: the migrations it reports as
# applied, in order, each followed by a space; and how many it lists at all.
said() { psql -q -X -At -v ON_ERROR_STOP=1 -d "$1" -f "$SUPA/check_migrations.sql" | awk -F'|' '$2 == "yes" { printf "%s ", $1 }'; }
listed() { psql -q -X -At -v ON_ERROR_STOP=1 -d "$1" -f "$SUPA/check_migrations.sql" | grep -c -e '|yes|' -e '|NO|'; }

export PGOPTIONS='-c client_min_messages=error'

echo "A. original schema, then 001..009 (each twice)"
fresh bettracker_test_migrations
run bettracker_test_migrations "$HERE/original_schema.sql"
run bettracker_test_migrations "$HERE/seed.sql"
# check_migrations.sql is what the owner runs to see which files are still to
# run: after each migration it must say yes for exactly the ones run so far
# (001 is not in its list; its rows are named like the files).
ran=""
[ "$(said bettracker_test_migrations)" = "" ] || { echo "check_migrations.sql: on the original schema it says yes for: $(said bettracker_test_migrations)"; exit 1; }
for f in "$M"/0*.sql; do
  run bettracker_test_migrations "$f"
  run bettracker_test_migrations "$f"
  name=$(basename "$f" .sql)
  case "$name" in 001_*) ;; *) ran="$ran$name " ;; esac
  [ "$(said bettracker_test_migrations)" = "$ran" ] || { echo "check_migrations.sql: after $name it says yes for: $(said bettracker_test_migrations)(expected: $ran)"; exit 1; }
done
[ "$(listed bettracker_test_migrations)" = "$(ls "$M" | grep -c -v '^001_')" ] || { echo "check_migrations.sql does not list every migration after 001"; exit 1; }
check bettracker_test_migrations

echo "B. original schema, then schema.sql (twice)"
fresh bettracker_test_upgrade
run bettracker_test_upgrade "$HERE/original_schema.sql"
run bettracker_test_upgrade "$HERE/seed.sql"
run bettracker_test_upgrade "$SUPA/schema.sql"
run bettracker_test_upgrade "$SUPA/schema.sql"
check bettracker_test_upgrade

echo "C. fresh install from schema.sql (twice), then every migration"
fresh bettracker_test_fresh
run bettracker_test_fresh "$SUPA/schema.sql"
run bettracker_test_fresh "$SUPA/schema.sql"
for f in "$M"/0*.sql; do run bettracker_test_fresh "$f"; done
# The seed sends no status, like an app from before 003: the trigger fills it.
run bettracker_test_fresh "$HERE/seed.sql"
check bettracker_test_fresh
[ "$(said bettracker_test_fresh)" = "$ran" ] || { echo "check_migrations.sql: on a fresh schema.sql it says yes for: $(said bettracker_test_fresh)(expected: $ran)"; exit 1; }
[ "$(said bettracker_test_upgrade)" = "$ran" ] || { echo "check_migrations.sql: on an install upgraded by schema.sql it says yes for: $(said bettracker_test_upgrade)(expected: $ran)"; exit 1; }

echo "D. the same structure whichever way it got there"
structure bettracker_test_migrations >"$OUT/a"
structure bettracker_test_upgrade >"$OUT/b"
structure bettracker_test_fresh >"$OUT/c"
diff "$OUT/a" "$OUT/b"
diff "$OUT/a" "$OUT/c"

for db in bettracker_test_migrations bettracker_test_upgrade bettracker_test_fresh; do dropdb "$db"; done
echo "All schema checks passed."
