#!/usr/bin/env bash
# Offsite database backup: a pg_dump of the stack's Postgres, encrypted with age to BACKUP_AGE_RECIPIENT and
# uploaded to an S3-compatible bucket; backups older than BACKUP_KEEP_DAYS are deleted there. Only the public
# key is on the server, so neither the server nor anyone holding the bucket keys can read a backup.
#   scripts/backup.sh          make a backup now (a systemd timer runs this every night, README "Backups")
#   scripts/backup.sh --list   list the backups in the bucket
# Restore check (download, decrypt, restore into a throwaway Postgres): scripts/restore-backup.sh.
#
# Settings in backup.env (chmod 600; not .env, which the API container reads; scripts/backup-settings.sh):
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY
#   BACKUP_S3_PREFIX      folder in the bucket (default: linedesk/)
#   BACKUP_AGE_RECIPIENT  the age public key (age1...), from `age-keygen`; keep the private key off the server
#   BACKUP_KEEP_DAYS      how long backups are kept (default: 30)
# Needs on the host: docker compose (the running stack) and age. rclone runs as a container.
set -euo pipefail
umask 077 # the dump is unencrypted until age has run: only this user may read it, at every moment
cd "$(dirname "$0")/.."

# shellcheck source=scripts/backup-settings.sh
. scripts/backup-settings.sh

require() {
  local name
  for name in "$@"; do
    [ -n "$(setting "$name")" ] || { echo "backup: $name is not set ($backup_env_file)" >&2; exit 1; }
  done
}

log() { echo "[backup $(date -u +%FT%TZ)] $*"; }

require BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
prefix=$(setting BACKUP_S3_PREFIX)
prefix=${prefix:-linedesk/}
target="b:$(setting BACKUP_S3_BUCKET)/${prefix%/}"
# A job killed outright (SIGKILL, out of memory, power loss) runs no trap: the next run removes what it left.
find /var/tmp -maxdepth 1 -type d -name 'linedesk-backup.*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
work=$(mktemp -d /var/tmp/linedesk-backup.XXXXXX)
chmod 700 "$work"
# The unencrypted dump goes with the directory however the job ends: done, failed, stopped (TERM) or interrupted.
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
