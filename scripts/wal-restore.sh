#!/usr/bin/env bash
# Restores the database from WAL archiving (docker-compose.wal.yml): the newest base backup before the moment wanted,
# then the archived WAL replayed up to that moment, or to the end of the archive. Replaces the running database, so
# it asks first. On any failure after the database was replaced it puts the data from before back and starts the
# stack again; the copy stays in a private directory under /var/tmp for you to delete once all is well.
#   scripts/wal-restore.sh                                  # to the latest moment in the archive
#   scripts/wal-restore.sh '2026-11-14 09:41:00+00'         # to a moment (UTC), e.g. just before a mistake
#   scripts/wal-restore.sh --yes [...]                      # without asking
#   WAL_RESTORE_TIMEOUT=3600 scripts/wal-restore.sh         # seconds the replay may take (default 1800)
# Calls cannot be answered while it runs (minutes for a small database). The nightly pg_dump backups
# (scripts/backup.sh, README "Backups") stay as a second, independent way back.
set -euo pipefail
cd "$(dirname "$0")/.."
yes=0
[ "${1:-}" = --yes ] && { yes=1; shift; }
target_time=${1:-}
if [ -n "$target_time" ] && ! [[ "$target_time" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}(:[0-9]{2})?(\+00|Z| UTC)$ ]]; then
  echo "wal-restore: give the moment as '2026-11-14 09:41:00+00' (UTC)" >&2
  exit 2
fi
timeout=${WAL_RESTORE_TIMEOUT:-1800}
[[ "$timeout" =~ ^[0-9]+$ ]] || { echo "wal-restore: WAL_RESTORE_TIMEOUT must be seconds" >&2; exit 2; }
# shellcheck source=scripts/wal-settings.sh
. scripts/wal-settings.sh
flock -w 120 9 || { echo "wal-restore: the archive timer or a base backup does not let go of the lock" >&2; exit 1; }
log() { echo "[wal-restore $(date -u +%FT%TZ)] $*"; }

id=$(postgres_container)
[ -n "$id" ] || { echo "wal-restore: no postgres container: start it once (docker compose up -d postgres) so its volumes exist" >&2; exit 1; }
pgdata=$(postgres_volume /var/lib/postgresql/data)
walarchive=$(postgres_volume /walarchive)
[ -n "$walarchive" ] || { echo "wal-restore: postgres runs without docker-compose.wal.yml" >&2; exit 1; }
image=$(docker inspect -f '{{.Config.Image}}' "$id")
# The stack's own Postgres arguments (archive_command included), so the restored server archives its new timeline.
mapfile -t args < <(docker inspect -f '{{range .Config.Cmd}}{{println .}}{{end}}' "$id" | sed '/^$/d')
[ "${args[0]:-}" = postgres ] || { echo "wal-restore: unexpected postgres command: ${args[*]:-none}" >&2; exit 1; }

cutoff=99999999T999999Z
[ -z "$target_time" ] || cutoff=$(date -u -d "${target_time% UTC}" +%Y%m%dT%H%M%SZ)
base=$(rclone lsf --include 'base-*.tar.gz' "$base_target" | sort | awk -v c="base-$cutoff" '$0 < c' | tail -n 1)
[ -n "$base" ] || { echo "wal-restore: no base backup before ${target_time:-now} in $base_target" >&2; exit 1; }
log "base backup $base, then WAL up to ${target_time:-the end of the archive}"
if [ "$yes" = 0 ]; then
  read -r -p "This replaces the database of $(pwd) (calls stop for a few minutes). Type restore: " answer
  [ "$answer" = restore ] || { echo "nothing changed"; exit 1; }
fi

log "stopping the services that use the database"
# From here on, a failure before the database is replaced starts the stack again as it was.
trap 'rc=$?; [ "$rc" = 0 ] || { echo "wal-restore: failed; starting the stack again, nothing was changed" >&2; docker compose up -d; }; rm -rf "$work"; exit "$rc"' EXIT
docker compose stop api electric agent
if postgres_running; then
  # The last changes into the archive: close the current segment and wait until Postgres has archived it.
  last=$(psql_stack 'select pg_walfile_name(pg_switch_wal())')
  for _ in $(seq 1 60); do
    [ "$(psql_stack 'select last_archived_wal from pg_stat_archiver')" \> "$last" ] ||
      [ "$(psql_stack 'select last_archived_wal from pg_stat_archiver')" = "$last" ] && break
    sleep 1
  done
fi
docker compose stop postgres
log "uploading what was still on this server, then downloading"
rclone_volume="$walarchive:/wal"
rclone move /wal "$wal_target" --include '*.gz' --checksum
rclone_volume=
rclone copyto "$base_target/$base" /work/base.tar.gz
rclone copy "$wal_target" /work/wal --include '*.gz'
log "$(find "$work/wal" -name '*.gz' | wc -l) WAL files"

