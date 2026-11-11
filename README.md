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

Requirements: Node 22, pnpm 10, Docker.

```sh
pnpm install
cp .env.example .env
pnpm db:up && pnpm db:migrate && pnpm db:seed   # Postgres + Electric; the seed prints the demo sign-in
pnpm dev                                        # API on 3100, web app on http://localhost:5173
pnpm --filter @linedesk/agent simulate          # a simulated call lands in the inbox, no provider keys needed
```

More in [CONTRIBUTING.md](CONTRIBUTING.md).

## Self-hosting

One command starts the whole application in its own Docker project (`linedesk`): Postgres, Electric (read sync), the API, LiveKit with its SIP bridge and Valkey (calls), the voice agent, and Caddy, which serves the web app and is the single web entry point.

Requirements: Docker with Compose v2.24 or newer and about 1.5 GB of free RAM. Everything stays inside the install folder and Docker: data in named volumes, no files written elsewhere, no host networking.

```sh
git clone https://github.com/linedesk/linedesk.git && cd linedesk
cp .env.example .env
docker run --rm livekit/livekit-server generate-keys   # prints a LiveKit API key and secret
# in .env set: BETTER_AUTH_SECRET and SECRETS_KEY (each: openssl rand -base64 32), POSTGRES_PASSWORD and
#   AGENT_API_TOKEN (each: openssl rand -hex 24), LIVEKIT_API_KEY and LIVEKIT_API_SECRET (from the line above), PUBLIC_URL
docker compose up -d --build
```

Then open `PUBLIC_URL` and create your account: the first account is the instance admin, who sets up the speech, language and voice providers in the admin area. Sign-up is open by default: anyone who can reach the URL can create an account and their own workspace (they cannot see yours). To close it, set `AUTH_SIGNUP_ENABLED=false` after creating your account; then only people you invite get in (Invite user in the admin area, or `docker compose exec api node apps/api/src/user-create.ts --email ann@example.com --name "Ann Lee"`).

The API applies database migrations on every start.

Sign-in by email works with a 6-digit code (no links) and needs a mail server: set `SMTP_URL` and `EMAIL_FROM`, and remove `EMAIL_TO_LOG=true` (it prints the codes to the API log and is for development only).

### Three ways to put it on the web

| | In `.env` |
| --- | --- |
| Plain HTTP (trying it out) | Nothing: Caddy listens on port 80, `PUBLIC_URL=http://localhost`. Another port: `LINEDESK_HTTP_BIND=8080` and `PUBLIC_URL=http://localhost:8080`. |
| Behind a reverse proxy you already run | `LINEDESK_HTTP_BIND=127.0.0.1:8480` and `PUBLIC_URL=https://front.example.com`. Caddy then listens only on that local address, without certificates; your proxy terminates TLS and forwards everything. |
| HTTPS by Linedesk's own Caddy | `COMPOSE_FILE=docker-compose.yml:docker-compose.https.yml` and `PUBLIC_URL=https://front.example.com`. Caddy listens on 80 and 443 and gets the certificate itself; DNS must point at the machine. |

For the reverse proxy case, this is all the outer proxy needs (Caddy shown; WebSockets for LiveKit signalling under `/rtc` and the long-lived sync responses pass through as they are):

```
front.example.com {
	reverse_proxy 127.0.0.1:8480
}
```

`PUBLIC_URL` must be exactly the address people open: sign-in only works on it.

### Settings

