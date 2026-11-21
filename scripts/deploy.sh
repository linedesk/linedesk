#!/usr/bin/env bash
# Update a running Linedesk stack (docker compose) without downtime and without dropping calls.
# Run it in the checkout, after `git pull`, with the same environment as your `docker compose` commands
# (.env, COMPOSE_PROJECT_NAME, COMPOSE_FILE, COMPOSE_PROFILES):
#   scripts/deploy.sh             build the images, then update
#   scripts/deploy.sh --no-build  update to the images already built
# Prebuilt images: when the checkout holds deploy-images.env (the test server's deploys put it into the
# archive), the images of this commit are pulled from that
# registry instead of built here, so a deploy does not load the machine. Without it (self-hosting,
# local), the images are built here as before.
#
# 1. Build (or pull) while the old version serves.
# 2. api and web (checked at the same time; web's new container starts once the new API serves): when the
#    image or the service's settings changed, start a new container next to the
#    old one, wait until it is healthy (the proxy already sends requests to both and retries a request
#    on the other one when a container is not reachable), then stop the old one. The new API applies
#    the database migrations once when it starts, while the old API still serves: migrations must work
#    with the previous release (expand/contract, docs/architecture.md).
# 3. proxy (the entry point, it owns the published port): a new docker/Caddyfile is loaded into the
#    running Caddy (`caddy reload`, open connections are kept). Only a change to its compose settings
#    (ports, environment) recreates it, which interrupts the site for a few seconds; the script says so.
# 4. Every other service: `docker compose up -d`, which recreates only what changed (usually nothing).
# 5. agent: the new worker registers with LiveKit, then the old one gets SIGTERM, takes no new calls and
#    finishes the ones it has in the background (up to stop_grace_period, 130 minutes: a call put through to
#    a person lasts up to 2 hours); this script does not wait for it.
# 6. The services every call runs through (livekit, livekit-sip, livekit-egress, redis, postgres, voice-link): only when
#    they changed, at a moment without live calls (up to LINEDESK_DEPLOY_QUIET_WAIT seconds, else left for the
#    next deploy; LINEDESK_DEPLOY_DROP_CALLS=1 recreates them at once and cuts off the calls in progress).
# First start (nothing running yet): a plain `docker compose up -d`.
# Separate voice servers (docs/hosting.md, "Separate voice servers"): a further voice server
# (docker-compose.voice.yml) runs only the agent: step 5 alone. Voice server 1 (docker-compose.voice-media.yml) runs the
# call services and an agent: steps 4 to 6, with "a moment without calls" read from LiveKit's rooms (no database
# there). On the app server (docker-compose.voice-link.yml) there is no agent; the voice link and the LiveKit forwarder
# count as call services (step 6): the voice servers' calls run through them.
#
# Dev mode (LINEDESK_MODE=dev in .env, docker-compose.dev.yml, docs/dev-mode.md): api, web and agent
# run from this checkout, so there is nothing to build. scripts/deploy-dev.sh moves the checkout to the
# newest commit of its branch, the repository's default branch by default (it refuses when the checkout has local changes) and comes back
# here with --no-build.
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

# AGENT_LOAD_THRESHOLD goes to the agent and, as agents.target_load, into LiveKit's config: a value outside
# 0 < x <= 1 makes the two disagree (0 dispatches no call at all) and a non-number breaks LiveKit's config.
load_threshold=${AGENT_LOAD_THRESHOLD-$(sed -n 's/^AGENT_LOAD_THRESHOLD=//p' .env 2>/dev/null | tail -1 | sed "s/^[\"']//; s/[\"']\$//")}
if [ -n "$load_threshold" ] && ! { [[ "$load_threshold" =~ ^[0-9]+(\.[0-9]+)?$ ]] &&
  awk -v v="$load_threshold" 'BEGIN { exit !(v > 0 && v <= 1) }'; }; then
  echo "AGENT_LOAD_THRESHOLD is '$load_threshold'; it is a number above 0 and at most 1 (e.g. 0.8), or empty. Not deploying; the running version keeps serving." >&2
  exit 1