# The data before the restore, readable by the caller only, in a directory of its own.
keep_dir=$(mktemp -d /var/tmp/linedesk-before-wal-restore.XXXXXX)
chmod 700 "$keep_dir"
keep=$keep_dir/pgdata.tar.gz
docker run --rm --network none -v "$pgdata:/data:ro" -v "$keep_dir:/out" "$image" \
  sh -c "umask 077 && tar czf /out/pgdata.tar.gz -C /data . && chown $(id -u):$(id -g) /out/pgdata.tar.gz"
log "the data before the restore is in $keep"

container=linedesk-wal-restore-$$
rollback() {
  local rc=$?
  trap - EXIT
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [ "$rc" != 0 ]; then
    echo "wal-restore: failed; putting the data from before back" >&2
    docker run --rm --network none -v "$pgdata:/data" -v "$keep_dir:/in:ro" "$image" \
      sh -c 'find /data -mindepth 1 -delete && tar xzf /in/pgdata.tar.gz -C /data && chown -R postgres:postgres /data'
    docker compose up -d
    echo "wal-restore: the stack runs on the data from before the restore; nothing was restored" >&2
  fi
  rm -rf "$work"
  exit "$rc"
}
trap rollback EXIT

log "unpacking the base backup"
docker run --rm --network none -v "$pgdata:/data" -v "$work:/work:ro" "$image" sh -c '
  find /data -mindepth 1 -delete
  tar xzf /work/base.tar.gz -C /data
  touch /data/recovery.signal
  chown -R postgres:postgres /data && chmod 700 /data'

log "replaying WAL"
recovery=(-c "restore_command=gunzip -c /walrestore/%f.gz > %p" -c recovery_target_action=promote)
[ -z "$target_time" ] || recovery+=(-c "recovery_target_time=${target_time% UTC}")
docker run -d --name "$container" --network none -v "$pgdata:/var/lib/postgresql/data" \
  -v "$work/wal:/walrestore:ro" -v "$walarchive:/walarchive" "$image" "${args[@]}" "${recovery[@]}" >/dev/null
state=t
for _ in $(seq 1 "$timeout"); do
  state=$(docker exec "$container" psql -U "$pg_user" -d postgres -tAc 'select pg_is_in_recovery()' 2>/dev/null || true)
  [ "$state" = f ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ] || { docker logs --tail 30 "$container"; echo "wal-restore: Postgres stopped during recovery" >&2; exit 1; }
  sleep 1
done
[ "$state" = f ] || { docker logs --tail 30 "$container"; echo "wal-restore: recovery did not finish in $timeout seconds (WAL_RESTORE_TIMEOUT)" >&2; exit 1; }
docker logs "$container" 2>&1 | grep -E 'recovery stopping|last completed transaction|redo done' | tail -3

# To the end of the archive: the replay must have reached the newest segment of the timeline it followed (the one
# before the new timeline it promoted to); a gap stops it silently. Segments of abandoned timelines do not count.
if [ -z "$target_time" ]; then
  redo=$(docker logs "$container" 2>&1 | sed -n 's/.*redo done at \([0-9A-F]*\/[0-9A-F]*\).*/\1/p' | tail -n 1)
  [ -n "$redo" ] || { echo "wal-restore: Postgres did not report where the replay ended" >&2; exit 1; }
  redo_seg=$(( ((16#${redo%/*} << 32) | 16#${redo#*/}) >> 24 ))
  tli=$(docker exec "$container" psql -U "$pg_user" -d postgres -tAc 'select timeline_id - 1 from pg_control_checkpoint()')
  tli_hex=$(printf '%08X' "$tli")
  newest=$(find "$work/wal" -name "${tli_hex}????????????????.gz" -printf '%f\n' | cut -c9-24 | sort | tail -n 1)
  if [ -n "$newest" ]; then
    newest_seg=$(( (16#${newest:0:8} << 8) + 16#${newest:8:8} ))
    if [ "$redo_seg" -lt "$newest_seg" ]; then
      echo "wal-restore: the replay stopped at segment $redo_seg of timeline $tli, but the archive goes to $newest_seg: a segment is missing" >&2
      exit 1
    fi
  fi
fi
# The new timeline's history file goes into the archive (archive_command, with the stack's settings); wait for it.
for _ in $(seq 1 30); do
  [ -n "$(docker exec "$container" sh -c 'ls /walarchive/*.history.gz 2>/dev/null')" ] && break
  sleep 1
done
docker stop -t 120 "$container" >/dev/null
docker rm "$container" >/dev/null

log "starting the stack (Electric starts fresh: replication slots are not part of a base backup)"
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U "$pg_user" -q 2>/dev/null; do sleep 1; done
docker compose up -d --force-recreate electric api
docker compose up -d
log "uploading the new timeline and a fresh base backup, so a second restore starts from here"
rclone_volume="$walarchive:/wal"
rclone move /wal "$wal_target" --include '*.gz' --checksum
rclone_volume=
WAL_LOCK_HELD=1 scripts/wal-base-backup.sh
trap - EXIT
rm -rf "$work"
log "done. Check the app; then delete $keep_dir (the data from before)"
