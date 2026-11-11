#!/bin/sh
# Runs once, when Postgres creates a new, empty data volume (docker-entrypoint-initdb.d): loads the shared
# dev snapshot (scripts/dev-snapshot.sh) if there is one. The API's migrations run after it, on its next start
# (`pnpm db:migrate` with the API on the host). Without a snapshot the database stays empty: run the seed.
set -e
snapshot=/linedesk-snapshot/dev-snapshot.dump
if [ -s "$snapshot" ]; then
  echo "restoring the dev snapshot into $POSTGRES_DB"
  pg_restore -U "$POSTGRES_USER" --no-owner --no-acl --no-publications --no-subscriptions -d "$POSTGRES_DB" "$snapshot"
else
  echo "no dev snapshot at $snapshot; the database starts empty (pnpm db:migrate && pnpm db:seed)"
fi
