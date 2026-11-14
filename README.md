# Linedesk

The open-source AI receptionist for businesses. It answers every call, books the appointment and hands over to a person when needed, and you own the code and the data.

Status: in development, before the first public release. Phone and calendar first, US first.

## What's here

| Path | What it is |
| --- | --- |
| [`apps/api`](apps/api) | API server (Hono): sign-in, the action registry (the one write path), read sync, MCP |
| [`apps/web`](apps/web) | The inbox: a local-first, keyboard-first web app (installable) |
| [`apps/agent`](apps/agent) | The voice assistant (LiveKit Agents) and a call simulator |
| [`packages/`](packages) | Database schema, actions, sync, telephony and calendar adapters |
| [`prototypes/inbox-html/`](prototypes/inbox-html) | The reference design as a single-file clickable prototype. Run: `cd prototypes/inbox-html && python3 -m http.server 4173` |
| [`docs/`](docs) | Architecture, stack, plan, decisions, research, design principles |

Demo data is fictional (Brightwater Plumbing & Heating, Portland; assistant "Maya").

## Development quickstart

Requirements: Node 22.18 or newer (it runs the TypeScript files directly), pnpm 10, Docker.

```sh
pnpm install
scripts/setup.sh                                # makes .env with a random value for every secret, SECRETS_KEY included
pnpm db:up && pnpm db:migrate && pnpm db:seed   # Postgres + Electric; the seed prints the demo sign-in
pnpm dev                                        # API on 3100, web app on http://localhost:5173
pnpm --filter @linedesk/agent simulate          # a simulated call lands in the inbox, no provider keys needed
```

Use `scripts/setup.sh`, not a plain `cp .env.example .env`: the copy leaves `SECRETS_KEY` empty, and then nothing can be connected under Admin › Providers (or set it yourself: `openssl rand -base64 32`).

The demo sign-in uses a password. Without the seed, the API prints a setup code to its log (the terminal running `pnpm dev`); the sign-in page asks for it and makes you the first admin. Email codes go nowhere until email is connected (Admin › Providers); for local development uncomment `EMAIL_TO_LOG=true` in `.env` to print them to the API log. Sign-up is closed by default (`AUTH_SIGNUP_ENABLED=true` opens it).

The simulator dials the install's only Linedesk number (the seed's demo number). With none or several, pass the number: `pnpm --filter @linedesk/agent simulate --to +1…` (or set `SIM_TO_NUMBER` in `.env`). Simulated calls show in the inbox like real ones but never count as a real call in setup progress or usage.

Your own test data in every local stack and worktree: `pnpm db:seed -- --user <your email>` once, then `pnpm dev:snapshot`; a new local database starts from that snapshot. More in [CONTRIBUTING.md](CONTRIBUTING.md).

## Self-hosting

One command starts the whole application in its own Docker project (`linedesk`): Postgres, Electric (read sync), the API, LiveKit with its SIP bridge and Valkey (calls), the voice agent, the web app's files, and Caddy, the single web entry point in front of the web app, the API and LiveKit signalling.

On a new server (Ubuntu or Debian), one command installs everything: Docker, the code, the settings with random secrets, HTTPS, and the server's public IP for calls. It ends with the address and the setup code. Where to get a server, which size and which ports: [docs/hosting.md](docs/hosting.md).

```sh
curl -fsSL https://raw.githubusercontent.com/linedesk/linedesk/main/scripts/install.sh | sudo sh
```

Real phone calls need a server with a public IP (carriers send calls and their audio over UDP). On your own computer everything else works, including test calls in the browser.

By hand, on any machine: Docker with Compose v2.24 or newer and about 1.5 GB of free RAM. Everything stays inside the install folder and Docker: data in named volumes, no files written elsewhere, no host networking.

```sh
git clone https://github.com/linedesk/linedesk.git && cd linedesk
scripts/setup.sh                 # makes .env with a random value for every secret; or: scripts/setup.sh https://desk.example.com
docker compose up -d --build
docker compose logs api | grep -A3 "setup code"
```

