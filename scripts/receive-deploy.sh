#!/usr/bin/env bash
# Receives a deploy from GitHub Actions on a server: the forced command of the deploy key, so this script
# is all that key can run. The workflow sends `git archive` of the commit (with deploy-images.env added) on
# stdin and the short commit as the SSH command:
#   git archive HEAD | ssh -i deploy-key user@server <short-sha>
# It unpacks the release next to the running one, keeps the server's .env and backup.env, swaps the directories (the old
# release stays as prev/ for a rollback by hand) and runs scripts/deploy.sh there; its exit code is the result.
#
# Install (once, as the user that runs the stack, member of the docker group), with BASE the parent of app/:
#   install -m 755 scripts/receive-deploy.sh "$BASE/receive-deploy.sh"
#   authorized_keys: restrict,command="$BASE/receive-deploy.sh" ssh-ed25519 AAAA... deploy
# Install a copy outside app/: app/ is replaced by every deploy.
# Linedesk's own production uses a separate receiver that checks the release itself.
set -euo pipefail
umask 077 # deploy-images.env holds a registry token until scripts/deploy.sh reads and deletes it

BASE=$(cd "$(dirname "$0")" && pwd)
REV="${SSH_ORIGINAL_COMMAND:-${1:-}}"
[[ "$REV" =~ ^[0-9a-f]{7,40}$ ]] || { echo "usage: archive on stdin, short commit as the command" >&2; exit 2; }

exec 9>"$BASE/deploy.lock"
flock -w 1800 9 || { echo "another deploy is still running" >&2; exit 3; }

rm -rf "$BASE/next" && mkdir "$BASE/next"
# At most 200 MB; GNU tar drops leading / and refuses .. in member names.
head -c 200000000 | tar -x --no-same-owner --no-same-permissions -C "$BASE/next"
[ -f "$BASE/next/docker-compose.yml" ] && [ -x "$BASE/next/scripts/deploy.sh" ] ||
  { echo "archive incomplete" >&2; rm -rf "$BASE/next"; exit 3; }
echo "$REV" > "$BASE/next/REVISION"
# Readable for the containers, except deploy-images.env, which stays 600 from the umask at every moment.
find "$BASE/next" ! -name deploy-images.env -exec chmod u+rwX,go+rX {} +
# The server's own files after that, with their modes (600): .env and the backup settings (scripts/backup-settings.sh).
cp -p "$BASE/app/.env" "$BASE/next/.env"
[ ! -f "$BASE/app/backup.env" ] || cp -p "$BASE/app/backup.env" "$BASE/next/backup.env"
rm -rf "$BASE/prev" && mv "$BASE/app" "$BASE/prev" && mv "$BASE/next" "$BASE/app"

cd "$BASE/app"
status=0
scripts/deploy.sh 2>&1 | tee -a "$BASE/deploy.log" || status=${PIPESTATUS[0]}
echo "deployed $REV at $(date -Is) (exit $status)" | tee -a "$BASE/deploy.log"
exit "$status"
