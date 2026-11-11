# Linedesk

**The open-source AI receptionist for businesses.** It answers every call, books the appointment and hands over to a person when needed, and you own the code and the data. Every call lands in a fast, keyboard-first inbox.

[Self-hosting](#self-hosting) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE)

> **Status: the code is not public yet.** We are building Linedesk and will publish the source in this repository under the AGPL-3.0. Watch or star the repository to get notified when it lands.

![The Linedesk inbox](docs/images/inbox.png)

<sub>The inbox, shown in the design prototype with demo data.</sub>

## What it will do

- **Answers every call.** A voice assistant picks up, understands what the caller wants and answers questions about your business.
- **Books appointments.** It checks your calendar and books a free slot during the call.
- **Hands over to a person.** When it matters, the call or a callback goes to your team.
- **One inbox for all calls.** Summary, transcript and recording of every call, built for working through quickly with the keyboard.
- **Self-hosted or hosted.** Run it on your own server with your own provider keys, or use the hosted version.

## Open source and hosting

Linedesk will be licensed under the [AGPL-3.0](LICENSE) and can be self-hosted, with your own provider keys and no license key.

We plan to offer a hosted version for businesses that do not want to run servers; that is how we intend to fund the project. If we ever add paid-only features, they will live in a separate `ee/` folder under their own license.

## Self-hosting

> **Coming with the first public release.** This guide is a placeholder; the commands below will work once the code is published here.

Linedesk runs as one Docker Compose project on your own server. A small VPS with about 1.5 GB of free RAM is enough.

**You need**

- A Linux server with Docker and Docker Compose, plus a domain pointing at it
- A phone number from Twilio or Telnyx, on your own account
- API keys for the speech, language and voice providers you pick

**Install**

```bash
git clone https://github.com/linedesk/linedesk
cd linedesk && cp .env.example .env
docker compose up -d
```

Set `PUBLIC_URL` and your provider keys in `.env` before starting. Then open your `PUBLIC_URL` and create the first account.

**What runs:** Postgres, Electric, the API, the voice agent, LiveKit with LiveKit SIP, Valkey and Caddy for HTTPS.

Configuration, updates, backups and connecting your phone number will be documented here.

## Get involved

Until the code is public, the most useful thing is to tell us about your use case: open a [feature request](../../issues/new?template=feature_request.yml) and describe how calls work in your business today.

For anything else, write to [hello@linedesk.ai](mailto:hello@linedesk.ai).

## License

[AGPL-3.0](LICENSE). "Linedesk" and the Linedesk logo are trademarks of Sauerbier & Gutberlet GmbH; see [TRADEMARK.md](TRADEMARK.md).