fi

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
  # All images at once (they share layers, which Docker fetches once); named only when every pull worked.
  local pids=() services=() i failed=''
  for service in $prebuilt_services; do
    DOCKER_CONFIG=$docker_config docker pull -q "$prebuilt_registry/linedesk-$service:$tag" </dev/null >/dev/null &
    pids+=($!) services+=("$service")
  done
  for i in "${!pids[@]}"; do
    wait "${pids[$i]}" || failed+=" ${services[$i]}"
  done
  if [ -n "$failed" ]; then
    log "pulling failed for:$failed. Not deploying; the running version keeps serving." >&2
    exit 1
  fi
  for service in $prebuilt_services; do
    image="$prebuilt_registry/linedesk-$service:$tag"
    docker tag "$image" "linedesk-$service"
    docker rmi "$image" >/dev/null # only the registry name; the image stays as linedesk-$service
  done
  rm -rf "$docker_config"
  trap - EXIT
}

# Sentry release (packages/scrub/src/sentry-node.ts): linedesk@<commit>, from REVISION (written by the server's
# deploy command), so "resolved in the next release" works. Without REVISION (a checkout updated by git pull)
# SENTRY_RELEASE stays what the environment or .env says.
revision=$(cat REVISION 2>/dev/null || true)
release=''
[[ "$revision" =~ ^[0-9a-f]{7,40}$ ]] && release="linedesk@$revision"

# The release a service's new container gets: a running container whose image did not change keeps its own, so
# the new value alone does not replace it (an unchanged agent is not replaced).
release_of() {
  local container
  container=$(containers_of "$1" | head -1)
  if [ -n "$container" ] && [ "$(docker inspect -f '{{.Image}}' "$container")" = \
    "$(docker image inspect -f '{{.Id}}' "$(docker inspect -f '{{.Config.Image}}' "$container")" 2>/dev/null)" ]; then
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" | sed -n 's/^SENTRY_RELEASE=//p'
  else
    echo "$release"
  fi
}

# Old build cache and untagged images pile up with several deploys an hour; images in use and volumes stay.
clean_up() {
  docker builder prune -f --filter until=24h >/dev/null || log "build cache cleanup failed (ignored)"
  docker image prune -f >/dev/null || log "image cleanup failed (ignored)"
  log "free disk: $(docker_free_mb) MB"
}

# Running containers of a service, one id per line, newest first. What `docker compose ps -q` lists, asked of
# Docker by compose's labels: each `docker compose` call reads the whole project (about 0.6 s on a small server),
# this takes 0.1 s, and the deploy asks it many times. PROJECT and SERVICES are set once, before the update.
containers_of() {
  docker ps -q --no-trunc --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1" --filter label=com.docker.compose.oneoff=False
}

# Of the services given, the ones whose running container `docker compose up` would recreate (new image or
# settings), one per line: one dry run for all of them, as each `docker compose` call costs about a second.
would_recreate() {
  [ $# -gt 0 ] || return 0
  local plan service container name
  if ! plan=$(docker compose up --dry-run -d --no-build --no-deps "$@" 2>&1); then
    echo "$plan" >&2
    return 1
  fi
  for service in "$@"; do
    for container in $(containers_of "$service"); do
      name=$(docker inspect -f '{{.Name}}' "$container")
      # A line "Container <name> Recreate" (older versions put "DRY-RUN MODE - " in front).
      if awk -v name="${name#/}" '/Recreate/ { for (i = 1; i <= NF; i++) if ($i == name) found = 1 }
        END { exit !found }' <<<"$plan"; then
        echo "$service"
        break
      fi
    done
  done
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

# Rolls of api and web run at the same time (scripts/deploy.sh's main part): a roll marks its service ready in
# READY_DIR once the new version serves (or nothing changed), and a roll that must come after it waits for that.
mark_ready() { [ -z "${READY_DIR:-}" ] || touch "$READY_DIR/$1.ready"; }

# Waits until the roll of $1 (the job $2, which writes its exit status to READY_DIR/$1.exit) marked it ready;
# fails when that roll ended without (also when it was killed and wrote nothing) or took far longer than its
# health timeout.
wait_ready() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT + 300))
  until [ -e "$READY_DIR/$1.ready" ]; do
    if [ -e "$READY_DIR/$1.exit" ] || ! kill -0 "$2" 2>/dev/null || [ $SECONDS -ge $deadline ]; then
      [ -e "$READY_DIR/$1.ready" ] || return 1
    fi
    sleep 0.2
  done
}

