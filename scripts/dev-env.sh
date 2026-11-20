#!/bin/sh
# Per-session dev environment: its own database (the shared dev snapshot if there is one, else seeded) and its own
# hostname and ports, so parallel sessions never share cookies or data with each other or with the developer's own.
# Usage: scripts/dev-env.sh <name> <api-port> <web-port>   e.g. scripts/dev-env.sh team 3110 5180
# Prints the .env lines to append in the session's worktree.
set -eu
name=$(printf '%s' "${1:?name}" | tr -c 'a-z0-9_' '_' | sed 's/_*$//')
api=${2:?api port}
web=${3:?web port}
db="linedesk_dev_${name}"
snapshot=${LINEDESK_SNAPSHOT_DIR:-$HOME/.linedesk}/dev-snapshot.dump
next="pnpm db:migrate && pnpm db:seed"
if ! docker compose -p "${COMPOSE_PROJECT_NAME:-linedesk}" exec -T postgres psql -U linedesk -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1; then
  docker compose -p "${COMPOSE_PROJECT_NAME:-linedesk}" exec -T postgres createdb -U linedesk "$db"
  # A new database starts from the shared test data (scripts/dev-snapshot.sh); the migrations bring it up to date.
  if [ -s "$snapshot" ]; then
    docker compose -p "${COMPOSE_PROJECT_NAME:-linedesk}" exec -T postgres \
      pg_restore -U linedesk --no-owner --no-acl --no-publications --no-subscriptions -d "$db" < "$snapshot"
    echo "# $db: restored from $snapshot" >&2
    next="pnpm db:migrate"
  fi
fi
cat <<OUT
DATABASE_URL=postgres://linedesk:linedesk@localhost:5433/$db
PORT=$api
WEB_ORIGIN=http://$name.localhost:$web
BETTER_AUTH_URL=http://$name.localhost:$web
# then: $next; run the web app with: pnpm --filter @linedesk/web exec vite --port $web --host $name.localhost
OUT
