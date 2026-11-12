#!/usr/bin/env bash
# Offsite database backup: a pg_dump of the stack's Postgres, encrypted with age to BACKUP_AGE_RECIPIENT and
# uploaded to an S3-compatible bucket; backups older than BACKUP_KEEP_DAYS are deleted there. Only the public
# key is on the server, so neither the server nor anyone holding the bucket keys can read a backup.
#   scripts/backup.sh          make a backup now (a systemd timer runs this every night, README "Backups")
#   scripts/backup.sh --list   list the backups in the bucket
# Restore check (download, decrypt, restore into a throwaway Postgres): scripts/restore-backup.sh.
#
# Settings in .env:
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY
#   BACKUP_S3_PREFIX      folder in the bucket (default: linedesk/)
#   BACKUP_AGE_RECIPIENT  the age public key (age1...), from `age-keygen`; keep the private key off the server
#   BACKUP_KEEP_DAYS      how long backups are kept (default: 30)
# Needs on the host: docker compose (the running stack) and age. rclone runs as a container.
set -euo pipefail
cd "$(dirname "$0")/.."

RCLONE_IMAGE=rclone/rclone:1.68.2

# The value of NAME in .env (without quotes), or the environment's when it is set there.
setting() {
  local value=${!1:-}
  [ -n "$value" ] || value=$(sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//")
  printf '%s' "$value"
}

require() {
  local name
  for name in "$@"; do
    [ -n "$(setting "$name")" ] || { echo "backup: $name is not set (.env)" >&2; exit 1; }
  done
}

log() { echo "[backup $(date -u +%FT%TZ)] $*"; }

# rclone with the bucket as remote `b:`, the keys passed as environment (never as arguments).
rclone() {
  docker run --rm -i --network host \
    -e RCLONE_CONFIG_B_TYPE=s3 -e RCLONE_CONFIG_B_PROVIDER=Other -e RCLONE_CONFIG_B_REGION=auto \
    -e RCLONE_CONFIG_B_ENDPOINT="$(setting BACKUP_S3_ENDPOINT)" \
    -e RCLONE_CONFIG_B_ACCESS_KEY_ID="$(setting BACKUP_S3_ACCESS_KEY_ID)" \
    -e RCLONE_CONFIG_B_SECRET_ACCESS_KEY="$(setting BACKUP_S3_SECRET_ACCESS_KEY)" \
    -e RCLONE_CONFIG_B_NO_CHECK_BUCKET=true -e RCLONE_LOG_LEVEL=ERROR \
    -v "$work:/work" "$RCLONE_IMAGE" "$@"
}

require BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
prefix=$(setting BACKUP_S3_PREFIX)
prefix=${prefix:-linedesk/}
target="b:$(setting BACKUP_S3_BUCKET)/${prefix%/}"
work=$(mktemp -d /var/tmp/linedesk-backup.XXXXXX)
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

if [ "${1:-}" = --list ]; then
  rclone lsl "$target"
  exit 0
fi

require BACKUP_AGE_RECIPIENT
command -v age >/dev/null || { echo "backup: age is not installed (apt install age)" >&2; exit 1; }
keep_days=$(setting BACKUP_KEEP_DAYS)
keep_days=${keep_days:-30}
[[ "$keep_days" =~ ^[0-9]+$ ]] && [ "$keep_days" -gt 0 ] || { echo "backup: BACKUP_KEEP_DAYS must be a positive number" >&2; exit 1; }

name="linedesk-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
log "dumping the database"
# shellcheck disable=SC2016 # the variables are the postgres container's own
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$work/db.dump"
# A dump that pg_restore cannot read is no backup: check it before it replaces anything.
docker compose exec -T postgres pg_restore --list < "$work/db.dump" > /dev/null
log "dump: $(du -h "$work/db.dump" | cut -f1); encrypting and uploading $name"
age -r "$(setting BACKUP_AGE_RECIPIENT)" -o "$work/$name" "$work/db.dump"
rm -f "$work/db.dump"
rclone copyto "/work/$name" "$target/$name"
log "deleting backups older than $keep_days days"
rclone delete --min-age "${keep_days}d" --include 'linedesk-*.dump.age' "$target"
log "done: $target/$name"
