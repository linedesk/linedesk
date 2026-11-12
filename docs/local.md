# A local stack like production

The self-host stack (`docker compose`, optionally in live mode, docs/live-mode.md) on your own machine,
reachable on a public HTTPS address so that everything that needs one works as on a server: sign-in with
Google, Microsoft or GitHub, calendar connections, passkeys, web push and the test call from a phone.

```sh
scripts/local-public.sh start    # ngrok in the background; the stack moves to its address
scripts/local-public.sh status
scripts/local-public.sh stop     # back to the local address
```

Run it in the checkout the stack runs from (it reads and changes that checkout's `.env`). ngrok needs an
authtoken (`ngrok config add-authtoken <token>`, or `NGROK_AUTHTOKEN`). Free accounts have one fixed dev
domain (`*.ngrok-free.dev`), so the address stays the same between starts; `NGROK_URL` in `.env` picks a
reserved domain instead.

## Resource limits

The compose defaults are sized for a small server (Postgres 0.1 CPU and 128 MB, the API 0.1 CPU, all call
audio on one pinned core). On a laptop that is also running builds and tests, that starves Postgres:
requests and background jobs wait for a connection ("timeout exceeded when trying to connect") and
saving hangs. For a local stack, add `docker-compose.local.yml` (generous limits, sized for Docker Desktop with
8+ CPUs and 8 GB) last in `COMPOSE_FILE` in `.env`:

```
COMPOSE_FILE=docker-compose.yml${LINEDESK_MODE:+:docker-compose.$LINEDESK_MODE.yml}:docker-compose.local.yml
```

The voice services share cores 1-4 there; a Docker VM with fewer cores (`docker info` shows the count) needs its own `cpuset`. Then
`docker compose up -d` recreates the services with the new limits; the data stays in the volumes.

## One address, the public one

While the tunnel runs, `PUBLIC_URL` is the ngrok address and the stack is used only there, on this machine
too. The local address (`LINEDESK_HTTP_BIND`) then refuses sign-in and writes. That is on purpose: like a
server, the stack has exactly one origin, and several things depend on it:

- cookies: on https they are `Secure` and belong to that host; a cookie of the local address never reaches the public one;
- the origin checks of Better Auth and of `/v1` writes (`TRUSTED_ORIGINS`, `apps/api/src/csrf.ts`): one origin;
- passkeys: the relying party is the host of `PUBLIC_URL`; a passkey made on one host does not work on another;
- OAuth: Google, Microsoft and GitHub redirect to `<PUBLIC_URL>/api/auth/callback/<provider>` and
  `<PUBLIC_URL>/v1/calendar/callback/<provider>`, which must be registered with the provider;
- web push needs https, and links in emails (sign-in, invitations) use `PUBLIC_URL`.

Changing the address means signing in again; the accounts and sessions in the database stay.

`start` changes `PUBLIC_URL`, `LIVEKIT_PUBLIC_URL` (wss on the same address: Caddy serves LiveKit
signalling at `/rtc`), `LIVEKIT_NODE_IP` and `LIVEKIT_BIND_IP` (this machine's LAN address) and
`LINEDESK_TRUSTED_PROXY_RANGES` (so rate limits see the clients behind ngrok) in `.env`, and recreates
the services they concern. `stop` puts the previous lines back.

## Protection

The tunnel is public, so it asks for basic auth (`LINEDESK_TUNNEL_AUTH` in `.env`, made on the first
start). An ngrok traffic policy leaves open only what cannot send basic auth and is protected otherwise:

- `/api/auth/callback/*`, `/api/auth/oauth2/callback/*`, `/v1/calendar/callback/*`: the provider's redirect, checked against its state;
- `/rtc`: LiveKit signalling (browsers send no basic auth on a WebSocket), needs a LiveKit token;
- requests with `Authorization: Bearer`: API keys and MCP clients, checked by the API.

After the first basic-auth answer, ngrok sets a gate cookie (`linedesk_gate`, 30 days, `Secure; HttpOnly`) that lets
the browser's later requests through: the app's `fetch` calls, its service worker and an installed app do not
all repeat basic auth. The browser may keep sending the basic-auth header; the API reads only `Bearer` credentials from
`Authorization`, so the session cookie still decides who is signed in. On the free plan, ngrok shows a
warning page once per browser before the app.

## What does not go through ngrok

ngrok carries HTTP only. Call audio (WebRTC media) and SIP do not go through it:

- **Test call from a phone:** works when the phone is on the same network. LiveKit announces this
  machine's LAN address, and the phone sends the audio there directly. After changing networks, run
  `start` again (the LAN address changes). From a phone on mobile data it needs a TURN server or a
  machine with a public IP.
- **Real phone calls (Telnyx, Twilio):** the carrier sends SIP (UDP 5060) and RTP (UDP 10000–10100) to
  a public IP. A tunnel for that would need UDP forwarding with fixed ports (a VPS with a WireGuard
  tunnel to this machine, for example). Use the test server for real calls.
- Carrier status webhooks: not used today (calls arrive over SIP).

## After a restart

The containers restart by themselves, ngrok does not. Run `scripts/local-public.sh start` again (same
address), or `stop` to use the local address.
