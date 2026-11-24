#!/usr/bin/env bash
# Moves the WAL segments Postgres archived into the volume walarchive (docker-compose.wal.yml) to the backup bucket,
# under <BACKUP_S3_PREFIX>wal/, then checks that Postgres can archive and nothing is left waiting. Every minute
# (linedesk-wal-archive.timer, ops/server). It fails, and so alerts, when a segment waits over 15 minutes or Postgres
# reports failed archiving, and sends one email when it is fine again.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/wal-settings.sh
. scripts/wal-settings.sh
flock -n 9 || { echo "wal-archive: a restore or base backup is running; next minute"; exit 0; }
# A deploy or a restore recreates Postgres; the uptime check reports a database that stays down.
postgres_running || { echo "wal-archive: postgres is not running; next minute"; exit 0; }
volume=$(postgres_volume /walarchive)
[ -n "$volume" ] || { echo "wal-archive: postgres runs without docker-compose.wal.yml (no volume at /walarchive)" >&2; exit 1; }
check_system_id

# Upload first, so a full disk is freed even when something else is wrong; each file is deleted once uploaded and
# its checksum matches.
rc=0
rclone_volume="$volume:/wal"
rclone move /wal "$wal_target" --include '*.gz' --checksum || rc=$?
problem=""
[ "$rc" = 0 ] || problem="upload failed (rclone exit $rc)"
# Waiting segments: anything still there 15 minutes later is not getting out.
waiting=$(docker compose exec -T postgres find /walarchive -name '*.gz' -mmin +15 | wc -l)
[ "$waiting" = 0 ] || problem="${problem:+$problem; }$waiting segments wait over 15 minutes"
# Postgres's own view: an archive_command that fails keeps the WAL in pg_wal (the disk fills) and is retried.
failing=$(psql_stack "select coalesce(last_failed_time > coalesce(last_archived_time, '-infinity'), false) || ' ' || coalesce(last_failed_wal, '') from pg_stat_archiver")
case $failing in t\ *) problem="${problem:+$problem; }Postgres fails to archive ${failing#t } (docker compose logs postgres)" ;; esac

state=${STATE_DIRECTORY:-/var/tmp}/wal-archive.state
if [ -n "$problem" ]; then
  echo "wal-archive: $problem" >&2
  echo failing > "$state"
  exit 1
fi
if [ "$(cat "$state" 2>/dev/null || echo ok)" = failing ]; then
  /usr/local/sbin/linedesk-alert-text "WAL archiving works again on $(hostname)" "Archived WAL reaches the bucket again ($(date -u '+%F %T UTC'))." || true
fi
echo ok > "$state"
