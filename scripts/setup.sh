#!/bin/sh
# Makes .env for a new install: a copy of .env.example with a random value for every secret the parts of
# Linedesk share (database, Electric, auth, SECRETS_KEY, agent token, LiveKit), and PUBLIC_URL. Nothing
# else is needed to start: phone, voice, AI, email and sign-in are connected in the app (Server admin › Providers),
# and the first admin signs up with the setup code the API prints to its log.
#
#   scripts/setup.sh                        # http://localhost
#   scripts/setup.sh https://desk.example.com
#   docker compose up -d && docker compose logs api | grep -A3 "setup code"
#   scripts/setup.sh --check                # what is still missing for a first answered call
#     exit 0: every part works; 1: something is missing or failing, or the stack is not running; 2: the check failed
#
# Run again, it keeps every value that is set and only fills secrets that are empty or still the
# development value. It never changes POSTGRES_PASSWORD once set: the database keeps the first one.
set -eu
cd "$(dirname "$0")/.."

# The instance setup checklist (apps/api/src/setup-check.ts): in the running API container; from the checkout
# only in a development checkout (node_modules installed).
if [ "${1:-}" = "--check" ]; then
  if [ -f docker-compose.yml ] && docker compose ps --status running --services 2>/dev/null | grep -qx api; then
    exec docker compose exec -T api node apps/api/src/setup-check.ts
  fi
  if [ ! -d node_modules ]; then
    echo "Start the stack first: docker compose up -d" >&2
    exit 1
  fi
  exec node --env-file-if-exists=.env apps/api/src/setup-check.ts
fi

public_url=${1:-}
case "$public_url" in
  "" | http://* | https://*) ;;
  *) echo "The address starts with http:// or https://, e.g. https://desk.example.com" >&2; exit 1 ;;
esac

fresh=false
[ -f .env ] || { cp .env.example .env; chmod 600 .env; fresh=true; echo "Made .env from .env.example."; }

hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }

# The value of NAME in .env ("" when absent or commented out), without quotes.
current() { sed -n "s/^$1=//p" .env | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//"; }

# Sets NAME=VALUE in .env: replaces an active or commented-out line, else appends one.
put() {
  tmp=$(mktemp)
  awk -v name="$1" -v value="$2" '
    !done && ($0 ~ "^" name "=" || $0 ~ "^#" name "=") { print name "=" value; done = 1; next }
    { print }
    END { if (!done) print name "=" value }
  ' .env >"$tmp"
  cat "$tmp" >.env
  rm -f "$tmp"
}

# Fills NAME with VALUE when it is empty or one of the development values.
fill() {
  value=$(current "$1")
  case "$value" in
    "" | devkey | devsecret-* | dev-* | change-me*) put "$1" "$2"; echo "  $1: made" ;;
  esac
}

# AGENT_LOAD_THRESHOLD also goes into LiveKit's config (agents.target_load): only a number above 0 and at most 1
# keeps the agent and LiveKit in agreement (0 dispatches no call; a non-number breaks LiveKit's config).
load_threshold=$(current AGENT_LOAD_THRESHOLD)
if [ -n "$load_threshold" ] && ! { printf '%s\n' "$load_threshold" | grep -Eqx '[0-9]+(\.[0-9]+)?' &&
  awk -v v="$load_threshold" 'BEGIN { exit !(v > 0 && v <= 1) }'; }; then
  echo "AGENT_LOAD_THRESHOLD in .env is '$load_threshold'; it is a number above 0 and at most 1 (e.g. 0.8), or empty." >&2
  exit 1
fi

echo "Secrets:"
fill BETTER_AUTH_SECRET "$(b64 32)"
fill SECRETS_KEY "$(b64 32)"
fill ELECTRIC_SECRET "$(hex 24)"
fill AGENT_API_TOKEN "$(hex 24)"
fill LIVEKIT_API_KEY "API$(hex 6)"
fill LIVEKIT_API_SECRET "$(hex 24)"
# Only in a new .env: an existing database keeps the password it was created with.
if [ -z "$(current POSTGRES_PASSWORD)" ]; then
  if $fresh; then
    put POSTGRES_PASSWORD "$(hex 24)"
    echo "  POSTGRES_PASSWORD: made"
  else
    echo "  POSTGRES_PASSWORD: not set; left alone (an existing database keeps its first password)"
  fi
fi
# `pnpm dev` reaches the compose database on the host with the same password; a database of your own stays.
password=$(current POSTGRES_PASSWORD)
case "$(current DATABASE_URL)" in
  postgres://linedesk:*@localhost:5433/linedesk) [ -n "$password" ] && put DATABASE_URL "postgres://linedesk:$password@localhost:5433/linedesk" ;;
esac

if [ -n "$public_url" ]; then
  put PUBLIC_URL "$public_url"
  echo "PUBLIC_URL: $public_url"
fi
chmod 600 .env

echo
echo "Next: docker compose up -d"
echo "Then open $(current PUBLIC_URL | sed 's/^$/http:\/\/localhost/') and enter the setup code from: docker compose logs api"
