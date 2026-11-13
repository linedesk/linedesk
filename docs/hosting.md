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
curl -fsSL https://raw.githubusercontent.com/linedesk/linedesk/main/scripts/install.sh | sh
```

About 15 minutes after the server starts, get the address and the setup code:

```sh
ssh root@<server IP> cat /root/linedesk-setup.txt     # Lightsail: ssh ubuntu@<server IP> sudo cat /root/linedesk-setup.txt
```

**On a server you already have:**

```sh
curl -fsSL https://raw.githubusercontent.com/linedesk/linedesk/main/scripts/install.sh | sudo sh
```

Open the address, enter the setup code, and set up the rest with your AI agent or by hand.

**With an AI agent:** Claude Code or Codex on your computer can do the whole move. The Linedesk setup tells your agent when it runs only on your computer; ask it to put Linedesk on a server. It helps you pick a provider, and once it can reach the server over SSH, it runs the install there and reads you the setup code.

## Your own domain

Point the domain's DNS A record at the server, then run the install command again with the domain:

```sh
curl -fsSL https://raw.githubusercontent.com/linedesk/linedesk/main/scripts/install.sh | sudo sh -s -- desk.example.com
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

## From your computer to the server

Settings and keys do not move with the install: set the server up again (the agent does it in about 15 minutes). Then stop the copy on your computer: `docker compose down` in its folder.

## Updates and backups

See the README: Update and backup.