Then open `PUBLIC_URL` (default `http://localhost`) and enter the setup code from the log: you create the first account, which is the instance admin. Everything else is connected in the app, under Admin, Providers: the phone carrier (Telnyx or Twilio), speech, language model and voice (Deepgram, OpenRouter or OpenAI, ElevenLabs or Cartesia), email (any SMTP service), sign-in with Google, Microsoft, GitHub or your own OIDC provider (Google and Microsoft also connect calendars), and where call recordings go. Keys are stored encrypted with `SECRETS_KEY`; each one has a "Test connection". Push notifications need nothing: the first start makes their keys.

Admin, Overview starts with a setup checklist: each part a first answered call needs, with the steps for the recommended provider, a rough cost and a Test; `scripts/setup.sh --check` prints the same list in the terminal.

For scripted installs and AI agents: the same steps, non-interactive. `scripts/setup.sh` is safe to run again (it keeps every value that is set). Provider keys can also go into `.env` under the variable names in `packages/actions/src/admin.ts`; a value connected in the app wins. `docker compose exec api node apps/api/src/providers-import.ts` moves such variables into the app.

Sign-up is closed by default (`AUTH_SIGNUP_ENABLED=false`), so strangers who reach the URL cannot create accounts or workspaces; only people you invite get in (Invite user in the admin area, or `docker compose exec api node apps/api/src/user-create.ts --email ann@example.com --name "Ann Lee"`). Set `AUTH_SIGNUP_ENABLED=true` only if anyone may create an account and their own workspace (they cannot see yours, but they use your phone carrier and provider keys).

The API applies database migrations on every start. Sign-in by email works with a 6-digit code (no links) once email is connected. `EMAIL_TO_LOG=true` (commented out in `.env.example`) prints the codes to the API log instead; it is for local development only, since anyone who can read the log can sign in as anyone.

### Three ways to put it on the web