| Variable | What it does |
| --- | --- |
| `BETTER_AUTH_SECRET` | Signs sessions. Required; the API refuses to start with the placeholder. |
| `POSTGRES_PASSWORD` | Database password. Required; set it before the first start (letters and digits only). Changing it later does not change the password of an existing database. |
| `SECRETS_KEY` | Encrypts the provider keys stored in the admin area. Keep it: without the same key they cannot be read. |
| `PUBLIC_URL`, `LINEDESK_HTTP_BIND`, `COMPOSE_FILE` | See the table above. |
| `AUTH_SIGNUP_ENABLED` | `false` closes sign-up (see above): an instance admin creates accounts with Invite user or `pnpm --filter @linedesk/api user:create --email … --name … [--admin]`. While sign-up is closed, workspace owners can still invite people into their own workspace. |
| `LINEDESK_TRUSTED_PROXY_RANGES` (default empty) | Behind your own reverse proxy: the addresses or ranges it connects to Caddy from (space-separated; a proxy on the same host comes from the Docker gateway, e.g. `172.16.0.0/12`). Caddy then keeps the client address the proxy forwards; without it every client looks like the proxy and shares one rate-limit bucket. |
| `TRUSTED_PROXIES` | Addresses or ranges of the proxies in front of the API, for rate limits. Compose sets Docker's private ranges (only Caddy and the agent reach the API); change it only if you publish the API port yourself. |
| `AGENT_API_TOKEN` | Token the voice agent uses to call the API. While it is empty or the placeholder, agent access is off and the agent idles. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Required. Shared by LiveKit, the SIP bridge and the agent. The API and the agent refuse the development values from `.env.example`. |
| `LIVEKIT_NODE_IP` | The machine's public IP: the address callers and browsers send audio to. |
| `LIVEKIT_BIND_IP` | Set to `0.0.0.0` on a server. Without it the call audio and SIP ports are only published on 127.0.0.1. |
| Speech, language and voice | Set in the admin area under Providers (Deepgram, OpenRouter and ElevenLabs by default), or `DEEPGRAM_API_KEY`, `OPENROUTER_API_KEY` and `ELEVENLABS_API_KEY` in `.env`. Until then the agent says so in its log (`docker compose logs agent`) and calls are logged as missed. Without `AGENT_API_TOKEN` or the LiveKit settings it waits idle. |
| `TELEPHONY_PROVIDER`, carrier keys, `LIVEKIT_SIP_ENDPOINT` | Real phone numbers through a carrier: Telnyx by default, Twilio as the alternative; see `.env.example`. |

The API and agent containers read the rest of `.env` as is (sign-in methods, email, telephony, provider keys); only the addresses inside the stack are set by compose.

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

### Push notifications (optional)

Members can get a push for new calls (urgent ones first) on their phone or computer, even when Linedesk is closed: Settings, Notifications, "Push notifications on this device". It needs one VAPID key pair per install, generated once and kept (a new pair ends every existing subscription):

```sh
docker run --rm node:22-alpine npx -y web-push generate-vapid-keys   # or: pnpm --filter @linedesk/api exec web-push generate-vapid-keys
```

Put the two keys into `.env` as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, set `VAPID_SUBJECT` to a `mailto:` or `https:` address where push services can reach you, and restart the API. Without the keys the setting says push is not set up.

- Push needs HTTPS (or `localhost` for development). Chrome, Edge and Firefox work on desktop and Android. On iPhone and iPad (iOS 16.4+) people first add Linedesk to the Home Screen from Safari (Share, Add to Home Screen) and turn push on in the installed app.
- What a push contains: who called (contact name or number) and, only for members who turn on "Say what the call was about", one line (the call's topic). Never the transcript or the summary. The payload is encrypted for the browser; the browser's push service (Google, Apple, Mozilla) only delivers it.
- Subscriptions are stored per member and workspace and removed on sign-out, when a member leaves or is removed, when an account is disabled, and when the push service reports them gone. The service worker caches only the app shell (no API, sync or recording responses).

### Call recordings (optional)

Set `RECORDING_STORE=file` (or `s3` with the `S3_*` settings) and add `--profile recording` to the compose commands. LiveKit egress then writes recordings into the `recordings` volume, which the API reads. Egress comes on top of the memory above (up to 512 MB) and runs on the voice core.

### Update and backup

Update: `git pull && docker compose up -d --build`. Data lives in the volumes `pgdata` (database), `recordings` (call recordings) and `caddy_data` (certificates). Back up before updating:

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

## Docs

- [docs/architecture.md](docs/architecture.md): how Linedesk works (single source of truth)
- [docs/stack.md](docs/stack.md): why this stack: research, spikes, costs per minute
- [docs/plan.md](docs/plan.md): principles, open-source readiness, workstreams
- [docs/decisions.md](docs/decisions.md): decisions log
- [docs/research.md](docs/research.md): what an AI front desk must do well
- [docs/design-principles.md](docs/design-principles.md): UI rules

Working on the code: read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md) first. Security reports: [SECURITY.md](SECURITY.md).
