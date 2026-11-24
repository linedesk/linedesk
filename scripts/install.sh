#!/bin/sh
# Installs Linedesk on a new Linux server (Ubuntu 22.04 or newer, Debian 12 or newer) with one command, as root:
#
#   curl -fsSL https://raw.githubusercontent.com/linedesk/linedesk/HEAD/scripts/install.sh | sudo sh
#   curl -fsSL https://raw.githubusercontent.com/linedesk/linedesk/HEAD/scripts/install.sh | sudo sh -s -- desk.example.com
#
# The second form uses your own domain: point its DNS A record at the server first. Without a domain, the install
# gets a free name for the server's IP (203-0-113-7.sslip.io) with a real certificate, so it is on https from the
# start; run the command again with your domain later. The same command works as "user data" (cloud-init) when you
# create the server, see docs/hosting.md.
#
# What it does, and nothing else:
#   1. Installs Docker (Docker's own install script) and git when they are missing. On a machine with less than
#      4 GB of memory and no swap, it adds a 2 GB swap file, so building the images does not run out of memory.
#   2. Puts the code in /opt/linedesk (LINEDESK_DIR) and makes .env with a random value for every secret
#      (scripts/setup.sh), with the server's public IP for call audio and SIP, and HTTPS by Linedesk's own Caddy.
#   3. Builds and starts the stack (docker compose up -d --build, about 10 minutes on a small server), then prints
#      the address and the one-time setup code, also saved to /root/linedesk-setup.txt.
#
# Run again, it keeps the code, every secret and all data; it only changes the address when you pass a domain.
# It installs the newest release (the highest v* tag), not the newest commit on main.
# Updates later: cd /opt/linedesk && scripts/update.sh (the newest release again, then scripts/deploy.sh)
#
# Settings (environment): LINEDESK_DIR (default /opt/linedesk), LINEDESK_REPO (the git URL), LINEDESK_REF (a tag or
# branch instead of the newest release, e.g. main), LINEDESK_PUBLIC_IP (when the IP cannot be found out by asking
# api.ipify.org).
set -eu

