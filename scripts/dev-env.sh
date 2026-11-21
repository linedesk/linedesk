#!/bin/sh
# Per-session dev environment: its own Postgres and Electric (compose project linedesk-dev-<name>, the shared dev
# snapshot restored into a new volume if there is one), its own hostname and ports. Parallel sessions never share
# cookies, data or database connections with each other or with the developer's own stack.
# Usage: scripts/dev-env.sh <name> <api-port> <web-port>   e.g. scripts/dev-env.sh team 3110 5180
# Postgres listens on <web-port>+1000, Electric on <api-port>+1000 (both 127.0.0.1).
# Prints the .env lines to append in the session's worktree; then `pnpm db:up` there starts this session's database.
set -eu
name=$(printf '%s' "${1:?name}" | tr -c 'a-z0-9_' '_' | sed 's/_*$//')
api=${2:?api port}
web=${3:?web port}
pg=$((web + 1000))
electric=$((api + 1000))
project="linedesk-dev-$(printf '%s' "$name" | tr '_' '-')"
# The password the worktree's .env gives Postgres (scripts/setup.sh), else the compose default.
password=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env 2>/dev/null | tail -1)
password=${password:-linedesk}
snapshot=${LINEDESK_SNAPSHOT_DIR:-$HOME/.linedesk}/dev-snapshot.dump
if [ -s "$snapshot" ]; then next="pnpm db:up && pnpm db:migrate"; else next="pnpm db:up && pnpm db:migrate && pnpm db:seed"; fi
cat <<OUT
COMPOSE_PROJECT_NAME=$project
LINEDESK_DEV_PG_PORT=$pg
LINEDESK_DEV_ELECTRIC_PORT=$electric
LINEDESK_POSTGRES_MEM=384m
LINEDESK_POSTGRES_CPUS=1
DATABASE_URL=postgres://linedesk:$password@localhost:$pg/linedesk
ELECTRIC_URL=http://localhost:$electric
PORT=$api
WEB_ORIGIN=http://$name.localhost:$web
BETTER_AUTH_URL=http://$name.localhost:$web
# then: $next; run the web app with: pnpm --filter @linedesk/web exec vite --port $web --host $name.localhost
# when the session ends: docker compose -p $project down -v (removes its database)
OUT
