#!/usr/bin/env bash
# Checks the schema files against a real, throwaway Postgres:
#   A. the original schema upgraded with migrations 001..004, each run twice;
#   B. the original schema upgraded by running schema.sql, twice;
#   C. a fresh install from schema.sql (twice), then every migration on top;
# then runs checks.sql on each (backfill, writes from older and current app
# versions, constraints) and compares the three resulting structures.
#
# Needs psql, createdb, dropdb and pg_dump on PATH, with the usual PG*
# variables pointing at a server where it may create and drop databases
# (they are all named bettracker_test_*). Locally, as root:
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
structure() {
  pg_dump -s -n public -d "$1" | grep -v -e '^--' -e '^$' -e '^\\restrict ' -e '^\\unrestrict ' | sort
  psql -X -At -d "$1" -c "select 'publication ' || tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1"
}

export PGOPTIONS='-c client_min_messages=error'

echo "A. original schema, then 001..004 (each twice)"
fresh bettracker_test_migrations
run bettracker_test_migrations "$HERE/original_schema.sql"
run bettracker_test_migrations "$HERE/seed.sql"
for f in "$M"/0*.sql; do
  run bettracker_test_migrations "$f"
  run bettracker_test_migrations "$f"
done
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

echo "D. the same structure whichever way it got there"
structure bettracker_test_migrations >"$OUT/a"
structure bettracker_test_upgrade >"$OUT/b"
structure bettracker_test_fresh >"$OUT/c"
diff "$OUT/a" "$OUT/b"
diff "$OUT/a" "$OUT/c"

for db in bettracker_test_migrations bettracker_test_upgrade bettracker_test_fresh; do dropdb "$db"; done
echo "All schema checks passed."
