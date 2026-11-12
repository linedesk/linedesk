#!/usr/bin/env bash
# Update a running Linedesk stack (docker compose) without downtime and without dropping calls.
# Run it in the checkout, after `git pull`, with the same environment as your `docker compose` commands
# (.env, COMPOSE_PROJECT_NAME, COMPOSE_FILE, COMPOSE_PROFILES):
#   scripts/deploy.sh             build the images, then update
#   scripts/deploy.sh --no-build  update to the images already built
# Prebuilt images: when the checkout holds deploy-images.env (the test server's deploys put it into the
# archive, .github/workflows/deploy-staging.yml), the images of this commit are pulled from that
# registry instead of built here, so a deploy does not load the machine. Without it (self-hosting,
# local), the images are built here as before.
#
# 1. Build (or pull) while the old version serves.
# 2. api, then web: when the image or the service's settings changed, start a new container next to the
#    old one, wait until it is healthy (the proxy already sends requests to both and retries a request
#    on the other one when a container is not reachable), then stop the old one. The new API applies
#    the database migrations once when it starts, while the old API still serves: migrations must work
#    with the previous release (expand/contract, docs/architecture.md).
# 3. proxy (the entry point, it owns the published port): a new docker/Caddyfile is loaded into the
#    running Caddy (`caddy reload`, open connections are kept). Only a change to its compose settings
#    (ports, environment) recreates it, which interrupts the site for a few seconds; the script says so.
# 4. Every other service: `docker compose up -d`, which recreates only what changed (usually nothing).
# 5. agent: the new worker registers with LiveKit, then the old one gets SIGTERM, takes no new calls and
#    finishes the ones it has (up to stop_grace_period, 15 minutes); this script waits for that.
# First start (nothing running yet): a plain `docker compose up -d`.
#
# Dev mode (LINEDESK_MODE=dev in .env, docker-compose.dev.yml, docs/dev-mode.md): api, web and agent
# run from this checkout, so there is nothing to build. scripts/deploy-dev.sh moves the checkout to the
# new main (it refuses when the checkout has local changes) and comes back here with --no-build.
set -euo pipefail
cd "$(dirname "$0")/.."

# deploy-images.env (written by the staging workflow, never in git): `registry=` (e.g. ghcr.io/<owner>),
# `services=` (images to pull), `user=` and `token=` (the workflow's token, valid while it runs). Read
# and removed first, so the token is not kept on disk, also not in the copy of the previous release.
PREBUILT_FILE=deploy-images.env
prebuilt_registry='' prebuilt_services='' prebuilt_user='' prebuilt_token=''
if [ -f "$PREBUILT_FILE" ]; then
  prebuilt_registry=$(sed -n 's/^registry=//p' "$PREBUILT_FILE")
  prebuilt_services=$(sed -n 's/^services=//p' "$PREBUILT_FILE")
  prebuilt_user=$(sed -n 's/^user=//p' "$PREBUILT_FILE")
  prebuilt_token=$(sed -n 's/^token=//p' "$PREBUILT_FILE")
  rm -f "$PREBUILT_FILE"
fi

# Dev mode was called live mode until 2026-11: an .env from then is moved over once (LINEDESK_MODE=live,
# LINEDESK_LIVE_* limits, docker-compose.live.yml in COMPOSE_FILE), so a server deploys on without a hand edit.
if [ -f .env ] && grep -q '^LINEDESK_MODE=live$' .env; then
  sed -i.before-dev-mode -e 's/^LINEDESK_MODE=live$/LINEDESK_MODE=dev/' -e 's/^LINEDESK_LIVE_/LINEDESK_DEV_/' \
    -e 's/docker-compose\.live\.yml/docker-compose.dev.yml/g' .env
  echo "Moved .env from live mode to dev mode (the old file is .env.before-dev-mode)."
  [ "${LINEDESK_MODE-}" = live ] && export LINEDESK_MODE=dev
fi
# The deploy-dev.sh of a checkout from before the rename sets LINEDESK_LIVE_UPDATED.
[ -n "${LINEDESK_LIVE_UPDATED:-}" ] && export LINEDESK_DEV_UPDATED=1

