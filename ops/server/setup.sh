#!/bin/sh
# Sets up the server around a Linedesk install (as root, from the checkout in /opt/linedesk/app): email alerts, disk and
# memory checks, the nightly backup with its freshness check and weekly restore test, SIP only from carriers, and on
# request the web ports only from Cloudflare, SSH hardening, ufw and uptime checks of another install. Everything it
# installs is in ops/server/ (README there). Run it again after an update: it is idempotent and keeps /etc/linedesk/ops.env.
#
#   sudo ops/server/setup.sh --alert-to ops@example.com --label prod   # several: --alert-to a@example.com,b@example.com
#   sudo ops/server/setup.sh --dry-run                       # what would change, nothing is touched
#   options: --cloudflare        web ports 80/443 only from Cloudflare (an install behind its proxy)
#            --harden-ssh        keys only, no root login, 3 tries (needs a sudo user with an SSH key)
#            --ufw               ufw on: only SSH reaches host services (Docker's published ports are not affected)
#            --monitor <host> [--monitor-sip <host>]   check another install every 2 minutes from this server
#            --push-url <https URL>   with --monitor (or on a voice server): also a phone push (ntfy topic URL) when a check goes down or up
#            --capacity-push <user@host>   send the capacity samples (linedesk-capacity) there over SSH every 5 minutes
# A server with a voice link (the app server with docker-compose.voice-link.yml, voice server 1 with
# docker-compose.voice-media.yml) also gets the voice-link firewall (only the addresses in /etc/linedesk/voice-nodes.txt);
# a voice server (an agent and no API) the agent check.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app_dir=${LINEDESK_APP_DIR:-$(cd "$here/../.." && pwd)}
dry=0 cloudflare=0 harden_ssh=0 ufw=0 alert_to='' label='' monitor='' monitor_sip='' push_url='' capacity_push=''
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) dry=1 ;;
    --cloudflare) cloudflare=1 ;;
    --harden-ssh) harden_ssh=1 ;;
    --ufw) ufw=1 ;;
    --alert-to) alert_to=${2:?--alert-to needs an address}; shift ;;
    --label) label=${2:?--label needs a name}; shift ;;
    --monitor) monitor=${2:?--monitor needs a host}; shift ;;
    --monitor-sip) monitor_sip=${2:?--monitor-sip needs a host}; shift ;;
    --push-url) push_url=${2:?--push-url needs a URL}; shift ;;
    --capacity-push) capacity_push=${2:?--capacity-push needs user@host}; shift ;;
    *) sed -n '2,16p' "$0" >&2; exit 2 ;;
  esac
  shift
