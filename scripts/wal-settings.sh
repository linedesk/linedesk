# shellcheck shell=bash
# Shared by scripts/wal-archive.sh, wal-base-backup.sh and wal-restore.sh (docker-compose.wal.yml): the backup
# bucket's settings (scripts/backup-settings.sh, backup.env), where WAL and base backups go in it, a lock so a restore
# and the timers never run at the same time, and a private work directory removed however the script ends.
# shellcheck source=scripts/backup-settings.sh
. scripts/backup-settings.sh

for name in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY; do
  [ -n "$(setting "$name")" ] || { echo "wal: $name is not set (backup.env, README \"Backups\")" >&2; exit 1; }
done
# Encrypted backups would need each segment encrypted too; not built (yet), so it refuses rather than upload plain WAL.
[ -z "$(setting BACKUP_AGE_RECIPIENT)" ] || {
  echo "wal: WAL archiving does not encrypt yet, and BACKUP_AGE_RECIPIENT asks for encrypted backups" >&2
  exit 1
}
prefix=$(setting BACKUP_S3_PREFIX)
prefix=${prefix:-linedesk/}
# shellcheck disable=SC2034 # used by the scripts that source this
wal_target="b:$(setting BACKUP_S3_BUCKET)/${prefix%/}/wal"
# shellcheck disable=SC2034
base_target="b:$(setting BACKUP_S3_BUCKET)/${prefix%/}/base"
wal_keep_days=$(setting BACKUP_WAL_KEEP_DAYS)
wal_keep_days=${wal_keep_days:-7}
[[ "$wal_keep_days" =~ ^[0-9]+$ ]] && [ "$wal_keep_days" -gt 0 ] || { echo "wal: BACKUP_WAL_KEEP_DAYS must be a positive number" >&2; exit 1; }
pg_user=$(sed -n 's/^POSTGRES_USER=//p' .env 2>/dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//")
pg_user=${pg_user:-linedesk}

# One at a time: a restore holds the lock for its whole run; the timers skip a turn while it is held.
exec 9> "/var/tmp/linedesk-wal-$(id -u).lock"

find /var/tmp -maxdepth 1 -type d -name 'linedesk-wal.*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
work=$(mktemp -d /var/tmp/linedesk-wal.XXXXXX)
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The postgres container, running or stopped (empty when there is none).
postgres_container() { docker compose ps -aq postgres; }
# The Docker volume mounted at <path> in the postgres container (empty when there is none).
postgres_volume() {
  local id
  id=$(postgres_container)
  [ -n "$id" ] || return 0
  docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$1\"}}{{.Name}}{{end}}{{end}}" "$id"
}
postgres_running() { [ -n "$(docker compose ps -q --status running postgres)" ]; }
psql_stack() { docker compose exec -T postgres psql -U "$pg_user" -d postgres -tAc "$1"; }

# The bucket holds the WAL of exactly one database cluster: a new database (initdb, another install with the same
# prefix) would mix its WAL in. Its system identifier is noted next to the WAL; a different one stops everything.
check_system_id() {
  local id noted
  id=$(psql_stack 'select system_identifier from pg_control_system()')
  noted=$(rclone cat "$wal_target/SYSTEM_IDENTIFIER" 2>/dev/null || true)
  if [ -z "$noted" ]; then
    printf '%s\n' "$id" > "$work/SYSTEM_IDENTIFIER"
    rclone copyto /work/SYSTEM_IDENTIFIER "$wal_target/SYSTEM_IDENTIFIER"
  elif [ "$noted" != "$id" ]; then
    echo "wal: $wal_target holds the WAL of database $noted, this is $id: use another BACKUP_S3_PREFIX" >&2
    exit 1
  fi
}