dir=${LINEDESK_DIR:-/opt/linedesk}
repo=${LINEDESK_REPO:-https://github.com/linedesk/linedesk.git}
summary=/root/linedesk-setup.txt

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nLinedesk install stopped: %s\n' "$*" >&2; exit 1; }

# The value of NAME in .env ("" when absent or commented out).
current() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//" || true; }
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

# Everything runs inside main, so a shell reading this script from a pipe (curl | sh) has all of it before it starts.
main() {
  [ "$(id -u)" = 0 ] || fail "run it as root, e.g. curl -fsSL <this script> | sudo sh"
  command -v apt-get >/dev/null 2>&1 || fail "this script supports Ubuntu and Debian. Elsewhere, follow docs/self-hosting.md."

  domain=$(printf '%s' "${1:-}" | sed 's#^https\{0,1\}://##; s#/.*$##')

  # 1. Packages, swap, Docker.
  if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    say "Installing git and curl"
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates >/dev/null
  fi
  mem_kb=$(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' /proc/meminfo)
  if [ "${mem_kb:-0}" -lt 1800000 ]; then
    printf 'Note: this server has less than 2 GB of memory. Linedesk needs about 2 GB; 2 GB is the minimum, 4 GB is better.\n'
  fi
  if [ "${mem_kb:-0}" -lt 4000000 ] && [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ ! -e /swapfile ]; then
    say "Adding a 2 GB swap file (less than 4 GB of memory)"
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi
  if ! docker compose version >/dev/null 2>&1; then
    say "Installing Docker"
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi

  # 2. The code and .env.
  if [ -d "$dir/.git" ]; then
    say "Linedesk is already in $dir: keeping its code, secrets and data"
  else
    ref=${LINEDESK_REF:-$(git ls-remote --tags --refs --sort=-v:refname "$repo" 'v*' | awk -F/ 'NR == 1 { print $3 }')}
    say "Downloading Linedesk ${ref:-(main)} into $dir"
    if [ -n "$ref" ]; then
      git clone --quiet --depth 1 --branch "$ref" "$repo" "$dir"
    else
      git clone --quiet --depth 1 "$repo" "$dir"
    fi
  fi
  cd "$dir"

  ip=${LINEDESK_PUBLIC_IP:-$(curl -fsS4 --max-time 10 https://api.ipify.org 2>/dev/null || true)}
  printf '%s' "$ip" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' ||
    fail "could not find this server's public IPv4 address. Set it yourself: LINEDESK_PUBLIC_IP=<address> and run again."

  if [ -n "$domain" ]; then
    resolved=$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR == 1 { print $1 }')
    if [ "$resolved" != "$ip" ]; then
      printf 'Note: %s points to %s, not to this server (%s). Set its DNS A record to %s; the certificate is fetched once it does.\n' \
        "$domain" "${resolved:-nothing}" "$ip" "$ip"
    fi
    url="https://$domain"
  elif [ -n "$(current PUBLIC_URL)" ] && [ "$(current PUBLIC_URL)" != "http://localhost" ]; then
    url=$(current PUBLIC_URL) # a run without a domain keeps the address it has
  else
    url="https://$(printf '%s' "$ip" | tr . -).sslip.io"
  fi

  say "Settings (.env)"
  scripts/setup.sh "$url" >/dev/null
  case "$url" in
    https://*) [ -n "$(current COMPOSE_FILE)" ] || put COMPOSE_FILE docker-compose.yml:docker-compose.https.yml ;;
  esac
  # Call audio and SIP go straight to this server's public IP (they cannot pass an HTTP proxy).
  case "$(current LIVEKIT_NODE_IP)" in "" | 127.0.0.1) put LIVEKIT_NODE_IP "$ip" ;; esac
  [ -n "$(current LIVEKIT_BIND_IP)" ] || put LIVEKIT_BIND_IP 0.0.0.0
  put LIVEKIT_SIP_USE_EXTERNAL_IP true
  [ -n "$(current LIVEKIT_SIP_ENDPOINT)" ] || put LIVEKIT_SIP_ENDPOINT "$ip"
  # One core: the voice services share core 0 (the default pins them to the second core).
  [ "$(nproc)" -gt 1 ] || [ -n "$(current LINEDESK_VOICE_CPUSET)" ] || put LINEDESK_VOICE_CPUSET 0
  chmod 600 .env
  printf 'Address: %s\nCall audio and SIP: %s\n' "$url" "$ip"

  # 3. Build and start.
  say "Building and starting Linedesk (about 10 minutes on a small server)"
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ) # only a setup code printed from now on is shown (an install without admins prints it at every start)
  docker compose up -d --build --quiet-pull 2>&1 | grep -Ev '^ *(#|=>)|Pulling|Pulled|Waiting|Downloading|Extracting' || true
  docker compose ps --status running --services 2>/dev/null | grep -qx api ||
    fail "the stack did not start. See: cd $dir && docker compose ps && docker compose logs api"

  say "Waiting for Linedesk to answer"
  code=''
  i=0
  while [ $i -lt 90 ]; do
    code=$(docker compose logs --no-log-prefix --since "$started" api 2>/dev/null |
      sed -n '/enter this setup code/{n;n;p;}' | tail -n 1 | tr -d ' ')
    [ -n "$code" ] && break
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q api)" 2>/dev/null)" = healthy ] &&
      [ $i -gt 10 ] && break
    i=$((i + 1))
    sleep 2
  done

  {
    echo "Linedesk on this server"
    echo "  Open:        $url"
    if [ -n "$code" ]; then
      echo "  Setup code:  $code   (works once, for 7 days; again: docker compose exec api node apps/api/src/setup-code.ts)"
    else
      echo "  No setup code: the API already has an admin, or has not started yet. Sign in, or see: docker compose logs api"
    fi
    echo
    echo "If your provider has a firewall (AWS Lightsail has one by default), allow these ports:"
    echo "  80 and 443 tcp (web), 7881 tcp and 7882 udp (call audio), 5060 tcp (SIP), 10000-10100 udp (SIP audio)"
    echo
    echo "Next: open the address, enter the setup code, and set up the rest with your AI agent or by hand."
    echo "Files: $dir   Update: cd $dir && scripts/update.sh"
  } | tee "$summary"
  chmod 600 "$summary"
}

main "$@" </dev/null