done
[ "$(id -u)" = 0 ] || [ "$dry" = 1 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ -f "$app_dir/.env" ] || { echo "no $app_dir/.env: install Linedesk first (scripts/install.sh)" >&2; exit 1; }
user=$(stat -c %U "$app_dir/.env")
# The alerts are mailed with SMTP_URL and EMAIL_FROM from the app's .env. Email connected in Server admin › Providers
# does not count: it is stored encrypted in the database, which the alert script cannot read.
for name in SMTP_URL EMAIL_FROM; do
  [ -n "$(sed -n "s/^$name=//p" "$app_dir/.env" | tail -1)" ] ||
    echo "WARNING: $name is empty in $app_dir/.env: alerts cannot be sent. Set SMTP_URL and EMAIL_FROM there, also when email is connected in Server admin." >&2
done

changed=0
say() { echo "$*"; }
run() { if [ "$dry" = 1 ]; then say "  would run: $*"; else "$@"; fi; }
# put <file> <target> <mode>: installs the file when it differs, shows the difference.
put() {
  if [ -f "$2" ] && cmp -s "$1" "$2" && [ "$(stat -c %a "$2")" = "$3" ]; then return 0; fi
  changed=1
  say "${2}: $([ -f "$2" ] && echo changed || echo new)"
  [ -f "$2" ] && diff -u "$2" "$1" | sed '1,2d; s/^/  /' | head -40 || true
  [ "$dry" = 1 ] || install -D -m "$3" "$1" "$2"
}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# Settings for the scripts (no secrets: SMTP comes from the app's .env). Values set before are kept.
ops_env=/etc/linedesk/ops.env
current() { sed -n "s/^$1=//p" "$ops_env" 2>/dev/null | tail -1; }
alert_to=${alert_to:-$(current LINEDESK_ALERT_TO)}
[ -n "$alert_to" ] || { echo "who gets the alerts? --alert-to <email address>" >&2; exit 1; }
label=${label:-$(current LINEDESK_ALERT_LABEL)}
monitor=${monitor:-$(current LINEDESK_MONITOR_HOST)}
monitor_sip=${monitor_sip:-$(current LINEDESK_MONITOR_SIP_HOST)}
push_url=${push_url:-$(current LINEDESK_PUSH_URL)}
capacity_push=${capacity_push:-$(current LINEDESK_CAPACITY_PUSH)}
label=${label:-$(hostname)}
# ops.env is sourced by scripts that run as root: only plain values go in.
valid() { printf '%s\n' "$2" | grep -Eq "$3" || { echo "not a valid $1: $2" >&2; exit 1; }; }
valid "email address (or several, separated by commas)" "$alert_to" '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(,[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})*$'
valid label "$label" '^[A-Za-z0-9._-]+$'
valid "app folder" "$app_dir" '^/[A-Za-z0-9._/-]+$'
[ -z "$monitor" ] || valid "host name" "$monitor" '^[A-Za-z0-9.-]+$'
[ -z "$monitor_sip" ] || valid "host name" "$monitor_sip" '^[A-Za-z0-9.-]+$'
[ -z "$push_url" ] || valid "push URL" "$push_url" '^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._/-]+$'
[ -z "$capacity_push" ] || valid "user@host" "$capacity_push" '^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$'
{
  echo "# Settings for the scripts from ops/server (setup.sh writes this file; edit it and run setup.sh again)."
  echo "LINEDESK_APP_DIR=$app_dir"
  echo "LINEDESK_ALERT_TO=$alert_to"
  echo "LINEDESK_ALERT_LABEL=$label"
  [ -z "$monitor" ] || echo "LINEDESK_MONITOR_HOST=$monitor"
  [ -z "$monitor_sip" ] || echo "LINEDESK_MONITOR_SIP_HOST=$monitor_sip"
  [ -z "$push_url" ] || echo "LINEDESK_PUSH_URL=$push_url"
  [ -z "$capacity_push" ] || echo "LINEDESK_CAPACITY_PUSH=$capacity_push"
} > "$tmp/ops.env"
put "$tmp/ops.env" "$ops_env" 644

for f in "$here"/bin/*; do put "$f" "/usr/local/sbin/$(basename "$f")" 755; done
# Once, from a hand-made install: addresses its allow list had beyond the carriers' (an uptime check, say) move to
# this server's own list. Later runs leave the local list alone, so a carrier address dropped from the repo is gone.
if [ -f /etc/linedesk/sip-allow.txt ] && [ ! -e /etc/linedesk/sip-allow.local.txt ]; then
  sed 's/#.*//; /^[[:space:]]*$/d' /etc/linedesk/sip-allow.txt | sort -u > "$tmp/sip-old"
  sed 's/#.*//; /^[[:space:]]*$/d' "$here/etc/sip-allow.txt" | sort -u > "$tmp/sip-new"
  comm -23 "$tmp/sip-old" "$tmp/sip-new" > "$tmp/sip-extra"
  if [ -s "$tmp/sip-extra" ]; then
    { echo "# This server's own addresses that may send SIP, besides the carriers in sip-allow.txt (linedesk-sip-firewall)."; cat "$tmp/sip-extra"; } > "$tmp/sip-allow.local.txt"
    put "$tmp/sip-allow.local.txt" /etc/linedesk/sip-allow.local.txt 644
  fi
fi
put "$here/etc/sip-allow.txt" /etc/linedesk/sip-allow.txt 644

for f in "$here"/systemd/*; do
  name=$(basename "$f")
  sed -e "s|@USER@|$user|g" -e "s|@APP_DIR@|$app_dir|g" "$f" > "$tmp/$name"
  put "$tmp/$name" "/etc/systemd/system/$name" 644
done
# Older hand-made installs kept the backup's alert in a drop-in; the unit has it now.
if [ -e /etc/systemd/system/linedesk-backup.service.d/alert.conf ]; then
  changed=1; say "/etc/systemd/system/linedesk-backup.service.d/alert.conf: removed (in the unit now)"
  run rm -f /etc/systemd/system/linedesk-backup.service.d/alert.conf
  run rmdir --ignore-fail-on-non-empty /etc/systemd/system/linedesk-backup.service.d
fi

# What runs: always the alerts, disk and memory and the SIP firewall; the backups once backup.env is set up.
units='linedesk-resources.timer linedesk-capacity.timer linedesk-sip-firewall.service'
if [ -f "$app_dir/backup.env" ]; then
  units="$units linedesk-backup.timer linedesk-backup-check.timer linedesk-restore-test.timer"
else
  say "no $app_dir/backup.env: backup timers stay off (docs/self-hosting.md, Backups)"
fi

# WAL archiving runs once the stack uses docker-compose.wal.yml (docs/backups-wal.md) and the bucket is set up.
wal_units='linedesk-wal-archive.timer linedesk-wal-base.timer'
if grep -Eq '^COMPOSE_FILE=.*docker-compose\.wal\.yml' "$app_dir/.env" && [ -f "$app_dir/backup.env" ]; then
  units="$units $wal_units"
  wal_units=''
fi

if [ "$cloudflare" = 1 ] || [ -f /etc/linedesk/cloudflare-v4.txt ]; then
  for v in 4 6; do
    # Only a plausible list replaces the one in place: every line a range, at least a few of them (Cloudflare has 15
    # IPv4 and 7 IPv6), and not much shorter than before. An error or challenge page never reaches the firewall.
    curl -fsS -m 20 "https://www.cloudflare.com/ips-v$v" | tr -d '\r' | grep -v '^[[:space:]]*$' > "$tmp/cloudflare-v$v.txt" || true
    count=$(wc -l < "$tmp/cloudflare-v$v.txt")
    old=$(grep -c . "/etc/linedesk/cloudflare-v$v.txt" 2>/dev/null || echo 0)
    min=$([ "$v" = 4 ] && echo 10 || echo 5)
    if grep -vEq '^[0-9a-fA-F.:]+/[0-9]{1,3}$' "$tmp/cloudflare-v$v.txt" || [ "$count" -lt "$min" ] || [ "$count" -lt $((old / 2)) ]; then
      echo "Cloudflare's IPv$v list looks wrong ($count lines); the one in place stays" >&2
      exit 1
    fi
    put "$tmp/cloudflare-v$v.txt" "/etc/linedesk/cloudflare-v$v.txt" 644
  done
  units="$units linedesk-web-firewall.service"
fi
[ -z "$monitor" ] || units="$units linedesk-monitor.timer"

# Separate voice servers (docs/hosting.md, "Separate voice servers"), as compose resolves COMPOSE_FILE (quotes, ./,
# the environment): an invalid setup stops here rather than skip the firewall. A server with a voice link (the app
# server, voice server 1): the link only from the servers listed in voice-nodes.txt (a new list starts empty, which
# lets none in), and started again once WireGuard is up. A voice server (an agent, no API): an alert when its worker
# takes no calls.
compose_services=$(cd "$app_dir" && docker compose config --services) ||
  { echo "docker compose config fails in $app_dir: fix the compose setup (.env) first" >&2; exit 1; }
voice_link_unit='' voice_link_wg=''
if printf '%s\n' "$compose_services" | grep -qx voice-link; then
  if [ ! -f /etc/linedesk/voice-nodes.txt ]; then
    printf '%s\n' "# The other servers' WireGuard addresses, one per line: only they reach this server's voice link (linedesk-voice-link-firewall)." > "$tmp/voice-nodes.txt"
    put "$tmp/voice-nodes.txt" /etc/linedesk/voice-nodes.txt 644
  fi
  grep -Eq '^[[:space:]]*[0-9]' /etc/linedesk/voice-nodes.txt 2>/dev/null ||
    echo "WARNING: no address in /etc/linedesk/voice-nodes.txt yet: no other server reaches the voice link (and scripts/deploy.sh does not start it) until you add them and run this again." >&2
  voice_link_unit=linedesk-voice-link-firewall.service
  link_ip=$(sed -n 's/^LINEDESK_VOICE_LINK_IP=//p' "$app_dir/.env" | tail -1 | sed "s/^[\"']//; s/[\"']\$//")
  link_dev=$(ip -4 -o addr show | awk -v ip="$link_ip" '{ split($4, a, "/") } a[1] == ip { print $2; exit }')
  if [ -n "$link_dev" ] && ip -d link show dev "$link_dev" | grep -qw wireguard; then
    voice_link_wg="linedesk-voice-link@$link_dev.service"
  else
    echo "WARNING: LINEDESK_VOICE_LINK_IP ($link_ip) is not on a WireGuard interface of this server: scripts/deploy.sh does not start the voice link until it is (docs/hosting.md, step 1)." >&2
  fi
fi
if printf '%s\n' "$compose_services" | grep -qx agent && ! printf '%s\n' "$compose_services" | grep -qx api; then
  units="$units linedesk-agent-check.timer"
fi
# SIP over TLS (docker-compose.sip-tls.yml): LiveKit SIP reads a renewed certificate after a restart at a quiet moment.
if printf '%s\n' "$compose_services" | grep -qx sip-cert; then
  units="$units linedesk-sip-cert.timer"
fi

if [ "$harden_ssh" = 1 ]; then
  # Never lock the last way in: a non-root user with a full SSH key (not a forced-command one like a deploy key) who
  # can use sudo (without a password, or with one set) must exist first.
  ok=''
  for home in /home/*; do
    u=$(basename "$home")
    grep -Ev '^[[:space:]]*(#|$)' "$home/.ssh/authorized_keys" 2>/dev/null | grep -qvE '(^|,)(command=|restrict)' || continue
    if sudo -l -U "$u" 2>/dev/null | grep -q 'NOPASSWD: ALL' ||
      { id -nG "$u" | grep -qwE 'sudo|wheel' && passwd -S "$u" 2>/dev/null | awk '{ exit $2 != "P" }'; }; then
      ok="$ok $u"
    fi
  done
  [ -n "$ok" ] || { echo "--harden-ssh: first add a sudo user with a full SSH key in ~/.ssh/authorized_keys (root login goes off)" >&2; exit 1; }
  # Whoever runs this through sudo must be one of them: they are the one who has to get back in.
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    case " $ok " in *" $SUDO_USER "*) ;; *) echo "--harden-ssh: $SUDO_USER has no full SSH key or no sudo; fix that first (qualify:$ok)" >&2; exit 1 ;; esac
  fi
  say "--harden-ssh: these users keep the way in:$ok"
  put "$here/etc/sshd-hardening.conf" /etc/ssh/sshd_config.d/01-hardening.conf 644
  if [ "$dry" = 0 ]; then
    if ! sshd -t; then
      rm -f /etc/ssh/sshd_config.d/01-hardening.conf
      echo "--harden-ssh: sshd rejects the configuration; the hardening file is removed again, sshd unchanged" >&2
      exit 1
    fi
    systemctl try-reload-or-restart ssh.service 2>/dev/null || systemctl try-reload-or-restart sshd.service
    sshd -T | grep -qx 'permitrootlogin no' && sshd -T | grep -qx 'passwordauthentication no' ||
      { echo "--harden-ssh: sshd does not report the hardening (another file in sshd_config.d wins?)" >&2; exit 1; }
  fi
fi

if [ "$ufw" = 1 ]; then
  command -v ufw >/dev/null || run apt-get install -y ufw
  if ! ufw status 2>/dev/null | grep -q '^Status: active'; then
    changed=1
    ssh_port=$(sshd -T 2>/dev/null | awk '/^port /{ print $2; exit }')
    run ufw allow "${ssh_port:-22}/tcp"
    run ufw default deny incoming
    run ufw --force enable
  fi
fi

# The capacity samples' own key: it can only hand samples to the receiver (a forced command there), nothing else.
capacity_key=/root/.ssh/linedesk_capacity_push
if [ -n "$capacity_push" ] && [ ! -f "$capacity_key" ]; then
  changed=1
  run install -d -m 700 /root/.ssh
  run ssh-keygen -q -t ed25519 -N '' -C "linedesk-capacity@$label" -f "$capacity_key"
fi

if [ "$dry" = 1 ]; then
  say "units that would be on: $units${voice_link_unit:+ $voice_link_unit}${voice_link_wg:+ $voice_link_wg}"
  [ "$changed" = 1 ] || say "nothing to change"
  exit 0
fi
systemctl daemon-reload
# shellcheck disable=SC2086
systemctl enable --now $units >/dev/null
# WAL archiving switched off again: its timers stop too.
# shellcheck disable=SC2086
[ -z "$wal_units" ] || systemctl disable --now $wal_units >/dev/null 2>&1 || true
# A changed firewall script only takes effect when it runs again.
systemctl restart linedesk-sip-firewall.service
case $units in *linedesk-web-firewall*) systemctl restart linedesk-web-firewall.service ;; esac
# The voice-link firewall, also after a change to the list of voice servers. While the list is empty or invalid it shuts
# the link and fails (which sends its alert): a warning only. If the link is not shut either, this stops.
if [ -n "$voice_link_unit" ]; then
  systemctl enable "$voice_link_unit" >/dev/null
  if ! systemctl restart "$voice_link_unit"; then
    if iptables -w -C DOCKER-USER -m conntrack --ctdir ORIGINAL -j LINEDESK-VOICE-LINK 2>/dev/null &&
      iptables -w -S LINEDESK-VOICE-LINK | grep -q -- '--ctorigdstport 3100 -j DROP' &&
      iptables -w -S LINEDESK-VOICE-LINK | grep -q -- '--ctorigdstport 7880 -j DROP'; then
      echo "WARNING: $voice_link_unit failed, the voice link is shut: check /etc/linedesk/voice-nodes.txt and LINEDESK_VOICE_LINK_IP (journalctl -u $voice_link_unit)" >&2
    else
      echo "ERROR: $voice_link_unit failed and the voice link is NOT firewalled. Stop it now (cd $app_dir && docker compose stop voice-link), then see journalctl -u $voice_link_unit" >&2
      exit 1
    fi
  fi
  units="$units $voice_link_unit"
  if [ -n "$voice_link_wg" ]; then
    systemctl enable "$voice_link_wg" >/dev/null
    units="$units $voice_link_wg"
  fi
fi
say "on: $units"
[ -z "$capacity_push" ] || say "capacity samples go to $capacity_push with this key (its line there: restrict,from=\"<this server's address>\",command=\"<receiver> <name>\"): $(cat "$capacity_key.pub")"
say "test the alert email: /usr/local/sbin/linedesk-alert-text 'Test' 'Alerts from $(hostname) work.'"
