# Roadmap

Linedesk is in early development. This page says what works, what is being built and what comes later. It changes often. The code is not public yet; "works today" refers to our development version.

## Works today

- Monorepo, Postgres schema and migrations, Docker Compose for development
- Sign-in and workspaces (multi-tenant)
- Action registry with one write path (`POST /v1/actions/<name>`) and read sync
- Call simulator: scripted calls through the real API, no provider keys needed
- Slot finding for bookings (working hours, exceptions, buffers, minimum notice)
- Call recordings (file system or S3-compatible storage) with authenticated playback

## In progress

- Web app: inbox, call view, reminders, offline writes
- Telephony: Telnyx adapter, LiveKit SIP, voice agent, post-call summary
- Self-hosting with one Compose file (API, web app, reverse proxy)
- Account settings and more sign-in methods (email link, Google, Microsoft, OIDC)

## Next

- Calendar adapters (Google, Microsoft) and bookings from the call
- MCP server and OpenAPI docs generated from the action registry
- Background jobs, webhooks
- Full post-call analysis (structured fields, spam score)
- Latency tests on real calls and a published cost per minute

## Later

- More channels on the same foundation: WhatsApp (including calls), SMS, email
- More telephony adapters: Twilio, Plivo, bring-your-own SIP
- Templates per trade (plumber, dental practice, salon)
- Hosted version

Have a use case that is missing? Open an issue.
