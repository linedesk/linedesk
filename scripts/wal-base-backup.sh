#!/usr/bin/env bash
# A base backup of the database for WAL archiving (docker-compose.wal.yml): pg_basebackup, gzipped on the host
# (Postgres runs with a small CPU limit), checked, uploaded to <BACKUP_S3_PREFIX>base/; then base backups and WAL
# older than BACKUP_WAL_KEEP_DAYS (7) are deleted, keeping what the oldest remaining base backup needs and every
# timeline history. Every night (linedesk-wal-base.timer, ops/server), and at the end of every restore. A restore
# starts from the newest base backup before the moment wanted and replays WAL from there (scripts/wal-restore.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/wal-settings.sh
. scripts/wal-settings.sh
# wal-restore.sh holds the lock and calls this with WAL_LOCK_HELD=1.
[ "${WAL_LOCK_HELD:-}" = 1 ] || flock -w 600 9 || { echo "wal-base-backup: a restore is running" >&2; exit 1; }
postgres_running || { echo "wal-base-backup: postgres is not running" >&2; exit 1; }
[ -n "$(postgres_volume /walarchive)" ] || { echo "wal-base-backup: postgres runs without docker-compose.wal.yml" >&2; exit 1; }
check_system_id

name="base-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
log() { echo "[wal-base $(date -u +%FT%TZ)] $*"; }
log "base backup"
# The WAL it needs comes from the archive (-X none); fast checkpoint, so it starts at once.
docker compose exec -T postgres pg_basebackup -U "$pg_user" -D - -Ft -X none -c fast | gzip -1 > "$work/$name"
# The whole archive must read back (listed into a file: grep -q on a pipe would stop tar early under pipefail).
tar tzf "$work/$name" > "$work/files"
grep -qx 'backup_label' "$work/files" || { echo "wal-base-backup: $name is not a base backup (no backup_label)" >&2; exit 1; }
log "uploading $name ($(du -h "$work/$name" | cut -f1))"
rclone copyto "/work/$name" "$base_target/$name" --checksum
# A base backup is needed for WAL_KEEP days; WAL one day longer, so the oldest base backup kept can still replay.
# Timeline histories are tiny and every restore needs them: they stay.
log "deleting base backups older than $wal_keep_days days and WAL older than $((wal_keep_days + 1)) days"
rclone delete --min-age "${wal_keep_days}d" --include 'base-*.tar.gz' "$base_target"
rclone delete --min-age "$((wal_keep_days + 1))d" --filter '- *.history.gz' --filter '+ *.gz' --filter '- *' "$wal_target"
log "done: $base_target/$name"