mode=${LINEDESK_MODE-$(sed -n 's/^LINEDESK_MODE=//p' .env 2>/dev/null | tail -1)}
case "$mode" in
  dev)
    if ! grep -qx linedesk-dev <<<"$(docker compose config --images)"; then
      echo "LINEDESK_MODE=dev, but COMPOSE_FILE does not include docker-compose.dev.yml (see docker-compose.dev.yml)" >&2
      exit 1
    fi
    [ -n "${LINEDESK_DEV_UPDATED:-}" ] || exec scripts/deploy-dev.sh
    # Built once: one small image for api, web and agent (the code is not in it) and the proxy.
    docker image inspect linedesk-dev linedesk-proxy >/dev/null 2>&1 || docker compose build api proxy
    ;;
  "") ;;
  *)
    echo "LINEDESK_MODE is '$mode'; it is either dev or empty (image mode)" >&2
    exit 1
    ;;
esac

HEALTH_TIMEOUT=${LINEDESK_DEPLOY_HEALTH_TIMEOUT:-600} # seconds a new container may take to become healthy
ROLLED=(api web agent proxy) # handled one by one below; the rest goes through `docker compose up -d`

log() { echo "[deploy $(date +%H:%M:%S)] $*"; }

MIN_FREE_MB=${LINEDESK_DEPLOY_MIN_FREE_MB:-2048} # a build needs room for new image layers

# Free space on the disk that holds Docker's data, in MB.
docker_free_mb() {
  df -Pm "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /)" | awk 'NR == 2 { print $4 }'
}

# Pulls the prebuilt images of this commit (tag: the commit in REVISION, which the server's deploy
# command writes from what it was sent) and gives them the local names compose uses (linedesk-api, ...),
# so the rest of the update is the same as after a local build. The login lives in a throwaway Docker
# config, so no registry credential stays on this machine.
pull_prebuilt() {
  local tag service image docker_config
  tag=$(cat REVISION 2>/dev/null || true)
  if ! [[ "$tag" =~ ^[0-9a-f]{7,40}$ ]] || [ -z "$prebuilt_registry" ] || [ -z "$prebuilt_services" ] ||
    [ -z "$prebuilt_user" ] || [ -z "$prebuilt_token" ]; then
    log "$PREBUILT_FILE is incomplete or REVISION is missing: not deploying; the running version keeps serving." >&2
    exit 1
  fi
  docker_config=$(mktemp -d)
  # shellcheck disable=SC2064 # the directory is known now
  trap "rm -rf '$docker_config'" EXIT
  log "pulling the images of $tag from $prebuilt_registry (the running version keeps serving)"
  DOCKER_CONFIG=$docker_config docker login --username "$prebuilt_user" --password-stdin "${prebuilt_registry%%/*}" \
    <<<"$prebuilt_token" >/dev/null
  for service in $prebuilt_services; do
    image="$prebuilt_registry/linedesk-$service:$tag"
    DOCKER_CONFIG=$docker_config docker pull -q "$image" >/dev/null
    docker tag "$image" "linedesk-$service"
    docker rmi "$image" >/dev/null # only the registry name; the image stays as linedesk-$service
  done
  rm -rf "$docker_config"
  trap - EXIT
}

# Old build cache and untagged images pile up with several deploys an hour; images in use and volumes stay.
clean_up() {
  docker builder prune -f --filter until=24h >/dev/null || log "build cache cleanup failed (ignored)"
  docker image prune -f >/dev/null || log "image cleanup failed (ignored)"
  log "free disk: $(docker_free_mb) MB"
}

# Running containers of a service, one id per line.
containers_of() {
  docker compose ps -q "$1"
}

# True when the service's (first) running container runs the newest build of its image with the current
# settings. The settings are compared by compose itself (a dry run of `up`, which does not look at
# image builds), so they match what `docker compose up -d` would recreate.
is_current() {
  local container
  container=$(containers_of "$1" | head -1)
  [ "$(docker inspect -f '{{.Image}}' "$container")" = \
    "$(docker image inspect -f '{{.Id}}' "$(docker inspect -f '{{.Config.Image}}' "$container")")" ] &&
    ! grep -q Recreate <<<"$(docker compose up --dry-run -d --no-build --no-deps "$1" 2>&1)"
}

# The settings hash compose stored on the container vs. the current one (settings only, not the image).
same_settings() {
  [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$2")" = \
    "$(docker compose config --hash "$1" | awk -v s="$1" '$1 == s { print $2 }')" ]
}