| | In `.env` |
| --- | --- |
| Plain HTTP (trying it out) | Nothing: Caddy listens on port 80, `PUBLIC_URL=http://localhost`. Another port: `LINEDESK_HTTP_BIND=8080` and `PUBLIC_URL=http://localhost:8080`. |
| Behind a reverse proxy you already run | `LINEDESK_HTTP_BIND=127.0.0.1:8480` and `PUBLIC_URL=https://front.example.com`. Caddy then listens only on that local address, without certificates; your proxy terminates TLS and forwards everything. |
| HTTPS by Linedesk's own Caddy | `COMPOSE_FILE=docker-compose.yml:docker-compose.https.yml` and `PUBLIC_URL=https://front.example.com`. Caddy listens on 80 and 443 and gets the certificate itself; DNS must point at the machine. |
| Behind Cloudflare's proxy (orange cloud) | `COMPOSE_FILE=docker-compose.yml:docker-compose.https.yml:docker-compose.cloudflare.yml`, a Cloudflare Origin CA certificate for the host in `LINEDESK_ORIGIN_CERT_DIR` (`origin.pem`, and `origin.key` with mode 600, owned by uid 1000) and SSL mode "Full (strict)" in Cloudflare. Caddy then trusts only Cloudflare's addresses and takes the visitor from `CF-Connecting-IP` (ignored from anyone else), so rate limits and logs see the visitor. Calls do not go through Cloudflare: `LIVEKIT_SIP_ENDPOINT` must be a DNS-only (grey cloud) name for the same machine, and the call audio ports stay direct. Cloudflare needs WebSockets on (LiveKit signalling); cache nothing but `/assets/*`. Optionally allow 80 and 443 only from [Cloudflare's ranges](https://www.cloudflare.com/ips/) (in `DOCKER-USER`, like the SIP rules below). With IPv6 on the host, Docker also publishes 80 and 443 on IPv6 through its own proxy process (`docker-proxy`): those connections pass the host's `INPUT` chain (ufw), never `DOCKER-USER`, so allow 80 and 443 there only from Cloudflare's IPv6 ranges too. Check from another machine that the origin answers neither address: `curl -6 --resolve <host>:443:[<server IPv6>] https://<host>/healthz` (and `-4` with the IPv4 address) must time out. |

For the reverse proxy case, this is all the outer proxy needs (Caddy shown; WebSockets for LiveKit signalling under `/rtc` and the long-lived sync responses pass through as they are):

```
front.example.com {
	reverse_proxy 127.0.0.1:8480 {
		# Holds requests for the few seconds Linedesk's Caddy itself restarts (rare; see Update below).
		lb_try_duration 30s
	}
}
```

`PUBLIC_URL` must be exactly the address people open: sign-in only works on it.

### Deploy methods

Docker Compose, as above, is the supported way: one file for the whole stack, `scripts/deploy.sh` for updates. On a platform that builds one service at a time from a Dockerfile instead (Railway, Render, Fly.io, Dokku, Coolify or Dokploy without compose), build each service from the repository root with its target:

| Service | Target | Notes |
| --- | --- | --- |
| API | `api` (also the default when the platform cannot pick a target) | Checks its secrets and applies migrations on start (`docker/api-entrypoint.sh`). Needs the settings below plus `DATABASE_URL`, `ELECTRIC_URL`, `WEB_ORIGIN` and `BETTER_AUTH_URL` (both `PUBLIC_URL`), which compose otherwise sets. |
| Proxy | `proxy` | Required, and the only public service. The web app calls `/api`, `/v1` and `/mcp` on its own address, so it only works behind this Caddy; it also sets the security headers and keeps the agent's endpoints off the public site. Tell it where the others are: `API_HOST`, `WEB_HOST`, `LIVEKIT_UPSTREAM` (defaults: the compose service names). |
| Web | `web` | The built web app's files, reached only through the proxy. |
| Agent | `agent` | Reaches the API through the proxy's internal port: `LINEDESK_API_URL=http://<proxy>:3100`. Never publish that port: the API refuses the agent's token on any other way in. |

Postgres (with `wal_level=logical`, which Electric needs), Electric, LiveKit with its SIP bridge, and Valkey come from their images in `docker-compose.yml` or as managed services. Call audio and SIP need public UDP ports (see Ports), which most hosted platforms do not offer; there, use LiveKit Cloud for voice. Nixpacks, Railpack and Heroku buildpacks are not supported: every platform that uses them also builds a Dockerfile.

### Settings

| Variable | What it does |
| --- | --- |
| `BETTER_AUTH_SECRET` | Signs sessions. Required (`scripts/setup.sh` makes it); the API refuses to start with the placeholder. |
| `POSTGRES_PASSWORD` | Database password. Required; set before the first start (`scripts/setup.sh` does, letters and digits only). Changing it later does not change the password of an existing database. |
| `SECRETS_KEY` | Encrypts the keys connected in Admin, Providers (`scripts/setup.sh` makes it). Keep it: without the same key they cannot be read. |
| `PUBLIC_URL`, `LINEDESK_HTTP_BIND`, `COMPOSE_FILE` | See the table above. |
| `AUTH_SIGNUP_ENABLED` (default `false`) | `false` keeps sign-up closed (see above): an instance admin creates accounts with Invite user or `pnpm --filter @linedesk/api user:create --email … --name … [--admin]`. While sign-up is closed, workspace owners can still invite people into their own workspace. |
| `LINEDESK_TRUSTED_PROXY_RANGES` (default empty) | Behind your own reverse proxy: the addresses or ranges it connects to Caddy from (space-separated; a proxy on the same host comes from the Docker gateway, e.g. `172.16.0.0/12`). Caddy then keeps the client address the proxy forwards; without it every client looks like the proxy and shares one rate-limit bucket. |
| `TRUSTED_PROXIES` | Addresses or ranges of the proxies in front of the API, for rate limits. Compose sets Docker's private ranges (only Caddy and the agent reach the API); change it only if you publish the API port yourself. |
| `AGENT_API_TOKEN` | Token the voice agent uses to call the API, at least 32 characters (`openssl rand -hex 24`); the API refuses to start with a shorter one. While it is empty or the placeholder, agent access is off and the agent idles. It only works inside the install's network, never through the public site. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Required. Shared by LiveKit, the SIP bridge and the agent. The API and the agent refuse the development values from `.env.example`. |
| `LIVEKIT_NODE_IP` | The machine's public IP: the address callers and browsers send audio to. |
| `LIVEKIT_BIND_IP` | Set to `0.0.0.0` on a server. Without it the call audio and SIP ports are only published on 127.0.0.1. |
| Phone, speech, language model, voice, email, sign-in, recordings | Connected in the app under Admin, Providers. Until speech, language model and voice are, the agent says so in its log (`docker compose logs agent`) and calls are logged as missed. Without `AGENT_API_TOKEN` or the LiveKit settings it waits idle. |
| `LIVEKIT_SIP_ENDPOINT` | Real phone numbers through the carrier connected in Admin, Providers (Telnyx or Twilio): where it sends calls; see `.env.example`. |
| `LIVEKIT_SIP_ALLOWED_ADDRESSES` (default `telnyx twilio`) | Where LiveKit SIP takes calls from: carrier names (their published signaling addresses) and/or your own IPs and CIDR ranges, e.g. `telnyx 203.0.113.7` for a PBX of your own. `any` accepts calls from every address. Applied by `setup-sip`, so run it again after a change. |

The API container reads the rest of `.env` as is; only the addresses inside the stack are set by compose. The agent container does not read `.env`: it gets only the variables listed under `agent` in `docker-compose.yml` (its token, LiveKit, the speech, model and voice settings, the call test's numbers), so `SECRETS_KEY`, `BETTER_AUTH_SECRET`, the database password and carrier keys never reach the process that handles calls. A variable the agent should read must be added there; one-off agent commands that need carrier keys (`setup-test-caller`) get them on the command line (`docker compose run --rm -e TELNYX_API_KEY=<key> agent ...`).

### Ports

Published on the host, and nothing else (Postgres, Electric, Valkey, the API and LiveKit's HTTP port are only reachable inside the Docker network):

| Port | For | Open in the firewall |
| --- | --- | --- |
| `LINEDESK_HTTP_BIND` (default 80; 443 too with the HTTPS file) | Web app, API and LiveKit signalling, through Caddy | Yes, unless a reverse proxy in front does it |
| 7881 (tcp), 7882 (udp) | Call audio (WebRTC) | Yes |
| 5060 (udp and tcp) | SIP from the carrier | Yes |
| 10000-10100 (udp) | SIP audio (RTP) | Yes |

Call audio and SIP cannot go through an HTTP proxy, which is why they are published directly.

Firewall: ports that Docker publishes on `0.0.0.0` bypass `ufw` (Docker writes its own iptables rules), so `ufw deny` does not close them. Keep `LIVEKIT_BIND_IP` and `LINEDESK_HTTP_BIND` as narrow as you need, and open the call ports with your provider's firewall (or ufw's `ufw-docker` rules) if you filter there. After the first start, tell LiveKit which numbers to accept:

```sh
docker compose run --rm agent node src/setup-sip.ts +15035550142   # your numbers
```

LiveKit then only takes calls from the carriers' signaling addresses (`LIVEKIT_SIP_ALLOWED_ADDRESSES`); a SIP request from anywhere else gets 404 and never reaches the assistant. Check it after the first real call: `docker compose logs livekit-sip | grep fromIP` shows the carrier's address on `processing invite`, and a refused call shows "Rejecting inbound call, doesn't match any Dispatch Rules" with the sender's address. If a carrier's real call is refused there, its address is missing from `packages/telephony/src/signaling-addresses.ts` (or from your variable).

Optionally close 5060 in the firewall as well, so SIP scanners do not even reach LiveKit (the RTP ports stay open: carriers send audio from other ranges). The list to allow, one address per line:

```sh
docker compose run --rm agent node src/setup-sip.ts --print-allowed-addresses > sip-allow.txt
```

With your provider's firewall (e.g. a Hetzner Cloud Firewall), allow 5060 udp and tcp from these sources only. With iptables on the host, use the `DOCKER-USER` chain (Docker's published ports skip ufw's rules); the packets there already have the container's address, so match the original port. Each `-I` goes on top, so the drops come first:

```sh
for proto in udp tcp; do
  iptables -I DOCKER-USER -p $proto -m conntrack --ctorigdstport 5060 --ctdir ORIGINAL -j DROP
  while read -r addr; do
    iptables -I DOCKER-USER -p $proto -s "$addr" -m conntrack --ctorigdstport 5060 --ctdir ORIGINAL -j RETURN
  done < sip-allow.txt
done
```

These rules are not saved across reboots (use `iptables-persistent` or your own unit), and they need the same update as the variable when the list changes.

### Memory and CPU

Every service has a hard memory limit, a CPU limit, a restart policy and rotated logs (3 files of 10 MB), so the stack cannot take more than its share of a machine it does not own. In all: 1.5 GB of memory and at most 1.5 CPUs.

CPU is split in two. The call-audio services (LiveKit, the SIP bridge, the agent and egress) share one pinned core, `LINEDESK_VOICE_CPUSET` (default: core `1`, the second core; set `0` on a machine with one core). A CPU quota made the agent stall audio even when idle, a pinned core does not. The other services have quotas that add up to half a core.

| Service | Memory limit | CPU | Measured at rest |
| --- | --- | --- | --- |
| agent | 672 MB | voice core | 480 to 495 MB (registered with LiveKit, one process kept warm) |
| electric | 320 MB | 0.2 | 230 MB |
| postgres | 128 MB | 0.1 | 45 to 55 MB |
| api | 128 MB | 0.1 | 65 to 70 MB |
| livekit | 96 MB | voice core | 16 to 60 MB |
| livekit-sip | 96 MB | voice core | 16 to 50 MB |
| redis (Valkey) | 48 MB | 0.05 | 13 to 22 MB |
| web (Caddy) | 48 MB | 0.05 | 14 to 22 MB |

Whole stack at rest: 880 MB to 1 GB, measured on three runs. Each call in progress adds memory in the agent, so the default is sized for one or two calls at a time; raise `LINEDESK_AGENT_MEM` for more. Every memory limit has a variable `LINEDESK_<SERVICE>_MEM`, every quota `LINEDESK_<SERVICE>_CPUS` (`POSTGRES`, `ELECTRIC`, `API`, `WEB`, `REDIS`, `LIVEKIT`, `SIP`, `AGENT`, `EGRESS`).

### Push notifications

Members can get a push for new calls (urgent ones first) on their phone or computer, even when Linedesk is closed: Settings, Notifications, "Push notifications on this device". Nothing to set up: the first start makes the install's key pair (VAPID) and stores it, the private key encrypted with `SECRETS_KEY`. `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in `.env` still win (an install that made its own pair before keeps it; `providers-import.ts` moves it into the app).

- Push needs HTTPS (or `localhost` for development). Chrome, Edge and Firefox work on desktop and Android. On iPhone and iPad (iOS 16.4+) people first add Linedesk to the Home Screen from Safari (Share, Add to Home Screen) and turn push on in the installed app.
- What a push contains: who called (contact name or number) and, only for members who turn on "Say what the call was about", one line (the call's topic). Never the transcript or the summary. The payload is encrypted for the browser; the browser's push service (Google, Apple, Mozilla) only delivers it.
- Subscriptions are stored per member and workspace and removed on sign-out, when a member leaves or is removed, when an account is disabled, and when the push service reports them gone. The service worker caches only the app shell (no API, sync or recording responses).

### Call recordings (optional)

Pick where recordings go under Admin, Providers, Recording storage: Local disk (add `--profile recording` to the compose commands) or an S3-compatible bucket. LiveKit egress then writes recordings into the `recordings` volume, which the API reads. Egress comes on top of the memory above (up to 512 MB) and runs on the voice core.

### Update and backup

Update without downtime and without dropping calls:

```sh
git pull && scripts/deploy.sh
```

It builds the new images while the running version keeps serving, then replaces only the services whose image or settings changed, each new container started next to the old one: the API and the web app switch over once the new container is healthy (Caddy retries requests on the other container meanwhile); the new voice agent registers with LiveKit before the old one stops, and the old one takes no new calls and finishes the ones it has in the background (up to 2 hours, the longest a call lasts; `LINEDESK_AGENT_DRAIN`, 130 minutes), so the update does not wait for it. The services every call runs through (LiveKit, LiveKit SIP, egress, Redis, Postgres) change only with a new version or new settings; then the script waits for a moment without live calls before it recreates them (up to `LINEDESK_DEPLOY_QUIET_WAIT` seconds, 1800; after that they stay on the old version until the next deploy, and the script exits with 75 so the deploy shows as failed; `LINEDESK_DEPLOY_DROP_CALLS=1` updates them at once and cuts off the calls in progress, which a security release for them may need). The new API applies the database migrations when it starts. A change to Caddy's own compose settings (ports, environment) recreates Caddy, which interrupts the site for a few seconds; the script says when. `docker compose up -d --build` also works, but restarts everything at once (the site is down until the API is up again; calls in progress are cut off). Data lives in the volumes `pgdata` (database), `recordings` (call recordings) and `caddy_data` (certificates). Back up before updating:

```sh
docker compose exec -T postgres pg_dump -U linedesk -Fc linedesk > linedesk.dump
docker compose run --rm --no-deps -T --entrypoint tar api czf - -C /recordings . > recordings.tgz
```

Restore (replaces the current data): the database goes into a fresh database, followed by a fresh Electric.

```sh
docker compose stop api electric
docker compose exec -T postgres psql -U linedesk -d postgres \
  -c "select pg_drop_replication_slot(slot_name) from pg_replication_slots" \
  -c "drop database linedesk" -c "create database linedesk"
docker compose exec -T postgres pg_restore -U linedesk -d linedesk < linedesk.dump
docker compose up -d --force-recreate electric api
docker compose --profile recording run --rm --no-deps -T --user 1001:0 --entrypoint tar livekit-egress xzf - -C /recordings < recordings.tgz
```

### Backups

`scripts/backup.sh` makes an offsite backup of the database: a `pg_dump`, checked with `pg_restore --list`
and uploaded to an S3-compatible bucket (R2, S3, B2, …). Backups older than `BACKUP_KEEP_DAYS` (30) are
deleted there. Recordings stored in a bucket (`RECORDING_STORE=s3`) are offsite already; recordings on local
disk are not part of this backup.

Optionally encrypted with [age](https://age-encryption.org): with `BACKUP_AGE_RECIPIENT` set, only the public key
is on the server, so neither the server nor anyone holding the bucket's keys can read a backup, and without the
private key nobody can restore one. Without it, a backup is as safe as the bucket's access keys.

```sh
age-keygen -o backup-key.txt     # only to encrypt: on your computer; keep backup-key.txt safe, off the server
```

Then in `backup.env` next to `.env` (not in `.env`: the API container reads all of `.env`, and the bucket key
can delete every backup), readable by its owner only (`chmod 600 backup.env`): `BACKUP_S3_ENDPOINT`,
`BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` (a key for that bucket only),
`BACKUP_S3_PREFIX` (default `linedesk/`), optionally `BACKUP_AGE_RECIPIENT` (the `age1…` public key that
`age-keygen` printed) and `BACKUP_KEEP_DAYS` (default 30). A deploy (`scripts/receive-deploy.sh`, in production `scripts/receive-release.sh`) keeps the file like
`.env`. Run `scripts/backup.sh` once, then every night with a systemd timer:

```ini
# /etc/systemd/system/linedesk-backup.service
[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/opt/linedesk/app
ExecStart=/opt/linedesk/app/scripts/backup.sh

# /etc/systemd/system/linedesk-backup.timer
[Timer]
OnCalendar=*-*-* 09:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
```

`systemctl enable --now linedesk-backup.timer`. `scripts/backup.sh --list` lists the backups. To prove a
backup restores, without touching the running stack: `scripts/restore-backup.sh` downloads the newest backup,
restores it into a throwaway Postgres and prints its row counts next to the live ones. An encrypted backup also
needs the private key for this one check (`BACKUP_AGE_IDENTITY=backup-key.txt`; delete it from the server
afterwards with `shred -u backup-key.txt`).

A real restore: download a backup (decrypt an encrypted one on your computer:
`age -d -i backup-key.txt -o linedesk.dump linedesk-<time>.dump.age`), copy it to the server and follow
"Restore" above.

## Docs

- [docs/hosting.md](docs/hosting.md): putting Linedesk on a server (providers, one-command install, ports)
- [docs/architecture.md](docs/architecture.md): how Linedesk works (single source of truth)
- [docs/stack.md](docs/stack.md): why this stack: research, spikes, costs per minute
- [docs/plan.md](docs/plan.md): principles, open-source readiness, workstreams
- [docs/decisions.md](docs/decisions.md): decisions log
- [docs/research.md](docs/research.md): what an AI front desk must do well
- [docs/design-principles.md](docs/design-principles.md): UI rules

Working on the code: read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md) first. Security reports: [SECURITY.md](SECURITY.md).
