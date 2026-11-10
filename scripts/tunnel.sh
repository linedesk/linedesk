#!/bin/sh
# Exposes this machine's dev web app (with the API behind its proxy) and LiveKit's signalling over
# HTTPS with ngrok, so the test call in Assistant settings can be tried from a phone's browser.
# Usage: scripts/tunnel.sh [web-port]   (default 5173; LiveKit on LIVEKIT_PORT, default 7880)
# The ngrok authtoken comes from NGROK_AUTHTOKEN or ngrok's own config (`ngrok config add-authtoken`);
# NGROK_BASIC_AUTH=user:password closes the web tunnel. Nothing is written into the repository.
#
# Limits: ngrok tunnels HTTP only. Call audio (WebRTC media) does not go through it, so the phone
# must be on the same network as this machine (LiveKit then sends media over the LAN), and a real
# phone call cannot go through ngrok at all: SIP media is UDP. Real calls need the test server.
set -eu
web=${1:-5173}
livekit=${LIVEKIT_PORT:-7880}
command -v ngrok >/dev/null || { echo "ngrok is not installed (brew install ngrok)"; exit 1; }
# The web tunnel exposes the whole dev app and API: it is closed behind HTTP basic auth.
case "${NGROK_BASIC_AUTH:-}" in
  *:????????*) ;;
  *) echo "Set NGROK_BASIC_AUTH=user:password (password at least 8 characters); the web tunnel requires it."; exit 1 ;;
esac

pid=""
dir=$(mktemp -d)
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$dir"; }
trap cleanup EXIT INT TERM
# The LiveKit tunnel carries signalling and LiveKit's API. Both need a token signed with the LiveKit
# key; browsers cannot send basic auth on a WebSocket, so this one stays open to anyone with a token.
cat > "$dir/tunnels.yml" <<YML
version: "2"
tunnels:
  web: { proto: http, addr: $web, host_header: rewrite, basic_auth: ["$NGROK_BASIC_AUTH"] }
  livekit: { proto: http, addr: $livekit }
YML
chmod 600 "$dir/tunnels.yml"
default_config=$(ngrok config check 2>/dev/null | sed -n 's/.*at \(.*\)$/\1/p' || true)
configs="$dir/tunnels.yml"
[ -n "$default_config" ] && [ -f "$default_config" ] && configs="$default_config,$configs"
ngrok start --all --config "$configs" --log stdout --log-level warn >"$dir/ngrok.log" 2>&1 &
pid=$!

url_of() { curl -s http://127.0.0.1:4040/api/tunnels | sed -n "s/.*\"name\":\"$1\"[^}]*\"public_url\":\"\(https:[^\"]*\)\".*/\1/p"; }
for _ in 1 2 3 4 5 6 7 8 9 10; do
  web_url=$(url_of web); livekit_url=$(url_of livekit)
  [ -n "$web_url" ] && [ -n "$livekit_url" ] && break
  sleep 1
done
[ -n "${web_url:-}" ] && [ -n "${livekit_url:-}" ] || { echo "ngrok did not start:"; cat "$dir/ngrok.log"; exit 1; }
lan_ip=""
for interface in en0 en1; do [ -z "$lan_ip" ] && lan_ip=$(ipconfig getifaddr "$interface" 2>/dev/null || true); done
[ -z "$lan_ip" ] && lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
[ -z "$lan_ip" ] && lan_ip="<this machine's LAN IP>"

cat <<OUT
Web app:  $web_url
LiveKit:  ${livekit_url}

Set these in .env, then restart the API and LiveKit (pnpm voice:up recreates it):
WEB_ORIGIN=$web_url
BETTER_AUTH_URL=$web_url
LIVEKIT_PUBLIC_URL=$(echo "$livekit_url" | sed 's/^https/wss/')
LIVEKIT_NODE_IP=$lan_ip

Open the web app on the phone (same Wi-Fi), enter the basic-auth user and password, sign in,
Settings > Assistant > Start test call.
Undo the four lines when done. Ctrl-C stops the tunnels.
OUT
wait "$pid"
