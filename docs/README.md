# Linedesk docs

## How it works, in ten lines

1. **Three apps:** the API (`apps/api`, Hono, which also runs the pg-boss jobs), the web app (`apps/web`, a Vite + React SPA) and the voice agent (`apps/agent`, LiveKit Agents in TypeScript). See [architecture.md §3](architecture.md#3-system-overview).
2. **One write path:** every change, from the UI, the REST API, MCP or the voice agent, is an action in the registry (`packages/actions`) run through `POST /v1/actions/<name>`. See [§5](architecture.md#5-action-registry).
3. **Local-first UI:** the web app applies a change locally at once and sends it through an IndexedDB outbox; data comes back through read sync (Electric). See [§6](architecture.md#6-sync-commands-up-data-down).
4. **Postgres is the source of truth,** with Drizzle migrations (`packages/db`); every synced table belongs to a workspace. See [§9](architecture.md#9-data-model).
5. **A call:** the carrier (Telnyx or Twilio) sends it over SIP to LiveKit; the agent answers with speech to text, a language model and a voice (or one speech-to-speech model), calls actions as tools, and the API stores the summary, transcript and recording. See [§7](architecture.md#7-call-lifecycle).
6. **Providers behind interfaces:** telephony, speech, model, voice, calendar, email and storage are adapters; an operator connects the keys in Server admin. See [§12](architecture.md#12-admin-area-and-provider-keys).
7. **Calendars and phone setup:** own adapters for Google, Microsoft, CalDAV, Calendly and Cal.com, and phone modes: conditional forwarding with a carrier code, forward all, or a new or ported number. See [§8](architecture.md#8-phone-setup-and-calendar).
8. **Integrations:** API keys, OpenAPI, MCP, signed webhooks and connected business apps. See [§13](architecture.md#13-integrations-api-keys).
9. **Self-hosting:** one Docker Compose stack with Caddy in front; every service has a memory and a CPU limit. See [§11](architecture.md#11-repository-and-deployment).
10. **Optional for hosted installs:** billing with Stripe and white-label partners. See [§17](architecture.md#17-billing-linedesk-cloud) and [§18](architecture.md#18-white-label-partners).

## Every doc

**Run it**

- [hosting.md](hosting.md): put Linedesk on a server: providers, sizes, the one-command install, your own domain, calls to other countries, billing your own workspaces
- [self-hosting.md](self-hosting.md): the self-hosting reference: settings, HTTPS and proxies, deploy methods, ports and firewall, memory and CPU, push, recordings, updates, backups and restore
- [backups-wal.md](backups-wal.md): WAL archiving, for restores that lose minutes instead of a day
- [operator-responsibilities.md](operator-responsibilities.md): your responsibilities when you run Linedesk: callers' data, recording, AI disclosure, emergencies
- [public-demo.md](public-demo.md): a live demo call on your website

**Build on it**

- [api.md](api.md): the public API, API keys, MCP and the setup MCP for AI agents
- [webhooks.md](webhooks.md): an assistant's webhook: hooks, payloads, signatures, the during-call lookup
- [crm-sync.md](crm-sync.md): connected business apps: HubSpot, Slack, Jobber
- [white-label.md](white-label.md): agencies and partners running workspaces for their clients

**Work on the code**

- [architecture.md](architecture.md): how Linedesk works, the single source of truth
- [commands.md](commands.md): every command: dev stack, voice, call tests, recordings, snapshots, seeding
- [local.md](local.md): a local stack like production, on a public HTTPS address
- [dev-mode.md](dev-mode.md): run the stack from a git checkout, on your machine or a test server
- [design-principles.md](design-principles.md): the UI rules
- [translations.md](translations.md): languages, the translation pipeline, fixing a translation
- [ci.md](ci.md): what CI checks on a pull request and on the trunk
- [research.md](research.md): what an AI call-answering product must do well
