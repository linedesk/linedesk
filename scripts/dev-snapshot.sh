#!/bin/sh
# Shared local test data: a snapshot of a dev database that every new local stack or worktree starts from.
#   scripts/dev-snapshot.sh snapshot [-p <compose project>] [--db <name>]   save the database to the snapshot file
#   scripts/dev-snapshot.sh restore  [-p <compose project>] [--db <name>] [--force]   replace the database with it
# pnpm dev:snapshot / pnpm dev:restore run these. The project defaults to COMPOSE_PROJECT_NAME or `linedesk`
# (the `pnpm db:up` stack), the database to `linedesk`. The file is outside every worktree and never in git:
# LINEDESK_SNAPSHOT_DIR (default ~/.linedesk), file dev-snapshot.dump. A fresh Postgres volume restores it by
# itself (docker-compose.snapshot.yml); `restore` is for a stack whose database already exists.
# Left out of the snapshot (rows only, the tables stay): sign-in sessions and codes, provider keys and other
# secrets, push subscriptions, logs and queued jobs. Development data only: never run it against real customers.
set -eu
cd "$(dirname "$0")/.."

dir=${LINEDESK_SNAPSHOT_DIR:-$HOME/.linedesk}
file=$dir/dev-snapshot.dump
cmd=${1:-}
[ $# -gt 0 ] && shift
project=${COMPOSE_PROJECT_NAME:-linedesk}
db=linedesk
force=no
while [ $# -gt 0 ]; do
  case $1 in
    -p) project=$2; shift 2 ;;
    --db) db=$2; shift 2 ;;
    --force) force=yes; shift ;;
    --) shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

containers_of() {
  docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1"
}
pg=$(containers_of postgres | head -n 1)
[ -n "$pg" ] || { echo "no running postgres in compose project '$project' (start it, or pass -p <project>)" >&2; exit 1; }
psql_in() { docker exec -i "$pg" sh -c 'psql -v ON_ERROR_STOP=1 -qtA -U "$POSTGRES_USER" -d "$1"' sh "$1"; }

snapshot() {
  mkdir -p "$dir" && chmod 700 "$dir"
  tmp=$file.tmp
  docker exec "$pg" sh -c 'pg_dump -U "$POSTGRES_USER" -Fc --no-owner --no-acl --no-publications --no-subscriptions \
    --exclude-table-data=public.session --exclude-table-data=public.verification \
    --exclude-table-data=public.calendar_oauth_states --exclude-table-data=public.calendar_credentials \
    --exclude-table-data=public.provider_settings --exclude-table-data=public.webhook_secrets \
    --exclude-table-data=public.push_subscriptions --exclude-table-data=public.commands \
    --exclude-table-data=public.auth_events --exclude-table-data=public.admin_devices --exclude-table-data="pgboss.*" "$1"' sh "$db" > "$tmp"
  chmod 600 "$tmp" && mv "$tmp" "$file"
  echo "saved $project/$db to $file ($(du -h "$file" | cut -f1))"
}

has_users() { echo 'select count(*) from "user"' | psql_in "$db" 2>/dev/null | grep -qv '^0$'; }

restore() {
  [ -s "$file" ] || { echo "no snapshot at $file (run pnpm dev:snapshot in a stack that has data, or pnpm db:seed)" >&2; exit 1; }
  if has_users && [ $force = no ]; then
    echo "$project/$db already has accounts; --force replaces all of its data with the snapshot" >&2
    exit 1
  fi
  electric=$(containers_of electric)
  api=$(containers_of api)
  # Electric holds a replication slot on the database: stop it, and the API, while the database is replaced.
  for c in $electric $api; do docker stop "$c" >/dev/null; done
  psql_in postgres <<SQL
select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db' and pid <> pg_backend_pid();
select pg_drop_replication_slot(slot_name) from pg_replication_slots where database = '$db';
drop database if exists "$db";
create database "$db";
SQL
  docker exec -i "$pg" sh -c 'pg_restore -U "$POSTGRES_USER" --no-owner --no-acl --no-publications --no-subscriptions -d "$1"' sh "$db" < "$file"
  for c in $electric $api; do docker start "$c" >/dev/null; done
  echo "restored $file into $project/$db"
  # The API container applies the migrations when it starts; an API on the host needs them run.
  if [ -z "$api" ]; then echo "next: pnpm db:migrate (with DATABASE_URL pointing at $db)"; fi
}

case $cmd in
  snapshot) snapshot ;;
  restore) restore ;;
  *) echo "usage: scripts/dev-snapshot.sh snapshot|restore [-p <compose project>] [--db <name>] [--force]" >&2; exit 2 ;;
esac
