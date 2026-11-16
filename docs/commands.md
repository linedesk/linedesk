# Commands

All commands for working on Linedesk. The short list every session needs is in [CLAUDE.md](../CLAUDE.md#commands); this page has the details.

## Set up

- `pnpm install`, then `scripts/setup.sh` (makes `.env` from `.env.example` with random secrets; a plain `cp .env.example .env` leaves `SECRETS_KEY` empty, so nothing can be stored under Server admin › Providers).
- Email-code sign-in delivers nowhere until email is connected in Server admin › Providers: uncomment `EMAIL_TO_LOG=true` in `.env` for local development (codes in the API log).
- There is no open sign-up: accounts come from the first-run setup, an invitation or a server admin, and only server admins create workspaces ([architecture.md](architecture.md), "Workspace rights"). A fresh database without users: the API prints a setup code; the sign-in page asks for it and makes the first instance admin (`apps/api/src/setup.ts`).

## Database and test data

- `pnpm db:up` (Postgres on 5433 + Electric on 3001), `pnpm db:migrate`, `pnpm db:seed` (demo login is printed; `pnpm db:seed -- --reset` replaces an existing demo's calls and contacts).
- Local test data: `pnpm db:seed -- --user <email> [--business <name>] [--reset]` fills that account's own workspace (onboarding done, assistant, hours, a dev number, appointment types, team, calls in every inbox view; `--reset` replaces only what the seed added).
- Snapshots: `pnpm dev:snapshot [-p <compose project>]` saves a local dev database to `~/.linedesk/dev-snapshot.dump` (outside every worktree, never in git; sessions, provider keys and other secrets left out); a new, empty Postgres volume of `pnpm db:up` (or any stack with `docker-compose.snapshot.yml` in `COMPOSE_FILE`) and a new database from `scripts/dev-env.sh` start from it, migrations run after. `pnpm dev:restore [-p <project>] [--force]` replaces an existing database with it. No snapshot: the database starts empty, seed as before.
- Schema change: edit `packages/db/src/schema.ts`, `pnpm db:generate`, `pnpm db:migrate`. Updates run the new API next to the old one (`scripts/deploy.sh`), so a migration must keep the previous release working: expand/contract ([architecture.md](architecture.md) §11, "Updates without downtime").

## Run, check, test

- `pnpm dev` (API on 3100, web on 5173), `pnpm typecheck`, `pnpm test`.
- `pnpm lint` (Biome, config in `biome.json`; PR CI runs typecheck, lint and the image build). `pnpm format <files>` formats only the files you touched; don't run it on the whole repo, the code is not reformatted yet.
- The API tests (`apps/api/test`) need Postgres (`pnpm db:up`). Each run creates and drops its own databases `linedesk_test_<run>`, never `linedesk`: one for each file that changes what is global to an install or counts across workspaces (`INSTANCE_WIDE_FILES` in `apps/api/vitest.config.ts`: admin, setup checklist, provider failures, setup MCP, install setup; a new file that sets provider keys, instance settings, instance admins or stored provider tests goes there), one for all others; `TEST_DATABASE_URL` overrides the base name. Without Postgres they are skipped with a message.
- The dev Postgres of `pnpm db:up` runs with `max_locks_per_transaction=1024` (`docker-compose.ports.yml`; the server default is 64), as CI's (`tests.yml`, docs/ci.md "Tests"): the API tests create and migrate about 26 databases at once, which otherwise fails with "out of shared memory". A running container picks it up after `pnpm db:up` recreates it.
- Prototype: `cd prototypes/inbox-html && python3 -m http.server 4173`.

## Calls without a phone

- Simulate a call (no provider keys): `pnpm --filter @linedesk/agent simulate [leak|booking|message|hangup] [--fast] [--to <number>]`; targets `LINEDESK_API_URL`. Dials `--to`, else `SIM_TO_NUMBER`, else the install's only Linedesk number (`call.listNumbers`); the call is filed with `source` `simulated`: shown like a phone call, never counted as a real one (setup milestones, usage, spending cap).
- Talk to the assistant without a phone: Settings, Assistant, "Start test call" in the web app (needs `pnpm voice:up` and the agent worker; the call is filed in the inbox as a test call). From a phone's browser: `scripts/tunnel.sh [web-port]` (ngrok, `NGROK_AUTHTOKEN` or ngrok's own config; prints the env lines to set). The older `pnpm --filter @linedesk/agent talk` page still works.
- The docker compose stack on a public HTTPS address like a server (OAuth redirects, passkeys, push, phone test call): `scripts/local-public.sh start|stop|status` ([local.md](local.md)).

## Voice

- `pnpm voice:up` (LiveKit on 7880, LiveKit SIP on 5060, Redis).
- `pnpm --filter @linedesk/agent setup-sip [--outbound] <numbers>` (SIP inbound trunk, only from the carriers' signaling addresses in `LIVEKIT_SIP_ALLOWED_ADDRESSES`, default `telnyx twilio`, + dispatch rule; `--outbound` also the trunk warm transfers dial out through, Telnyx only).
- `pnpm --filter @linedesk/agent worker` (voice agent; answers calls once speech recognition, language model and voice are set up in Linedesk under Providers, or by `DEEPGRAM_API_KEY`, `OPENROUTER_API_KEY` and `ELEVENLABS_API_KEY` in its env; until then it runs and logs each call as missed; it reads the settings through `GET /v1/agent/provider-config`, see `apps/agent/src/config.ts`).

## Recordings (optional)

Pick Local disk under Server admin › Providers › Recording storage (or set `RECORDING_STORE=file`) and run `pnpm recording:up` (LiveKit egress, writes each call into `data/recordings`). Calls are recorded unless `assistants.record_calls` is false; `GET /v1/calls/<id>/recording` serves the audio to members of the workspace from the store the call's recording is in (`calls.recording_store`). S3-compatible (or `RECORDING_STORE=s3`) uses a bucket instead.

## Call test

Our test-caller agent calls the business; transcript, summary, pass/fail and latency; in room mode also the business agent's own time from pickup to the greeting, checked against 2.5 s.

`pnpm --filter @linedesk/agent call-test <scenario> [--phone [--external]] [--pipeline realtime|three_stage] [--expect-recording]`

- Default: both agents in one LiveKit room, no phone (cheap).
- `--phone`: a real call over Telnyx from `CALL_TEST_FROM` to `CALL_TEST_TO` (run `setup-test-caller` once; a few cents).
- `--external`: `CALL_TEST_TO` is another install's number (e.g. production called from staging's test caller): no checks, only what the caller heard.
- `--pipeline` (no phone only): the business answers with the realtime model or the three stages instead of its assistant's choice (`assistants.voice_pipeline`, Settings › Assistant › Answered by; over the phone that setting applies).
- Needs the worker running and `CALL_TEST_TO` (names the workspace).

Scenarios: `apps/agent/src/test-caller/scenarios.ts`.

- `after-hours` sets the business closed for itself without a phone.
- `transfer-accepted`, `transfer-declined` and `transfer-no-answer` turn transfer on for themselves and answer it with a simulated on-call person, nothing is dialled; over real phone lines only as the live transfer test with `CALL_TEST_ONCALL` and `setup-oncall-test` ([architecture.md](architecture.md)); with `--phone` the workspace's real hours apply. `transfer-person` does the same with the "asks for a person" rule; `transfer-next` with two urgent contacts, the first set to try the next, nobody answering.
- `spanish-caller` allows Spanish for itself and the caller speaks only Spanish; `mandarin-caller`, `korean-caller` and `polish-caller` the same for a language outside Flux's 10 (the call runs on Nova-3 `multi`).
- `silence-closing` stays silent until the assistant's reminders, closing line and hang-up; `silence-mid-call` says what it wants, then goes silent (muted, not "...") for the same check.
- `booking` and `which-calendar` expect a real booking, the event in the calendar and, for `which-calendar`, the calendar whose note says emergencies, when the assistant has an appointment type and a calendar, else a message; `--cancel-booking` deletes the test booking afterwards.

Provision a business without the web app: `node apps/api/src/workspace-create.ts --name <business> --owner <email> [--owner-name <name>] [--as <server admin email>] [--number +1…]` (runs `workspace.create` as that server admin, like Server admin › New workspace: a confirmed account becomes the owner, anyone else gets the owner invitation by email; `--as` may be left out only while the install has exactly one server admin).

## Load test

What calls at once cost the agent; a dev machine or test server, never production.

`pnpm --filter @linedesk/agent load-test [--calls 1,5,10] [--to <business number>] [--scenario <name>] [--pipeline realtime|three_stage] [--memory 4g]`

Starts a second agent container that plays the test callers (`AGENT_NAME=linedesk-load-caller`, so only the business side is measured), raises the agent's memory limit for the test and puts it back, then per level starts N test calls without a phone (`apps/agent/src/load-test/calls.ts`) while sampling the agent container; prints memory before, peak, per call and after, CPU, processes, greeting and reply times. Every call is billed on both sides.

## Self-host stack

What `docker compose up` gives a user: `docker-compose.yml` alone is the whole application (project name `linedesk`, limits and log rotation per service, only Caddy (`proxy`) and LiveKit's audio and SIP ports published; `web` is the SPA's files behind it).

- `docker-compose.ports.yml` adds the local ports for development and is what `pnpm db:up`, `pnpm voice:up` and `pnpm recording:up` use; `docker-compose.https.yml` lets Caddy get certificates.
- docker compose needs `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` to be set for every command, so `scripts/setup.sh` (or `cp .env.example .env`) comes before `pnpm db:up`.
- A new service needs `<<: *service`, `mem_limit` and `cpus`.
- To try the self-host stack next to a running dev stack, always pass another project name (`docker compose -p linedesk-selfhost ...`, the default name is the dev stack's), its own hostname and port (`PUBLIC_URL=http://selfhost.localhost:8480 LINEDESK_HTTP_BIND=127.0.0.1:8480`; never plain `localhost`: cookies are shared across ports and sign the live app out).
- The images run the `.ts` sources directly on Node (type stripping): see the erasable-syntax rule in [CLAUDE.md](../CLAUDE.md#code-style).

## Dev mode

Your machine or a test server, never production ([dev-mode.md](dev-mode.md)). `LINEDESK_MODE=dev` in `.env` runs api, web (Vite, hot reload) and agent from the checkout via `docker-compose.dev.yml`; `scripts/deploy.sh` then fast-forwards the checkout instead of building, and refuses while it has local changes. To code on the server, switch its checkout to a branch, edit, commit, push, switch back to master-dev (one session at a time).

## Errors and logs

Sentry, on staging and production via `SENTRY_DSN` (off without it; `apps/api/src/error-reporting.ts`, `apps/agent/src/error-reporting.ts`, `apps/web/src/errorReporting.ts`). It gets errors, `console.warn`/`console.error` lines and the member they hit (id, email, name); never transcripts, request bodies, local variables or AI inputs and outputs, and phone numbers are masked. Our Sentry project and how the team works with it: `docs/internal/working.md`, "Sentry" (maintainers, not in the public repository).
