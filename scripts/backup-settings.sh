# shellcheck shell=bash
# Settings and bucket access of the offsite backup, sourced by scripts/backup.sh and scripts/restore-backup.sh
# from the stack's directory.
#
# The settings live in backup.env next to .env (BACKUP_ENV_FILE names another file), never in .env: the API
# container reads all of .env (docker-compose.yml, env_file), and the bucket key can delete every backup.
# The file must be readable by its owner only (chmod 600 backup.env). An install that still has them in .env
# keeps backing up, with a warning, until they are moved.

backup_env_file=${BACKUP_ENV_FILE:-backup.env}
# Set only by the script that sources this (scripts/wal-archive.sh), never from the environment.
rclone_volume=

if [ -f "$backup_env_file" ]; then
  # Group and others: no access at all (ls shows "------" for them).
  # shellcheck disable=SC2012 # one file named by us, only its mode is read
  [ "$(ls -ld -- "$backup_env_file" | cut -c5-10)" = "------" ] || {
    echo "backup: $backup_env_file holds the bucket key and must be readable by its owner only: chmod 600 $backup_env_file" >&2
    exit 1
  }
elif [ -n "${BACKUP_ENV_FILE:-}" ]; then
  echo "backup: BACKUP_ENV_FILE is set, but $backup_env_file does not exist" >&2
  exit 1
elif grep -q '^BACKUP_S3_' .env 2>/dev/null; then
  echo "backup: warning: the backup settings are in .env, which the API container reads. Move every BACKUP_ line into backup.env (chmod 600) and recreate the API (docker compose up -d api)." >&2
  backup_env_file=.env
fi

# The value of NAME in the settings file (without quotes), or the environment's when it is set there.
setting() {
  local value=${!1:-}
  [ -n "$value" ] || value=$(sed -n "s/^$1=//p" "$backup_env_file" 2>/dev/null | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//")
  printf '%s' "$value"
}

# rclone with the bucket as remote `b:`. The keys go to docker as environment, by name only, so they never
# show in the process list (ps) with the docker command line. `$work` is mounted at /work, and `$rclone_volume`
# (a volume, `name:/path`) too when it is set.
# shellcheck disable=SC2154 # $work is set by the script that sources this before it calls rclone
rclone() {
  RCLONE_CONFIG_B_ENDPOINT=$(setting BACKUP_S3_ENDPOINT) \
    RCLONE_CONFIG_B_ACCESS_KEY_ID=$(setting BACKUP_S3_ACCESS_KEY_ID) \
    RCLONE_CONFIG_B_SECRET_ACCESS_KEY=$(setting BACKUP_S3_SECRET_ACCESS_KEY) \
    docker run --rm -i --network host \
    -e RCLONE_CONFIG_B_TYPE=s3 -e RCLONE_CONFIG_B_PROVIDER=Other -e RCLONE_CONFIG_B_REGION=auto \
    -e RCLONE_CONFIG_B_ENDPOINT -e RCLONE_CONFIG_B_ACCESS_KEY_ID -e RCLONE_CONFIG_B_SECRET_ACCESS_KEY \
    -e RCLONE_CONFIG_B_NO_CHECK_BUCKET=true -e RCLONE_LOG_LEVEL=ERROR \
    -v "$work:/work" ${rclone_volume:+-v "$rclone_volume"} rclone/rclone:1.68.2 "$@"
}