# Start-first replacement of one service: the old containers keep running until the new one is healthy.
# With a second and third argument (a service and the pid of its roll), the new container starts only once that
# service's roll marked it ready (wait_ready).
roll() {
  local service=$1 after=${2:-} after_job=${3:-} old new count
  old=$(containers_of "$service")
  count=$(echo "$old" | grep -c . || true)
  if [ "$count" -eq 1 ] && is_current "$service"; then
    log "$service: unchanged"
    mark_ready "$service"
    return
  fi
  if [ -n "$after" ]; then
    [ -e "$READY_DIR/$after.ready" ] || log "$service: changed; its new container starts once $after is updated or found unchanged"
    if ! wait_ready "$after" "$after_job"; then
      log "$service: not updated, as $after's update failed; the old version keeps serving" >&2
      exit 1
    fi
  fi
  if [ "$count" -eq 0 ]; then
    log "$service: not running; starting it"
    docker compose up -d --no-build --no-deps "$service"
    mark_ready "$service"
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
  mark_ready "$service"
  if [ "$service" = agent ]; then
    # A call may run for up to 2 hours (one put through to a person), so the update does not wait for the
    # old agent: it drains in the background and Docker removes it once its calls are over.
    log "agent: new worker registered; the old one finishes its calls in the background (up to stop_grace_period)"
    for container in $old; do drain_in_background "$container"; done
  else
    log "$service: new container healthy; stopping the old one (waits for its stop_grace_period at most)"
    for container in $old; do
      docker stop "$container" >/dev/null
      docker rm "$container" >/dev/null
    done
  fi
  log "$service: updated"
}

# SIGTERM now (it takes no new calls), removal once it exits or its stop_grace_period is over. Detached
# from this script, so a deploy over SSH can end while the old agent still has calls.
drain_in_background() {
  local detach=()
  command -v setsid >/dev/null && detach=(setsid) # Linux; macOS has none, nohup alone does there
  docker kill --signal TERM "$1" >/dev/null
  # shellcheck disable=SC2016 # $1 is expanded by the inner sh
  "${detach[@]}" nohup sh -c 'docker stop "$1" >/dev/null 2>&1; docker rm "$1" >/dev/null 2>&1' drain "$1" </dev/null >/dev/null 2>&1 &
}

# Services that every call runs through: recreating one cuts off the calls in progress. They change only
# with a new version or new settings (rarely), and then wait for a moment without calls.
CALL_SERVICES=(livekit livekit-sip livekit-egress redis postgres voice-link)
QUIET_WAIT=${LINEDESK_DEPLOY_QUIET_WAIT:-1800} # seconds to wait for no live calls before giving up

# The call services this stack runs (livekit-egress only with the recording profile), one per line.
call_services() {
  grep -xF "${CALL_SERVICES[@]/#/-e}" <<<"$SERVICES" || true
}

# Calls in progress (empty when it cannot be asked, which counts as busy). On the app server: live calls in the
# database. On voice server 1 (no Postgres there): LiveKit's rooms with a caller in them (a phone leg or a browser; not
# the agent or egress), read through the agent container, as every call is a room. Not counted, as leftovers in Valkey
# that LiveKit can no longer close and that would otherwise hold every update back: a room older than 3 hours (a call
# lasts at most about 2 hours, a call put through to a person) and a room made before the running LiveKit started (a
# restart ends every call; such rooms held a staging deploy for its whole 30 minutes, LIN-413).
# Runs a short Node script (stdin) with the LiveKit SDK and the agent's LiveKit settings: in the running agent, or, on a
# media server without an agent (docker-compose.no-agent.yml), in a one-off container of the agent's image, which
# every deploy brings anyway. Prints what the script prints; nothing when it cannot run (a failure never stops the
# deploy: the callers treat no answer as busy or unknown). Each script ends itself after 20 s.
agent_node() {
  local agent
  agent=$(containers_of agent | head -1)
  if [ -n "$agent" ]; then
    docker exec -i "$agent" node - 2>/dev/null || true
  else
    # --pull never: never fetch or build an image on the server for this; no image means no answer.
    docker compose run --rm --no-deps --pull never -T --entrypoint node agent - 2>/dev/null || true
  fi
}

