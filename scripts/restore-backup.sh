#!/usr/bin/env bash
# Proves a backup can be restored, without touching the running stack: downloads a backup made by
# scripts/backup.sh (the newest by default), decrypts it with the age private key, restores it into a
# throwaway Postgres container (same image as the stack's, no network) and prints row counts next to the
# live database's.
#   BACKUP_AGE_IDENTITY=/path/to/key.txt scripts/restore-backup.sh [linedesk-<time>.dump.age]
# The private key is needed only here; keep it off the server and remove it again after a check.
# A real restore (replacing the stack's database) is in README, "Backups".
set -euo pipefail
cd "$(dirname "$0")/.."

identity=${BACKUP_AGE_IDENTITY:-}
[ -n "$identity" ] && [ -r "$identity" ] || { echo "restore: set BACKUP_AGE_IDENTITY to the age private key file" >&2; exit 1; }
command -v age >/dev/null || { echo "restore: age is not installed (apt install age)" >&2; exit 1; }

# The listing and download go through backup.sh's settings and rclone.
setting() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//"; }
prefix=$(setting BACKUP_S3_PREFIX)
prefix=${prefix:-linedesk/}
target="b:$(setting BACKUP_S3_BUCKET)/${prefix%/}"
work=$(mktemp -d /var/tmp/linedesk-restore.XXXXXX)
chmod 700 "$work"
container=linedesk-restore-check-$$
trap 'docker rm -f "$container" >/dev/null 2>&1; rm -rf "$work"' EXIT
rclone() {
  docker run --rm -i --network host \
    -e RCLONE_CONFIG_B_TYPE=s3 -e RCLONE_CONFIG_B_PROVIDER=Other -e RCLONE_CONFIG_B_REGION=auto \
    -e RCLONE_CONFIG_B_ENDPOINT="$(setting BACKUP_S3_ENDPOINT)" \
    -e RCLONE_CONFIG_B_ACCESS_KEY_ID="$(setting BACKUP_S3_ACCESS_KEY_ID)" \
    -e RCLONE_CONFIG_B_SECRET_ACCESS_KEY="$(setting BACKUP_S3_SECRET_ACCESS_KEY)" \
    -e RCLONE_CONFIG_B_NO_CHECK_BUCKET=true -e RCLONE_LOG_LEVEL=ERROR \
    -v "$work:/work" rclone/rclone:1.68.2 "$@"
}
log() { echo "[restore $(date -u +%FT%TZ)] $*"; }

name=${1:-$(rclone lsf --include 'linedesk-*.dump.age' "$target" | sort | tail -n 1)}
[[ "$name" =~ ^linedesk-[0-9TZ]+\.dump\.age$ ]] || { echo "restore: no backup found (or not a backup name: '$name')" >&2; exit 1; }
log "downloading $name"
rclone copyto "$target/$name" "/work/$name"
age -d -i "$identity" -o "$work/db.dump" "$work/$name"

image=$(docker compose config --images 2>/dev/null | grep -m1 '^postgres:' || echo postgres:17)
log "restoring into a throwaway $image"
docker run -d --name "$container" --network none -e POSTGRES_PASSWORD=restore-check -e POSTGRES_USER=linedesk \
  -e POSTGRES_DB=linedesk "$image" >/dev/null
until docker exec "$container" pg_isready -U linedesk -q 2>/dev/null; do sleep 1; done
sleep 2 # the image restarts Postgres once after its first start
until docker exec "$container" pg_isready -U linedesk -q 2>/dev/null; do sleep 1; done
docker exec -i "$container" pg_restore -U linedesk -d linedesk --no-owner --exit-on-error < "$work/db.dump"

counts="select 'calls', count(*) from calls union all select 'users', count(*) from \"user\"
  union all select 'workspaces', count(*) from organization union all select 'contacts', count(*) from contacts"
echo "table       backup   live"
paste <(docker exec "$container" psql -U linedesk -d linedesk -tA -F ' ' -c "$counts") \
  <(docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F " " -c "$0"' "$counts" | cut -d' ' -f2) |
  awk '{ printf "%-11s %6s %6s\n", $1, $2, $3 }'
log "restore check passed: $name"
