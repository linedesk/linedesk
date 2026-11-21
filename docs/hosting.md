# Put Linedesk on a server

Linedesk runs on your own computer for trying it out: the setup, the inbox and test calls in the browser all work there. Real phone calls need a server. The phone carrier sends each call (SIP) and its audio (RTP) over UDP to a public IP address, and a computer at home, a tunnel (ngrok, Cloudflare Tunnel) or an app platform (Render, Railway, Heroku, Vercel) cannot take them. Claude and ChatGPT on the web also reach the setup only on a public https address.

## What you need

- A Linux server (Ubuntu 22.04 or newer, Debian 12 or newer) with a public IPv4 address.
- 2 vCPUs and 2 GB of memory at least; 4 GB is recommended (call recordings, several calls at once). Linedesk itself uses about 1 GB at rest ([self-hosting.md](self-hosting.md#memory-and-cpu)).
- About $12 to $24 a month. A domain is optional: without one, the install gets a free https name for the server's IP.

## Where

Any VPS provider with a public IP works. If you don't have one yet, these are simple and have US regions; pick the region closest to your callers.

| Provider | What to create | 2 vCPUs, 2 GB | 2 vCPUs, 4 GB (recommended) |
| --- | --- | --- | --- |
| [DigitalOcean](https://www.digitalocean.com/products/droplets) | Droplet, Basic, Regular | $18/mo | $24/mo |
| [AWS Lightsail](https://aws.amazon.com/lightsail/pricing/) | Instance, Linux, Ubuntu | $12/mo | $24/mo |
| [Vultr](https://www.vultr.com/pricing/) | Cloud Compute, Regular Performance | $15/mo | $20/mo |

List prices in November 2026; check the provider's page.

## Install

One command does it all: Docker, the code in `/opt/linedesk`, the settings with random secrets, HTTPS, and the server's public IP for calls ([`scripts/install.sh`](../scripts/install.sh), short enough to read first). It takes about 10 minutes on a small server and ends with the address and a one-time setup code.

**While you create the server** (nothing to type later): paste this into the provider's user data field. DigitalOcean: Advanced options, Add initialization scripts. Lightsail: Add launch script. Vultr: Additional features, Cloud-Init User-Data.

```sh
#!/bin/sh
curl -fsSL https://raw.githubusercontent.com/linedesk/linedesk/HEAD/scripts/install.sh | sh
```

About 15 minutes after the server starts, get the address and the setup code:

```sh
ssh root@<server IP> cat /root/linedesk-setup.txt     # Lightsail: ssh ubuntu@<server IP> sudo cat /root/linedesk-setup.txt
```

**On a server you already have:**

```sh
curl -fsSL https://raw.githubusercontent.com/linedesk/linedesk/HEAD/scripts/install.sh | sudo sh
```

The setup code works once and stays the same across restarts of the API for 7 days; after that the next start prints a new one. To see it again, or to replace it with a new one (if someone else saw it): `docker compose exec api node apps/api/src/setup-code.ts [--new]`. It is gone once the first admin exists.

Open the address, enter the setup code, add your passkey when it asks (Server admin needs it; lost it? `docker compose exec api node apps/api/src/user-passkeys.ts --remove --email <email>` removes it and prints a code for a new one), and set up the rest with your AI agent or by hand.

**With an AI agent:** Claude Code or Codex on your computer can do the whole move. The Linedesk setup tells your agent when it runs only on your computer; ask it to put Linedesk on a server. It helps you pick a provider, and once it can reach the server over SSH, it runs the install there and reads you the setup code.

## Your own domain

Point the domain's DNS A record at the server, then run the install command again with the domain:

```sh
curl -fsSL https://raw.githubusercontent.com/linedesk/linedesk/HEAD/scripts/install.sh | sudo sh -s -- desk.example.com
```

It keeps all data and settings and only changes the address; everyone signs in again once. Behind Cloudflare's proxy, see [self-hosting.md](self-hosting.md#three-ways-to-put-it-on-the-web).

Behind Cloudflare (`docker-compose.cloudflare.yml`), with `LINEDESK_PARTNER_SITE=on` and `LINEDESK_SAAS_ORIGIN=saas-origin.example.com` in `.env`, Caddy also answers every other name on 443 with the app: that is how white-label partners' own addresses reach the server through Cloudflare for SaaS. Off by default (only your own address). The API decides which names it serves and answers 421 for any other once the install has a partner address. Cloudflare connects with the custom origin's name as SNI and checks the certificate against it in Full (strict), so the Cloudflare Origin CA certificate must also cover that name; Caddy ties the certificate to it. For Authenticated Origin Pulls (only Cloudflare can connect), turn them on in Cloudflare first, put Cloudflare's CA as `origin-pull-ca.pem` next to `origin.pem`, and set `LINEDESK_ORIGIN_PULL=on`.

## Firewall

Linedesk publishes only the ports it needs. DigitalOcean and Vultr have no firewall in front of a new server. Lightsail does: under Networking, IPv4 Firewall, add these rules (and the same if you add a firewall elsewhere):

| Port | For |
| --- | --- |
| 80 and 443 (tcp) | The web app |
| 7881 (tcp), 7882 (udp) | Call audio in the browser |
| 5060 (tcp) | SIP from the phone carrier |
| 10000-10100 (udp) | Phone call audio |

With encrypted calls (below), the server with LiveKit SIP also needs 5061 (tcp) for SIP over TLS and 80 (tcp) for its certificate.

## Alerts, backups and firewall on the server

For a server that runs real calls, [`ops/server/setup.sh`](../ops/server/README.md) adds what `docker compose` does not: email alerts, disk and memory checks, the nightly backup with a freshness check and a weekly restore test, SIP only from the carriers, and optionally SSH hardening and ufw.

```sh
sudo /opt/linedesk/app/ops/server/setup.sh --alert-to you@example.com
```

Restoring a backup: [self-hosting.md](self-hosting.md#backups).

## From your computer to the server

Settings and keys do not move with the install: set the server up again (the agent does it in about 10 minutes). Then stop the copy on your computer: `docker compose down` in its folder.

## Calls to other countries

Linedesk calls out for warm transfers and the forwarding check. A workspace may call the countries of its own Linedesk numbers: a workspace with US numbers calls US landlines and mobiles, nothing else. To let calls through this server's carrier account reach more countries (for example a business with a US number whose owner has a Canadian mobile), add them in Server admin › System, "International transfers" (pick each country by name), or set them in `.env`. A business that connected its own carrier account calls its own numbers' countries from those numbers; your list never widens its account. Countries often used for toll fraud (Cuba, Somalia, Latvia and others) ask for a second confirmation. The settings in `.env`:

```sh
OUTBOUND_COUNTRIES=CA,MX                  # ISO country codes; while set, the list in Server admin is read-only
OUTBOUND_MINUTES_PER_WORKSPACE_DAY=120    # minutes of transferred calls per workspace in 24 hours
OUTBOUND_MINUTES_INSTALL_DAY=2000         # all workspaces together, through this server's carrier account (ALERT in the log when reached)
TRANSFER_MAX_MINUTES=30                   # the longest one transferred call may last; 0 in any limit turns transfers off
```

The per-workspace minutes count every transferred call of the workspace, also those through its own carrier account (on its own bill); the install-wide minutes count only calls through this server's account. The forwarding check calls from this server's check line, so it may reach the countries of this server's numbers plus your list.

Premium-rate, shared-cost, toll-free, personal, emergency and service numbers are never called, in any country.

**Telnyx:** Linedesk keeps its voice profiles (`linedesk-*`) limited to the allowed countries itself, and puts two of Telnyx's own cost ceilings on each: a max destination rate (destinations that cost more per minute are refused) and a daily spend limit (once reached, the profile takes no new calls until the next day). Both are set when a profile is created, on every set-up and country change, and again each time the API starts, so an update brings older profiles to them. When Telnyx does not confirm them at start, the API tries again in the background (after 30 s, 2, 10 and 30 minutes), logs `ALERT outbound` lines, and Server admin › System shows "Spend limits not confirmed" with the voice profiles until a retry or the next set-up confirms them. Values above $1/min or $500 a day are applied, with a warning in the log:

```sh
TELNYX_MAX_DESTINATION_RATE=0.10   # USD per minute (default): US/Canada about $0.01, most mobile in Europe and Latin America a few cents
TELNYX_DAILY_SPEND_LIMIT=50        # USD per voice profile and day (default): 2000 install minutes at $0.025
```

Raise the rate if you allow a country whose mobile numbers cost more (Telnyx's outbound rate deck shows them); the transfer then fails with a carrier refusal until you do.

**Twilio:** which countries an account may call is the account's own setting, and Linedesk never changes it. Server admin › System shows the allowed countries Twilio still blocks; turn each on in Twilio Console › Voice › Settings › Geo permissions (low-risk numbers are enough). A workspace with its own Twilio account does the same in its account.

## Separate voice servers

One server runs everything until calls at the same moment get close to what its CPU can carry. CPU is the limit, not memory: each call in progress takes about 0.33 vCPU and 0.3 GB, so a 4 vCPU server answers about 9 to 12 calls at once (measured in load tests), fewer when the web app and the database are busy too. Then move the calls off the app server instead of buying a bigger one: Linedesk scales by job, not by customer. Every workspace stays on the one install; only the voice part moves out.

**What runs where**

| App server | Voice server 1 | Voice servers 2, 3, … (optional) |
| --- | --- | --- |
| Web app, API, Postgres, Electric, Caddy | LiveKit, the SIP bridge, egress, Valkey | The voice agent only |
| No SIP or call-audio port open | An agent worker | No published port |
| The voice link: the API for the agents (3100) | The voice link: LiveKit for the others (7880) | |
| `docker-compose.voice-link.yml` | `docker-compose.yml` + `docker-compose.voice-media.yml` | `docker-compose.voice.yml` |

The server with your customers' data opens no port to phone traffic, and a deploy or a busy database never takes CPU from a call. The carriers send calls to voice server 1 (`LIVEKIT_SIP_ENDPOINT`). Every agent worker, on any voice server, registers with voice server 1's LiveKit, which hands each new call to a worker below its load threshold, weighted by how idle it is. A worker that reaches `AGENT_LOAD_THRESHOLD` takes no new call, and the call goes to another. Hosted LiveKit keeps media servers, agents and customer data apart the same way.

**A voice server holds install-wide secrets.** Treat it like the app server, not as a throwaway machine: harden it the same way (`--harden-ssh`, `--ufw`, step 5) and run nothing else on it. Its `.env` has `AGENT_API_TOKEN`, which works in every workspace and reads the provider keys (speech, model and voice keys) through the API, and a LiveKit key, which can join and listen to any live call, change SIP trunks and dispatch rules and dial out through your outbound trunks. Give each further voice server its own LiveKit key (step 3), so you can shut one out without changing the main key, and its own SMTP credential for its alerts if your mail provider allows it. Someone who takes over a voice server can still use the agent token until you change it on every server (see "Remove or shut out a voice server").

**WireGuard is required.** The servers talk to each other only through WireGuard tunnels, on ports the voice links publish only on their WireGuard addresses: on the app server 3100, the API's internal listener (the agent's tokens work only there, never on the public site); on voice server 1 7880, LiveKit. Both are plain HTTP and WebSocket and carry the install-wide agent token and LiveKit tokens; WireGuard encrypts them and lets in only the servers whose keys you added. Your provider's private network (same region, no traffic charges) is fine as the path for the tunnels: set `Endpoint` to the other server's address on it. Without WireGuard on that network the tokens would pass in clear to every machine on it: that setup is not supported, and `scripts/deploy.sh` refuses to start a voice link unless `LINEDESK_VOICE_LINK_IP` is a private IPv4 address of a WireGuard interface on that server (IPv6 is refused too: the firewall below covers IPv4 only). Postgres is never published. Call audio and SIP do not use the tunnels: callers, carriers and agent workers reach LiveKit's public address (7881/tcp, 7882/udp, SIP 5060), encrypted like every WebRTC participant's. Put all servers in the same region and provider; the round trip between them adds to every reply.

**What passes the voice links.** On the app server's (3100) only `/v1/agent/*` and `/v1/actions/*` (what the agent calls). On voice server 1's (7880) only the worker's registration (`/agent`), room connections (`/rtc`, also the browser's test calls through the app server's Caddy) and the LiveKit services the API and the agent use (RoomService, SIP, Egress, AgentDispatch). Every other path answers 404. Each server's voice-link firewall lets in only the addresses in its `/etc/linedesk/voice-nodes.txt`, only at the link's address, and drops anything else they send through it (a route into Docker's networks to another container's port), whatever the Docker version. It works with Docker's default iptables firewall backend only: with the nftables backend (`"firewall-backend": "nftables"` in `daemon.json`, opt-in since Docker 29) there is no `DOCKER-USER` chain and neither this firewall nor the SIP firewall has any effect, so keep the default. Use Docker 28 or later.

**Recordings** must go to S3-compatible storage (Server admin › Providers › Recording storage, or `RECORDING_STORE=s3` with `S3_*`): egress runs on voice server 1 and cannot write into the app server's disk.

**Size:** voice server 1 needs about 1 vCPU more than its agent's share for LiveKit, SIP and egress; 4 vCPUs and 8 GB per agent-only voice server take about 10 calls at once. A dedicated (not shared) vCPU plan keeps replies steady under load.

**Steps**

1. **WireGuard.** On each server: `apt install wireguard`, then create the key where only root can read it: `umask 077; wg genkey > /etc/wireguard/wg0.key; wg pubkey < /etc/wireguard/wg0.key`. `/etc/wireguard/wg0.conf` on the app server (`chmod 600`):

   ```ini
   [Interface]
   Address = 10.8.0.1/24
   ListenPort = 51820
   PostUp = wg set %i private-key /etc/wireguard/wg0.key

   [Peer]
   # voice server 1
   PublicKey = <its public key>
   AllowedIPs = 10.8.0.2/32
   Endpoint = <its provider-network address>:51820
   PersistentKeepalive = 25
   ```

   Voice server 1 the same with the addresses swapped (`Address = 10.8.0.2/24`, a peer for the app server with `AllowedIPs = 10.8.0.1/32`) and one more peer per further voice server (`10.8.0.3/32`, …); a further voice server has peers for the app server and voice server 1. Each peer gets its own `/32` in `AllowedIPs`, so a server can only send from its own address. Name the interface `wg0` (or any name starting with `wg`: the voice-link firewall lets the listed addresses in only through such an interface). Then `systemctl enable --now wg-quick@wg0` everywhere, and open 51820/udp for the other servers' addresses only (with ufw: `ufw allow from <address> to any port 51820 proto udp`). Docker must start after the WireGuard address exists, or a voice link cannot bind it after a reboot: `systemctl edit docker` and add a `[Unit]` section with `After=` and `Wants=` set to WireGuard's unit (`wg-quick@wg0`, with the `.service` suffix). If WireGuard comes up later or is restarted, `setup.sh` installs `linedesk-voice-link@wg0`, which starts the voice link again.

2. **Recordings to S3** (see above), and move the phone setup over: LiveKit keeps the SIP trunks and dispatch rules in Valkey. When you move an existing install, copy Valkey's data (`/data/appendonlydir` of the `redis_data` volume) to voice server 1 before its first start, or run `setup-sip` there again for every number.

3. **Voice server 1.** Install Docker and put the same release of the code in `/opt/linedesk/app`. Its `.env` holds what LiveKit, SIP, egress and the agent need, never the database or auth secrets:

   ```sh
   COMPOSE_FILE=docker-compose.yml:docker-compose.voice-media.yml
   COMPOSE_PROFILES=recording        # egress
   LINEDESK_MAIN_HOST=10.8.0.1       # the app server's WireGuard address
   LINEDESK_VOICE_LINK_IP=10.8.0.2   # this server's WireGuard address
   LIVEKIT_NODE_IP=<this server's public IP>
   LIVEKIT_BIND_IP=0.0.0.0
   LIVEKIT_SIP_USE_EXTERNAL_IP=true
   LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=...      # the same as on the app server
   LINEDESK_VOICE_LIVEKIT_KEYS=voice-2: <secret>   # one per further voice server (openssl rand -hex 32)
   AGENT_API_TOKEN=<the same as on the app server>
   AGENT_LOAD_THRESHOLD=0.8          # the same on every voice server: with more than one worker, a full one refuses calls
   LINEDESK_VOICE_CPUSET=0-3         # the cores for LiveKit, SIP, egress and the agent
   LINEDESK_AGENT_MEM=4g
   AGENT_IDLE_PROCESSES=4            # warm processes: the calls that may start at the same moment (each ~160 MB, ~3 s CPU to start)
   ELECTRIC_SECRET=unused            # docker-compose.yml requires a value; nothing here uses it
   SMTP_URL=...                      # for the server's alerts only (ops/server)
   EMAIL_FROM=...
   ```

   plus the speech, model and voice keys the agent's variables name, if you keep them in `.env` rather than in Server admin › Providers. `/etc/linedesk/voice-nodes.txt`: the app server's and every further voice server's WireGuard address, one per line (private IPv4 only, a single address or at most a `/16`). `chmod 600 .env`, then `sudo ops/server/setup.sh --alert-to you@example.com --label voice-1 --ufw --harden-ssh` (the SIP firewall, the voice-link firewall, the agent check) and `scripts/deploy.sh`.

4. **App server.** In `.env`: `COMPOSE_FILE` gets `:docker-compose.voice-link.yml`, `LINEDESK_VOICE_LINK_IP=10.8.0.1`, `LINEDESK_LIVEKIT_HOST=10.8.0.2` (voice server 1's WireGuard address), and `LIVEKIT_SIP_ENDPOINT` a name that points at voice server 1 (DNS only, no proxy). `/etc/linedesk/voice-nodes.txt`: every voice server's WireGuard address. Run `sudo ops/server/setup.sh` and `scripts/deploy.sh`: the API and Caddy now reach LiveKit through voice server 1's voice link. The old local call services keep running until you stop them: once the new setup answers calls, `docker compose stop agent` (it drains) and `docker compose rm -sf livekit-sip livekit-egress redis`. Change the carrier's SIP address (the FQDN of your SIP connection) to `LIVEKIT_SIP_ENDPOINT` too.

   **Media server without an agent:** add `:docker-compose.no-agent.yml` to voice server 1's `COMPOSE_FILE`. It then runs LiveKit, SIP, egress and Valkey only (about 0.2 vCPU and 30 MB per call), and every call's agent runs on the further voice servers below, so calls grow those, not voice server 1. A media server with 2 vCPU takes about 8 calls at once, 4 vCPU about 16. When a voice server 1 that ran an agent becomes a media server, stop that agent once the agent servers take calls: `docker compose stop agent` (it drains), then `docker compose rm -f agent`; compose does not remove it by itself.

5. **Further voice servers** (optional; required with a media server without an agent). Docker, the code, and an `.env` with only this:

   ```sh
   COMPOSE_FILE=docker-compose.voice.yml
   LINEDESK_MAIN_HOST=10.8.0.1       # the app server's WireGuard address
   LINEDESK_LIVEKIT_HOST=10.8.0.2    # voice server 1's WireGuard address
   AGENT_API_TOKEN=<the same as on the app server>
   LIVEKIT_API_KEY=voice-2           # this server's own key from LINEDESK_VOICE_LIVEKIT_KEYS
   LIVEKIT_API_SECRET=<its secret>
   AGENT_LOAD_THRESHOLD=0.8
   LINEDESK_VOICE_CPUSET=0-3         # every core of this server
   LINEDESK_AGENT_MEM=6g             # about 0.8 GB plus 0.3 GB per call at once
   AGENT_IDLE_PROCESSES=4            # warm processes: the calls that may start at the same moment (each ~160 MB, ~3 s CPU to start)
   SMTP_URL=...
   EMAIL_FROM=...
   ```

   It publishes no port: `sudo ops/server/setup.sh --alert-to you@example.com --label voice-2 --ufw --harden-ssh` (with the agent check: an email, and with `--push-url` a phone push, when this server's worker is not registered or idle for two checks in a row; the app server's `/v1/health` cannot see one voice server fail while another worker checks in), then `scripts/deploy.sh`. The agent is healthy once it is registered with voice server 1's LiveKit.

6. **Check.** A real call to one of your numbers: it reaches voice server 1 (`docker compose logs livekit-sip` there), an agent answers, and the recording shows up. A test call from the browser goes through the app server's Caddy to voice server 1.

**Updates.** Update the voice servers to the same commit as the app server, right after it (the API keeps answering the previous release's agent during that time). `scripts/deploy.sh` replaces each worker start-first: the new worker registers, the old one takes no new calls and finishes its own (up to 2 hours) in the background. On voice server 1 LiveKit, SIP, egress, Valkey and the voice link change only at a moment without calls (no LiveKit room open), as on a single server. On the app server the voice link and the LiveKit forwarder wait for a moment without live calls the same way.

**Drain a voice server** before an OS update, a reboot or removing it: `docker compose stop agent` sends SIGTERM; the worker takes no new calls (LiveKit sends them to the other workers) and the command returns once its last call ended (at most `LINEDESK_AGENT_DRAIN`, 130 minutes). Make sure the other workers have room first. Voice server 1 also carries every call's media and SIP: reboot it only at a quiet moment, or add a second voice server first.

**Remove or shut out a voice server** (also at once, when it may be compromised):

1. Take its address out of `/etc/linedesk/voice-nodes.txt` on the app server and on voice server 1 and run `sudo ops/server/setup.sh` on both: the firewalls cut it off at once, open connections included. Remove its `[Peer]` from `/etc/wireguard/wg0.conf` and `systemctl restart wg-quick@wg0`.
2. Take its key out of `LINEDESK_VOICE_LIVEKIT_KEYS` on voice server 1 and run `scripts/deploy.sh` there: LiveKit stops accepting it at the next moment without calls (`LINEDESK_DEPLOY_DROP_CALLS=1` at once, cutting off the calls in progress).
3. If it may be compromised: it had the agent token, so set a new `AGENT_API_TOKEN` (at least 32 characters) on the app server and every voice server and deploy each. Change its SMTP credential at your mail provider.

## Encrypted calls (SIP over TLS, SRTP)

By default the carrier sends calls to LiveKit SIP over TCP (5060) and the call audio as plain RTP. With `LIVEKIT_SIP_TLS=on` the signalling goes over TLS (5061) and the audio is encrypted (SRTP), from the carrier to your server; LiveKit SIP still takes plain RTP from a carrier account not switched yet. `LIVEKIT_SIP_TLS=require` refuses it, once every carrier account with numbers on the install is switched (the install's own and each workspace's own Telnyx or Twilio account). It needs a server whose port 80 is free for the certificate: voice server 1 of "Separate voice servers" (on a single server, Caddy holds port 80).

1. `LIVEKIT_SIP_ENDPOINT` is a host name in lower case without a port (DNS only, no proxy) that points at the server with LiveKit SIP. Open 80 and 5061 (tcp) there, besides 5060 (with `ops/server/setup.sh --cloudflare` on that server, port 80 would take only Cloudflare: leave that option off there).
2. On that server: `COMPOSE_FILE` gets `:docker-compose.sip-tls.yml`, `.env` gets `LIVEKIT_SIP_TLS=on`; `scripts/deploy.sh` and `sudo ops/server/setup.sh` (its SIP firewall then covers 5061 too, and the timer `linedesk-sip-cert` restarts LiveKit SIP at a moment without calls once the certificate was renewed, and alerts when it is missing or ends within 14 days). `sip-cert` gets the certificate from Let's Encrypt within a minute; the deploy changes LiveKit SIP only once it is there (without it LiveKit SIP would not start at all).
3. Run `setup-sip` again for every number (where `LIVEKIT_SIP_TLS` is set): the inbound trunk then takes SRTP.
4. On the app server: `LIVEKIT_SIP_TLS=on` in `.env` and `scripts/deploy.sh`. The next number set up switches the carrier's connection (Telnyx: the FQDN connection to TLS, SRTP and port 5061; Twilio: the trunk to Secure and the origination URI to `sip:<host>:5061;transport=tls`), which every number on it follows. To switch at once, make the same change in the carrier's portal. A number setup that fails halfway can leave the connection half switched (calls refused): set the number up again, which repairs it. Do the switch at a quiet moment: calls are refused for the seconds between the carrier's two changes.
5. Once every carrier account is switched: `LIVEKIT_SIP_TLS=require` on both servers and `setup-sip` again: plain RTP is refused from then on.

Calls LiveKit SIP places itself (a warm transfer, the phone call test, the forwarding check) go out the same way: over TLS (5061) with SRTP once `LIVEKIT_SIP_TLS` is set where their trunk is made (the agent's `setup-sip --outbound` and `setup-test-caller`, the API for a workspace's own carrier account); the carrier's outbound connection is set to SRTP then (Telnyx: `encrypted_media`; Twilio: the trunk's Secure setting), and the LiveKit trunk takes SRTP only. After a change of `LIVEKIT_SIP_TLS` (on or back off), run `setup-sip --outbound <numbers>` and `setup-test-caller` again; a workspace's own-account trunk and the forwarding check's trunk are made again on their next call. LiveKit SIP checks the carrier's certificate chain on these calls but not its host name (a limit of LiveKit SIP): TLS keeps the call from anyone listening on the way, not from someone who can redirect the traffic and holds any valid certificate.

## Bill your own workspaces

Your install can charge the businesses on it, through your own Stripe account, at your prices and under your product name. It is off until you turn it on.

1. In Stripe (a sandbox first), create a restricted key with these permissions, and store it with the webhook signing secret under Server admin › Billing › Stripe:
   - write: Customers, Checkout Sessions, Subscriptions, Invoices, Invoice Items, Credit Notes, Refunds, Billing Portal Sessions, Products, Prices, and the Customer portal (billing portal configurations);
   - read: PaymentMethods, SetupIntents, Charges, Disputes, Radar Early Fraud Warnings, Events, Tax settings.

   The provider test checks the write permissions without writing anything and warns when one is missing. Live keys (`sk_live_…`, `rk_live_…`) are accepted only with `BILLING_LIVE_KEYS=1` in the server environment.
2. Run the bootstrap script once, with a separate key that may write the customer portal and webhook endpoints (not the install's restricted key). Read the key into the environment of that one command, so it is not in the shell history:

   ```sh
   read -rs STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY
   pnpm --filter @linedesk/billing bootstrap --sandbox \
     --webhook-url https://<host>/v1/billing/stripe/webhook --return-url https://<host>/settings/billing \
     --terms-url https://<site>/terms --privacy-url https://<site>/privacy
   ```

   It sets the tax default, the customer portal, card-only Checkout and the webhook endpoint; it makes no products or prices. For a live account use `--live --i-know` instead of `--sandbox`; without the two link flags it reads `TERMS_URL` and `PRIVACY_URL`; `--dry-run` only lists the changes. Run it once more: it must say "nothing to change". If it created the webhook endpoint, paste the secret from `packages/billing/stripe-webhook-secret.<mode>.txt` into Server admin › Billing › Stripe (Webhook signing secret), then delete the file (the script refuses to run while it exists).
3. In the Stripe Dashboard, set what the script cannot: the Terms of Service URL and Privacy Policy URL under Settings › Business › Public details (Checkout refuses every session without the terms URL), your branding, invoice settings, customer emails, Smart Retries (leave subscriptions past due afterwards; Linedesk suspends and cancels itself), Stripe Tax (head office address) and Radar rules.
4. Set your prices in Server admin › Billing (plan per workspace, free trial, price a minute, included minutes) and your product name in Server admin › Branding. Linedesk makes the matching products and prices in your Stripe account when you save them; if Stripe refuses (the key needs write on Products and Prices), every server admin is emailed at once.
5. Turn billing on under Server admin › Billing › Stripe, then check it: the provider test there (account and mode), and a test event from the webhook endpoint's page in the Stripe Dashboard ("Send test event"), which must get 200.

Prices are in US dollars. A new price applies to new sign-ups; running subscriptions keep theirs. Call prices, included minutes and limits apply to calls from the change on.

## Reports to the Linedesk team

Help › Report a bug and Request a feature (and `feedback_send` over MCP) email the report to the Linedesk team, support@linedesk.ai, through your install's email provider. The report has the text with keys, phone numbers and email addresses masked, the page, the app and server versions, your server's address, the workspace and sender ids and an optional screenshot; never the sender's email address unless they enter one to get an answer. To send reports to your own address instead, set `FEEDBACK_EMAIL=you@example.com` in `.env`; `FEEDBACK_EMAIL=off` sends nothing and only keeps the reports in the database (table `feedback`). Restart the API after a change.

Setup reports are separate: when an AI agent sets your server up through a setup link, it offers you a short report of what failed, was slow or went well, shows you exactly what would be sent, and sends it only with your yes. Your server sends it (never the agent) to `https://linedesk.ai/api/setup-feedback`: the outcome and items, the Linedesk version, how it is installed, the setup steps' states, the agent's name and a random install reference, with every key, phone number, email address and business detail your server knows removed; a contact address only if you give one. Server admin › System › Setup reports lists them; one that could not be sent is tried again every hour for 7 days and has Send again. `SETUP_FEEDBACK_URL=off` in `.env` sends nothing and only keeps them; another `https://` address sends them there.

## Updates and backups

See [self-hosting.md](self-hosting.md#update-and-backup).