live_calls() {
  if ! grep -qx postgres <<<"$SERVICES"; then
    # The running LiveKit's start (Unix seconds); unknown: 0, so no room is dropped for it.
    local id started=0
    id=$(containers_of livekit | head -1)
    # Only with a container: `date -d ""` would give today's midnight and drop every call that started before it.
    [ -z "$id" ] || started=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null)" +%s 2>/dev/null) || started=0
    { echo "const LIVEKIT_STARTED = ${started:-0}"; cat <<'JS'; } | agent_node | tr -d '[:space:]'
setTimeout(() => process.exit(0), 20000).unref()
const { RoomServiceClient } = require("livekit-server-sdk")
const rooms = new RoomServiceClient(process.env.LIVEKIT_URL.replace(/^ws/, "http"), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET)
const CALLER_KINDS = new Set([0, 3]) // ParticipantInfo_Kind STANDARD (browser), SIP (phone)
const now = Date.now() / 1000
// Any error rejects the whole count, so nothing is printed and the deploy treats it as busy: never a 0 by mistake.
rooms.listRooms()
  .then((all) => all.filter((r) => r.numParticipants > 0 && now - Number(r.creationTime) < 3 * 3600 &&
    Number(r.creationTime) >= LIVEKIT_STARTED))
  .then((open) => Promise.all(open.map((r) => rooms.listParticipants(r.name).then((ps) => ps.some((p) => CALLER_KINDS.has(p.kind))))))
  .then((live) => console.log(live.filter(Boolean).length), () => {})
JS
    return
  fi
  # shellcheck disable=SC2016 # the variables are the postgres container's own
  echo "select count(*) from calls where status = 'live'" |
    docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA' 2>/dev/null | tr -d '[:space:]'
}

# LiveKit's SIP setup (setup-sip, setup-test-caller): "<inbound trunks> <outbound trunks> <dispatch rules>", read through
# the agent container (it has the SDK and LiveKit's keys); empty when it cannot be read.
sip_setup() {
  grep -qx agent <<<"$(docker compose config --services 2>/dev/null; docker compose --profile on-agent-server config --services 2>/dev/null)" || return 0
  agent_node <<'JS' | tr -d '\r'
setTimeout(() => process.exit(0), 20000).unref()
const { SipClient } = require("livekit-server-sdk")
const sip = new SipClient(process.env.LIVEKIT_URL.replace(/^ws/, "http"), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET)
Promise.all([sip.listSipInboundTrunk(), sip.listSipOutboundTrunk(), sip.listSipDispatchRule()])
  .then(([inbound, outbound, rules]) => console.log(inbound.length, outbound.length, rules.length))
  .catch(() => {})
JS
}

# After LiveKit or Redis was recreated: the SIP setup must still be there (Redis keeps it on its volume). A trunk or rule
# gone means no call reaches the agent: say what to run, and fail the deploy at the end so it does not go unnoticed.
check_sip_setup() {
  local before=$1 after="" tries=0 was now
  [ -n "$before" ] || return 0
  while [ -z "$after" ] && [ $tries -lt 12 ]; do # LiveKit takes a few seconds to answer after a restart
    sleep 5
    after=$(sip_setup)
    tries=$((tries + 1))
  done
  read -r -a was <<<"$before"
  read -r -a now <<<"${after:-0 0 0}"
  if [ "${now[0]}" -lt "${was[0]}" ] || [ "${now[1]}" -lt "${was[1]}" ] || [ "${now[2]}" -lt "${was[2]}" ]; then
    log "WARNING: LiveKit lost SIP setup (inbound/outbound trunks, dispatch rules: was $before, now ${after:-unreadable}). No call reaches the agent until it is set up again: setup-sip [--outbound] <every number>, and setup-test-caller where call tests run."
    SIP_SETUP_LOST=1
  else
    log "call services: SIP setup kept ($after)"
  fi
}

