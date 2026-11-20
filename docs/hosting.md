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
| 5060 (udp and tcp) | SIP from the phone carrier |
| 10000-10100 (udp) | Phone call audio |

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

## Updates and backups

See [self-hosting.md](self-hosting.md#update-and-backup).
