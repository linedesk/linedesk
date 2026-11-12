#!/usr/bin/env bash
# Dev mode (LINEDESK_MODE=dev, docker-compose.dev.yml): an update is moving this checkout, which the
# containers run from, to the new main. Their file watchers pick up the change within seconds.
#   scripts/deploy-dev.sh [<commit>]   default: the newest origin/main
# scripts/deploy.sh calls this in dev mode, so the server's deploy command stays the same.
#
# Refuses (logs why, exits 1, changes nothing) when the checkout is not on main, has local changes
# (someone is editing it, docs/dev-mode.md) or cannot fast-forward to the commit. Then runs
# scripts/deploy.sh --no-build, which recreates only the services whose compose settings changed and
# reloads a new Caddyfile.
set -euo pipefail

log() { echo "[deploy-dev $(date +%H:%M:%S)] $*"; }
refuse() {
  log "not updating: $*" >&2
  exit 1
}

# All in one function, read completely before it runs: the merge below rewrites this file.
main() {
  cd "$(dirname "$0")/.."
  local target=${1:-origin/main} branch before
  branch=$(git symbolic-ref --short -q HEAD || echo "a detached HEAD")
  [ "$branch" = main ] || refuse "the checkout is on $branch, not main (someone is working in it?)"
  [ -z "$(git status --porcelain)" ] || refuse "the checkout has local changes (someone is working in it?):
$(git status --short | head -20)"
  git fetch --quiet origin main || refuse "git fetch origin main failed"
  git rev-parse --verify --quiet "$target^{commit}" >/dev/null || refuse "unknown commit $target"
  git merge-base --is-ancestor "$target" origin/main || refuse "$target is not on origin/main"
  before=$(git rev-parse --short HEAD)
  if git merge-base --is-ancestor "$target" HEAD; then
    log "already at $before (contains $target)"
  else
    git merge --ff-only --quiet "$target" || refuse "cannot fast-forward $before to $target"
    log "updated $before -> $(git rev-parse --short HEAD)"
  fi
  # Compose settings and the Caddyfile; code is picked up by the watchers on their own.
  LINEDESK_DEV_UPDATED=1 exec scripts/deploy.sh --no-build
}
main "$@"
exit
