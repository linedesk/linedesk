#!/bin/sh
# Per-session dev environment: its own database (copy of the schema, demo data seeded) and its own
# hostname and ports, so parallel sessions never share cookies or data with each other or with Tim.
# Usage: scripts/dev-env.sh <name> <api-port> <web-port>   e.g. scripts/dev-env.sh team 3110 5180
# Prints the .env lines to append in the session's worktree.
set -eu
name=$(printf '%s' "${1:?name}" | tr -c 'a-z0-9_' '_' | sed 's/_*$//')
api=${2:?api port}
web=${3:?web port}
db="callfront_dev_${name}"
docker compose -p "${COMPOSE_PROJECT_NAME:-callfront}" exec -T postgres psql -U callfront -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 \
  || docker compose -p "${COMPOSE_PROJECT_NAME:-callfront}" exec -T postgres createdb -U callfront "$db"
cat <<OUT
DATABASE_URL=postgres://callfront:callfront@localhost:5433/$db
PORT=$api
WEB_ORIGIN=http://$name.localhost:$web
BETTER_AUTH_URL=http://$name.localhost:$web
# then: pnpm db:migrate && pnpm db:seed; run the web app with: pnpm --filter @callfront/web exec vite --port $web --host $name.localhost
OUT
