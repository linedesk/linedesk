#!/bin/sh
# Puts the docker compose stack of this checkout on a public HTTPS address with ngrok, so it runs like
# production: one https origin for the web app, the API, sign-in (cookies, passkeys, OAuth redirects) and
# LiveKit signalling (/rtc). Docs: docs/local.md.
#
# Usage (from the checkout the stack runs from):
#   scripts/local-public.sh start    start ngrok in the background, point the stack at its address
#   scripts/local-public.sh stop     stop ngrok, put the local address back
#   scripts/local-public.sh status
#
# The ngrok authtoken comes from ngrok's own config (`ngrok config add-authtoken`) or NGROK_AUTHTOKEN.
# The address is the account's own dev domain (free accounts have one, it stays the same), or NGROK_URL
# from .env (a reserved domain). Everything but OAuth callbacks, LiveKit signalling (its own tokens) and
# API-key requests (checked by the API) is behind basic auth, then a gate cookie: LINEDESK_TUNNEL_AUTH in .env, created on
# the first start.
#
# start changes these lines in .env and recreates the services they concern; stop restores them:
#   PUBLIC_URL, LIVEKIT_PUBLIC_URL, LIVEKIT_NODE_IP, LIVEKIT_BIND_IP, LINEDESK_TRUSTED_PROXY_RANGES
set -eu
cd "$(dirname "$0")/.."
envfile=.env
[ -f "$envfile" ] || { echo "No .env in $(pwd): run this in the checkout the stack runs from."; exit 1; }
managed="PUBLIC_URL LIVEKIT_PUBLIC_URL LIVEKIT_NODE_IP LIVEKIT_BIND_IP LINEDESK_TRUSTED_PROXY_RANGES"

get_env() { sed -n "s/^$1=//p" "$envfile" | tail -n 1; }
has_env() { grep -q "^$1=" "$envfile"; }
write_env() { # awk program, then its -v assignments; keeps the file private
  program=$1; shift
  tmp=$(mktemp "$envfile.XXXXXX")
  awk "$@" "$program" "$envfile" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$envfile"
}
# shellcheck disable=SC2016 # awk programs
set_env() { write_env '$0 ~ "^" k "=" { if (!done) print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' -v "k=$1" -v "v=$2"; }
# shellcheck disable=SC2016
unset_env() { write_env '$0 !~ "^" k "=" { print }' -v "k=$1"; }

project=$(get_env COMPOSE_PROJECT_NAME); project=${project:-linedesk}
state="${XDG_STATE_HOME:-$HOME/.local/state}/linedesk/$project"
mkdir -p "$state"; chmod 700 "$state"
pidfile="$state/ngrok.pid"
saved="$state/local.env" # the managed lines as they were before start

running() { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }
public_url() { cat "$state/url" 2>/dev/null || true; }

