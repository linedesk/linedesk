# Put Linedesk on a server

Linedesk runs on your own computer for trying it out: the setup, the inbox and test calls in the browser all work there. Real phone calls need a server. The phone carrier sends each call (SIP) and its audio (RTP) over UDP to a public IP address, and a computer at home, a tunnel (ngrok, Cloudflare Tunnel) or an app platform (Render, Railway, Heroku, Vercel) cannot take them. Claude and ChatGPT on the web also reach the setup only on a public https address.

## What you need

- A Linux server (Ubuntu 22.04 or newer, Debian 12 or newer) with a public IPv4 address.
- 2 vCPUs and 2 GB of memory at least; 4 GB is recommended (call recordings, several calls at once). Linedesk itself uses about 1 GB at rest (README, Memory and CPU).
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

Open the address, enter the setup code, add your passkey when it asks (Server admin needs it; lost it? see docs/self-host-first-run.md "Your passkey"), and set up the rest with your AI agent or by hand.

**With an AI agent:** Claude Code or Codex on your computer can do the whole move. The Linedesk setup tells your agent when it runs only on your computer; ask it to put Linedesk on a server. It helps you pick a provider, and once it can reach the server over SSH, it runs the install there and reads you the setup code.

## Your own domain

Point the domain's DNS A record at the server, then run the install command again with the domain:

```sh
curl -fsSL https://raw.githubusercontent.com/linedesk/linedesk/HEAD/scripts/install.sh | sudo sh -s -- desk.example.com
```

It keeps all data and settings and only changes the address; everyone signs in again once. Behind Cloudflare's proxy, see the README (Three ways to put it on the web).

## Firewall

Linedesk publishes only the ports it needs. DigitalOcean and Vultr have no firewall in front of a new server. Lightsail does: under Networking, IPv4 Firewall, add these rules (and the same if you add a firewall elsewhere):

| Port | For |
| --- | --- |
| 80 and 443 (tcp) | The web app |
| 7881 (tcp), 7882 (udp) | Call audio in the browser |
| 5060 (udp and tcp) | SIP from the phone carrier |
| 10000-10100 (udp) | Phone call audio |

## Alerts, backups and firewall on the server

For a server that runs real calls, [`ops/server/setup.sh`](../ops/server/README.md) adds what `docker compose` does not: email alerts, disk and memory checks, the nightly backup with a freshness check and a weekly restore test, SIP only from the carriers, and optionally SSH hardening and ufw.

```sh
sudo /opt/linedesk/app/ops/server/setup.sh --alert-to you@example.com
```

When something breaks (server gone, database restore, calls not arriving, a leaked key): [docs/runbook.md](runbook.md).

## From your computer to the server

Settings and keys do not move with the install: set the server up again (the agent does it in about 10 minutes). Then stop the copy on your computer: `docker compose down` in its folder.

## Calls to other countries

Linedesk calls out for warm transfers and the forwarding check. A workspace may call the countries of its own Linedesk numbers: a workspace with US numbers calls US landlines and mobiles, nothing else. To let calls through this server's carrier account reach more countries (for example a business with a US number whose owner has a Canadian mobile), add them in Server admin › System, "Calls to other countries", or set them in `.env`. A business that connected its own carrier account calls its own numbers' countries from those numbers; your list never widens its account. Countries often used for toll fraud (Cuba, Somalia, Latvia and others) ask for a second confirmation. The settings in `.env`:

```sh
OUTBOUND_COUNTRIES=CA,MX                  # ISO country codes; while set, the list in Server admin is read-only
OUTBOUND_MINUTES_PER_WORKSPACE_DAY=120    # minutes of transferred calls per workspace in 24 hours
OUTBOUND_MINUTES_INSTALL_DAY=2000         # all workspaces together, through this server's carrier account (ALERT in the log when reached)
TRANSFER_MAX_MINUTES=30                   # the longest one transferred call may last; 0 in any limit turns transfers off
```

The per-workspace minutes count every transferred call of the workspace, also those through its own carrier account (on its own bill); the install-wide minutes count only calls through this server's account. The forwarding check calls from this server's check line, so it may reach the countries of this server's numbers plus your list.

Premium-rate, shared-cost, toll-free, personal, emergency and service numbers are never called, in any country.

**Telnyx:** Linedesk keeps its voice profiles (`linedesk-*`) limited to the allowed countries itself.

**Twilio:** which countries an account may call is the account's own setting, and Linedesk never changes it. Server admin › System shows the allowed countries Twilio still blocks; turn each on in Twilio Console › Voice › Settings › Geo permissions (low-risk numbers are enough). A workspace with its own Twilio account does the same in its account.

## Updates and backups

See the README: Update and backup.