wait_healthy() {
  local container=$1 status deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
    case "$status" in
      healthy) return 0 ;;
      unhealthy | exited | dead) break ;;
    esac
    sleep 1
  done
  log "new container ${container:0:12} did not become healthy ($status); its last log lines:"
  docker logs --tail 30 "$container" >&2 || true
  return 1
}

# Start-first replacement of one service: the old containers keep running until the new one is healthy.
roll() {
  local service=$1 old new count
  old=$(containers_of "$service")
  count=$(echo "$old" | grep -c . || true)
  if [ "$count" -eq 0 ]; then
    log "$service: not running; starting it"
    docker compose up -d --no-build --no-deps "$service"
    return
  fi
  if [ "$count" -eq 1 ] && is_current "$service"; then
    log "$service: unchanged"
    return
  fi
  log "$service: starting a new container next to the $count running"
  docker compose up -d --no-build --no-deps --no-recreate --scale "$service=$((count + 1))" "$service"
  new=$(containers_of "$service" | grep -vxF "$old" | head -1 || true)
  [ -n "$new" ] || { log "$service: no new container was started" >&2; exit 1; }
  if ! wait_healthy "$new"; then
    log "$service: keeping the old version; removing the new container"
    docker rm -f "$new" >/dev/null
    exit 1
  fi
  log "$service: new container healthy; stopping the old one (waits for its stop_grace_period at most)"
  for container in $old; do
    docker stop "$container" >/dev/null
    docker rm "$container" >/dev/null
  done
  log "$service: updated"
}

others() {
  docker compose config --services | grep -vxF -e "${ROLLED[0]}" -e "${ROLLED[1]}" -e "${ROLLED[2]}" -e "${ROLLED[3]}"
}

# The proxy cannot run twice (it owns the published port), so a new Caddyfile is reloaded in place.
update_proxy() {
  local container tries=0
  container=$(containers_of proxy | head -1)
  if [ -z "$container" ] || ! same_settings proxy "$container"; then
    [ -z "$container" ] || log "proxy: its compose settings changed; recreating it (the site is unreachable for a few seconds)"
    docker compose up -d --no-build --no-deps proxy
    container=$(containers_of proxy | head -1)
  fi
  # Compared with the file in the container, not the image: dev mode builds no new proxy image.
  if docker exec "$container" cat /etc/caddy/Caddyfile | cmp -s - docker/Caddyfile; then
    log "proxy: unchanged"
    return
  fi
  # A new Caddyfile: load it into the running Caddy. caddy reload checks the file first and keeps the
  # old configuration when it is invalid. The file is also written into the container, so a restart
  # keeps it; `docker compose up -d proxy` moves to the new image (brief interruption).
  log "proxy: loading the new Caddyfile into the running proxy"
  docker cp docker/Caddyfile "$container:/etc/caddy/Caddyfile"
  # A container that was just created may need a moment before Caddy takes a reload.
  until docker exec "$container" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; do
    tries=$((tries + 1))
    [ "$tries" -lt 10 ] || return 1
    sleep 1
  done
}

if [ -n "$prebuilt_registry" ] || [ "${1:-}" != --no-build ]; then
  free=$(docker_free_mb)
  if [ "$free" -lt "$MIN_FREE_MB" ]; then
    log "only ${free} MB free on Docker's disk (need ${MIN_FREE_MB}): not updating. Free space (docker builder prune, docker image prune) and deploy again; the running version keeps serving."
    exit 1
  fi
fi
if [ -n "$prebuilt_registry" ]; then
  pull_prebuilt
elif [ "${1:-}" != --no-build ]; then
  log "building images (the running version keeps serving)"
  # Without build attestations a rebuild from cache keeps the image id, so an unchanged service is
  # recognised as unchanged (Docker Desktop adds them by default and they differ on every build).
  BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose build
fi

if [ -z "$(docker compose ps -q api)" ]; then
  log "nothing running yet: starting the stack"
  docker compose up -d --no-build --remove-orphans
  clean_up
  exit 0
fi

roll api
roll web
update_proxy
log "other services: recreating only what changed"
# shellcheck disable=SC2046 # one service name per word
docker compose up -d --no-build --no-deps --remove-orphans $(others)
roll agent
clean_up
log "done"