# The call services that are running but would be recreated (new image or settings), one per line.
changed_call_services() {
  local service running=()
  for service in $(call_services); do
    [ -z "$(containers_of "$service")" ] || running+=("$service")
  done
  [ ${#running[@]} -eq 0 ] || would_recreate "${running[@]}"
}

# Recreates the call services that changed, at a moment without live calls. LINEDESK_DEPLOY_DROP_CALLS=1
# does it at once (e.g. an urgent security update). Gives up after QUIET_WAIT; the next deploy tries again.
update_call_services() {
  local service plan changed=() missing=() again=() calls deadline=$((SECONDS + QUIET_WAIT))
  for service in $(call_services); do
    [ -n "$(containers_of "$service")" ] || missing+=("$service")
  done
  [ ${#missing[@]} -eq 0 ] || docker compose up -d --no-build --no-deps "${missing[@]}"
  if ! plan=$(changed_call_services); then
    log "call services: could not check them for changes (docker compose dry run failed, above); left as they are. The next deploy tries again."
    CALL_SERVICES_PENDING=1
    return
  fi
  read -r -a changed <<<"$(tr '\n' ' ' <<<"$plan")"
  if [ ${#changed[@]} -eq 0 ]; then
    log "call services: unchanged"
    return
  fi
  docker compose pull --quiet "${changed[@]}" 2>/dev/null || true # new images ready before the quiet moment
  if [ "${LINEDESK_DEPLOY_DROP_CALLS:-}" != 1 ]; then
    while :; do
      calls=$(live_calls)
      [ "$calls" = 0 ] && break
      if [ $SECONDS -ge $deadline ]; then
        log "call services: ${changed[*]} changed, but calls kept running for ${QUIET_WAIT}s; left on the old version. The next deploy tries again (LINEDESK_DEPLOY_DROP_CALLS=1 updates them now)."
        CALL_SERVICES_PENDING=1
        return
      fi
      log "call services: ${changed[*]} changed; waiting for a moment without calls (${calls:-?} live)"
      sleep 15
    done
  fi
  local sip_before
  sip_before=$(sip_setup)
  log "call services: recreating ${changed[*]}"
  docker compose up -d --no-build --no-deps "${changed[@]}"
  # livekit-sip and livekit-egress run in livekit's network: a new livekit container needs them recreated too.
  if ! plan=$(changed_call_services); then
    log "call services: could not check the ones that depend on what was just recreated (docker compose dry run failed, above). Check livekit-sip and livekit-egress; the next deploy tries again."
    CALL_SERVICES_PENDING=1
    check_sip_setup "$sip_before"
    return
  fi
  read -r -a again <<<"$(tr '\n' ' ' <<<"$plan")"
  if [ ${#again[@]} -gt 0 ]; then
    log "call services: recreating ${again[*]} (they depend on what was just recreated)"
    docker compose up -d --no-build --no-deps "${again[@]}"
  fi
  check_sip_setup "$sip_before"
}

others() {
  grep -vxF "${ROLLED[@]/#/-e}" "${CALL_SERVICES[@]/#/-e}" <<<"$SERVICES" || true
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

# The services of this stack. On its own line, so an invalid compose setup (a variable it requires is missing) stops
# here, under set -e, instead of being taken for a voice server below.
stack_services=$(docker compose config --services)


# The voice link publishes this server's part for the other servers on a private address: on the app server
# (docker-compose.voice-link.yml) the API's internal listener, on voice server 1 (docker-compose.voice-media.yml)
# LiveKit. Never start or recreate it unless that address is a private IPv4 address of this server on a WireGuard
# interface (on any other network the agent token would pass in clear; IPv6 has no firewall here), and, on a Linux
# server, the voice-link firewall is active (only the listed voice servers get in; ops/server/setup.sh installs it).
if grep -qx voice-link <<<"$stack_services"; then
  link_ip=${LINEDESK_VOICE_LINK_IP-$(sed -n 's/^LINEDESK_VOICE_LINK_IP=//p' .env 2>/dev/null | tail -1 | sed "s/^[\"']//; s/[\"']\$//")}
  refuse_link() {
    echo "The voice link is not started: $*. Not deploying; the running version keeps serving (docs/hosting.md, \"Separate voice servers\")." >&2
    exit 1
  }
  if ! [[ "$link_ip" =~ ^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$ ]] ||
    ! awk -F. '{ for (i = 1; i <= 4; i++) if ($i > 255) exit 1
      exit !($1 == 10 || ($1 == 172 && $2 >= 16 && $2 <= 31) || ($1 == 192 && $2 == 168) || ($1 == 100 && $2 >= 64 && $2 <= 127)) }' <<<"$link_ip"; then
    refuse_link "LINEDESK_VOICE_LINK_IP is '$link_ip', not a private IPv4 address (10/8, 172.16/12, 192.168/16, 100.64/10)"
  fi
  if [ "$(uname -s)" = Linux ]; then
    link_dev=$(ip -4 -o addr show | awk -v ip="$link_ip" '{ split($4, a, "/") } a[1] == ip { print $2; exit }')
    [ -n "$link_dev" ] || refuse_link "$link_ip is not an address of this server (is WireGuard up?)"
    ip -d link show dev "$link_dev" | grep -qw wireguard ||
      refuse_link "$link_ip is on $link_dev, which is not a WireGuard interface: the link is plain HTTP and must run inside WireGuard"
    systemctl is-active --quiet linedesk-voice-link-firewall.service ||
      refuse_link "linedesk-voice-link-firewall is not active (run sudo ops/server/setup.sh; journalctl -u linedesk-voice-link-firewall)"
  else
    log "not Linux: the voice link's address and firewall are not checked (a server runs Linux)"
  fi
fi

# Cores (LINEDESK_VOICE_CPUSET, a voice server's cores): every cpuset of this configuration must name cores this machine
# has. After a resize to fewer cores the old setting would make compose refuse to start the containers. And a container
# created with a cpuset naming a core that is gone cannot start at all: it stays down after the reboot, also when .env
# was fixed (LIN-413). Such containers are removed here, and the steps below create them again like any missing
# container. They are not running, so no call is cut off; a running container is never touched, and only services of
# this configuration count (never an old container of a profile that is off, e.g. the call services on an app server).
cpus_of() { tr ',' '\n' <<<"$1" | awk -F- 'NF == 1 && $1 != "" { print $1 } NF == 2 { for (i = $1; i <= $2; i++) print i }'; }
cores=''
if [ -r /sys/devices/system/cpu/online ]; then
  cores=$(cpus_of "$(cat /sys/devices/system/cpu/online)")
else # macOS: Docker Desktop's VM, cores 0 to NCPU-1
  ncpu=$(docker info -f '{{.NCPU}}' 2>/dev/null || true)
  [[ "$ncpu" =~ ^[1-9][0-9]*$ ]] && cores=$(seq 0 $((ncpu - 1)))
fi
cpuset_fits() { # <cpuset>: every core it names is one this machine has
  local core
  for core in $(cpus_of "$1"); do grep -qx "$core" <<<"$cores" || return 1; done
}
if [ -n "$cores" ]; then
  for cpuset in $(docker compose config 2>/dev/null | sed -n 's/^ *cpuset: *"\{0,1\}\([0-9,-]*\)"\{0,1\} *$/\1/p' | sort -u); do
    cpuset_fits "$cpuset" || {
      log "a cpuset of this configuration is $cpuset, but this machine's cores are $(tr '\n' ' ' <<<"$cores"): set LINEDESK_VOICE_CPUSET in .env to cores it has (docs/self-hosting.md, \"Memory and CPU\"). Not deploying; the running version keeps serving." >&2
      exit 1
    }
  done
  while read -r service container; do
    [ -n "$container" ] && grep -qx "$service" <<<"$stack_services" || continue
    state=$(docker inspect -f '{{.State.Running}} {{.HostConfig.CpusetCpus}}' "$container" 2>/dev/null) || continue
    [ "${state%% *}" = false ] && [ -n "${state#* }" ] || continue
    cpuset_fits "${state#* }" && continue
    log "$service: container ${container:0:12} was created for cores this machine no longer has (${state#* }), so it cannot start; removing it, the deploy creates it again"
    docker rm "$container" >/dev/null
  done < <(docker compose ps -a --format '{{.Service}} {{.ID}}' 2>/dev/null)
fi

# A voice server (no API). Voice servers 2+ (docker-compose.voice.yml): only the agent worker, replaced start-first like
# on a single server (the old one drains). Voice server 1 (docker-compose.voice-media.yml) also runs LiveKit, SIP and
# egress: they change only at a moment without calls (update_call_services), as on a single server.
if ! grep -qx api <<<"$stack_services"; then
  SERVICES=$stack_services
  PROJECT=$(docker compose config 2>/dev/null | sed -n '1s/^name: //p')
  [ -n "$PROJECT" ] || { log "could not read the compose project: not updating; the running version keeps serving." >&2; exit 1; }
  if [ -n "$release" ]; then SENTRY_RELEASE=$(release_of agent); export SENTRY_RELEASE; fi
  if grep -qx livekit <<<"$stack_services"; then
    log "other services: recreating only what changed"
    # shellcheck disable=SC2046 # one service name per word
    docker compose up -d --no-build --no-deps --remove-orphans $(others)
    if grep -qx agent <<<"$stack_services"; then
      roll agent
    elif [ -n "$(containers_of agent)" ]; then # a media server that had an agent (docs/hosting.md)
      log "WARNING: an agent still runs here, but this configuration has none (docker-compose.no-agent.yml): it keeps taking calls on its old version. Stop it: docker compose stop agent (it drains), then docker compose rm -f agent"
    fi
    update_call_services
    clean_up
    if [ -n "${CALL_SERVICES_PENDING:-}" ]; then
      log "done, except the call services above: exit 75"
      exit 75
    fi
    if [ -n "${SIP_SETUP_LOST:-}" ]; then
      log "done, but LiveKit lost SIP setup (see the warning above): exit 76"
      exit 76
    fi
    log "done (voice server 1: LiveKit, SIP and egress$(grep -qx agent <<<"$stack_services" && echo ", and the agent"))"
    exit 0
  fi
  roll agent
  clean_up
  log "done (voice server: agent only)"
  exit 0
fi

running_api=$(docker compose ps -q api)
running_api=${running_api%%$'\n'*} # the first one; no `| head -1`, which pipefail can fail with SIGPIPE
if [ -z "$running_api" ]; then
  log "nothing running yet: starting the stack"
  [ -z "$release" ] || export SENTRY_RELEASE="$release"
  docker compose up -d --no-build --remove-orphans
  clean_up
  exit 0
fi
# Asked once (containers_of, call_services, others): the compose project, read off the running API so it is
# the one compose itself uses, and the services of this configuration.
PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$running_api")
SERVICES=$(docker compose config --services)
if [ -z "$PROJECT" ] || [ -z "$SERVICES" ]; then
  log "could not read the compose project or its services: not updating; the running version keeps serving." >&2
  exit 1
fi

# api and web at the same time, each with its own exit status. web's new container starts only once the new
# API serves (it may need the API's migrations or new actions), so its check and its start overlap with the
# API's start and the stop of the old API. A failure of either keeps that service's old version and fails
# the deploy after both are done; when the API fails, web is not updated.
if [ -n "$release" ]; then SENTRY_RELEASE=$(release_of api); export SENTRY_RELEASE; fi
READY_DIR=$(mktemp -d)
# shellcheck disable=SC2064 # the directory is known now
trap "rm -rf '$READY_DIR'" EXIT
# shellcheck disable=SC2016 # expanded when the roll ends
(trap 'echo $? >"$READY_DIR/api.exit"' EXIT; roll api) &
api_job=$!
roll web api "$api_job" &
web_job=$!
rolled=0
wait "$api_job" || rolled=1
wait "$web_job" || rolled=1
rm -rf "$READY_DIR"
trap - EXIT
unset READY_DIR
[ "$rolled" -eq 0 ] || exit 1
update_proxy
log "other services: recreating only what changed"
# shellcheck disable=SC2046 # one service name per word
docker compose up -d --no-build --no-deps --remove-orphans $(others)
if grep -qx agent <<<"$SERVICES"; then # not on an app server with voice servers (docker-compose.voice-link.yml)
  if [ -n "$release" ]; then SENTRY_RELEASE=$(release_of agent); export SENTRY_RELEASE; fi
  roll agent
fi
update_call_services
clean_up
# Everything else is updated, but a new LiveKit, SIP, Redis or Postgres is not running yet: fail the deploy,
# so this cannot go unnoticed (a security release may need LINEDESK_DEPLOY_DROP_CALLS=1).
if [ -n "${CALL_SERVICES_PENDING:-}" ]; then
  log "done, except the call services above: exit 75"
  exit 75
fi
if [ -n "${SIP_SETUP_LOST:-}" ]; then
  log "done, but LiveKit lost SIP setup (see the warning above): exit 76"
  exit 76
fi
log "done"