lan_ip() {
  ip=""
  for interface in en0 en1; do [ -z "$ip" ] && ip=$(ipconfig getifaddr "$interface" 2>/dev/null || true); done
  [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  echo "${ip:-127.0.0.1}"
}

start_ngrok() {
  command -v ngrok >/dev/null || { echo "ngrok is not installed (brew install ngrok)"; exit 1; }
  default_config=$(ngrok config check 2>/dev/null | sed -n 's/.*at \(.*\)$/\1/p' || true)
  if [ -z "${NGROK_AUTHTOKEN:-}" ] && ! { [ -f "$default_config" ] && grep -q authtoken "$default_config"; }; then
    echo "ngrok has no authtoken: run 'ngrok config add-authtoken <token>' (dashboard.ngrok.com) or set NGROK_AUTHTOKEN."
    exit 1
  fi
  credentials=$(get_env LINEDESK_TUNNEL_AUTH)
  if [ -z "$credentials" ]; then
    credentials="linedesk:$(openssl rand -hex 12)"
    set_env LINEDESK_TUNNEL_AUTH "$credentials"
  fi
  # Open: OAuth callbacks (the provider's redirect, protected by its state), LiveKit signalling (needs a
  # LiveKit token; browsers send no basic auth on a WebSocket) and Bearer requests to /v1/ and /mcp (API keys
  # and MCP clients, checked by the API; on any other path, /api/auth/* included, a Bearer header opens
  # nothing). The rest asks for basic auth once; the answer sets a gate cookie (derived from the credentials,
  # 30 days) that lets the browser's later requests through: fetch, the service worker and an installed
  # app do not all repeat basic auth. The API reads only Bearer credentials, so a Basic header the
  # browser keeps sending leaves the session cookie in charge.
  gate=$(printf '%s' "$credentials" | openssl dgst -sha256 -r | cut -c1-40)
  cat >"$state/policy.yml" <<YML
on_http_request:
  - expressions:
      - "!(req.url.path.startsWith('/rtc') || req.url.path.startsWith('/api/auth/callback/') || req.url.path.startsWith('/api/auth/oauth2/callback/') || req.url.path.startsWith('/v1/calendar/callback/') || ((req.url.path.startsWith('/v1/') || req.url.path == '/mcp') && 'authorization' in req.headers && req.headers['authorization'][0].startsWith('Bearer ')) || ('linedesk_gate' in req.cookies && req.cookies['linedesk_gate'][0].value == '$gate'))"
    actions:
      - type: basic-auth
        config:
          credentials: ["$credentials"]
on_http_response:
  - expressions:
      - "'authorization' in req.headers && req.headers['authorization'][0].startsWith('Basic ')"
    actions:
      - type: add-headers
        config:
          headers:
            set-cookie: "linedesk_gate=$gate; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax"
YML
  printf 'version: "3"\nagent:\n  web_addr: false\n' >"$state/agent.yml"
  chmod 600 "$state/policy.yml" "$state/agent.yml"
  configs="$state/agent.yml"
  [ -n "$default_config" ] && [ -f "$default_config" ] && configs="$default_config,$configs"
  bind=$(get_env LINEDESK_HTTP_BIND); bind=${bind:-80}
  url_flag=""; [ -n "$(get_env NGROK_URL)" ] && url_flag="--url=$(get_env NGROK_URL)"
  # shellcheck disable=SC2086
  nohup ngrok http "$bind" $url_flag --traffic-policy-file "$state/policy.yml" --config "$configs" \
    --log stdout --log-format json >"$state/ngrok.log" 2>&1 &
  echo $! >"$pidfile"
  url=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    url=$(sed -n 's/.*"msg":"started tunnel".*"url":"\(https:[^"]*\)".*/\1/p' "$state/ngrok.log" | tail -n 1)
    [ -n "$url" ] && break
    running || break
    sleep 1
  done
  if [ -z "$url" ]; then
    echo "ngrok did not start:"; grep -E '"lvl":"(eror|crit)"|ERR_NGROK' "$state/ngrok.log" | tail -n 5 || tail -n 5 "$state/ngrok.log"
    kill "$(cat "$pidfile")" 2>/dev/null || true; rm -f "$pidfile"; exit 1
  fi
  echo "$url" >"$state/url"
}

point_stack_at() { # public URL
  if [ ! -f "$saved" ]; then
    : >"$saved"; chmod 600 "$saved"
    for key in $managed; do has_env "$key" && echo "$key=$(get_env "$key")" >>"$saved"; done
  fi
  ip=$(lan_ip)
  set_env PUBLIC_URL "$1"
  set_env LIVEKIT_PUBLIC_URL "$(echo "$1" | sed 's/^https/wss/')"
  # Call audio cannot go through ngrok: LiveKit announces this machine's LAN address, so a phone on the
  # same network sends media straight here.
  set_env LIVEKIT_NODE_IP "$ip"
  set_env LIVEKIT_BIND_IP "$ip"
  # ngrok connects from the Docker host: Caddy keeps the X-Forwarded-For it adds, so rate limits see clients.
  set_env LINEDESK_TRUSTED_PROXY_RANGES "172.16.0.0/12 192.168.0.0/16"
  docker compose up -d --no-build 2>&1 | grep -E 'Recreate|Error|error' || true
}

restore_stack() {
  [ -f "$saved" ] || return 0
  for key in $managed; do
    line=$(grep "^$key=" "$saved" || true)
    if [ -n "$line" ]; then set_env "$key" "${line#*=}"; else unset_env "$key"; fi
  done
  rm -f "$saved"
  docker compose up -d --no-build 2>&1 | grep -E 'Recreate|Error|error' || true
}

warn_missing() {
  [ -n "$(get_env VAPID_PUBLIC_KEY)" ] || echo "Push notifications are off: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT are not set (docs/local.md)."
  [ -n "$(get_env GOOGLE_CLIENT_ID)" ] || echo "Google sign-in and calendar are off: GOOGLE_CLIENT_ID is not set (or set it under Admin > Providers)."
  [ -n "$(get_env MICROSOFT_CLIENT_ID)" ] || echo "Microsoft sign-in and calendar are off: MICROSOFT_CLIENT_ID is not set (or set it under Admin > Providers)."
}

case "${1:-status}" in
  start)
    if running; then echo "Already public: $(public_url)"; exit 0; fi
    start_ngrok
    url=$(public_url)
    point_stack_at "$url"
    code=$(curl -s -o /dev/null -w '%{http_code}' -u "$(get_env LINEDESK_TUNNEL_AUTH)" "$url/" || true)
    cat <<OUT
Public:  $url  (HTTP $code; basic auth: LINEDESK_TUNNEL_AUTH in .env)
Open the app only at this address now; the local address refuses sign-in until 'stop'.
Redirect URIs to register (Google, Microsoft, GitHub, OIDC):
  $url/api/auth/callback/<google|microsoft|github|oidc>
  $url/v1/calendar/callback/<google|microsoft>
Test call from a phone: same Wi-Fi as this machine (call audio goes to $(get_env LIVEKIT_NODE_IP) directly).
OUT
    warn_missing
    ;;
  stop)
    if running; then kill "$(cat "$pidfile")"; fi
    rm -f "$pidfile" "$state/url"
    restore_stack
    echo "Stopped; the stack is back on $(get_env PUBLIC_URL)."
    ;;
  status)
    if running; then echo "Public: $(public_url) (ngrok pid $(cat "$pidfile"))"; else echo "Not public; PUBLIC_URL=$(get_env PUBLIC_URL)"; fi
    ;;
  *) echo "Usage: scripts/local-public.sh start|stop|status"; exit 1 ;;
esac
