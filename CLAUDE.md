# CLAUDE.md

Guidance for every coding session in this repo, human or AI (`AGENTS.md` is the same file). Read this first, then the doc for your area.

## What this is

Linedesk: the open-source AI receptionist for businesses. An AI assistant answers calls, summarizes them, books appointments and hands over to a person; a keyboard-first, local-first inbox for the business. v1 = phone + calendar, US first.

## Source of truth

- How the system works: [docs/architecture.md](docs/architecture.md)
- Decisions: in a pull request, under "Decisions" in its description
- UI rules: [docs/design-principles.md](docs/design-principles.md); reference UI: `prototypes/inbox-html/index.html`
- All commands: [docs/commands.md](docs/commands.md). Translations: [docs/translations.md](docs/translations.md). CI: [docs/ci.md](docs/ci.md)

If code and docs disagree, stop and ask; don't silently pick one.

## Stack (decided)

TypeScript everywhere. pnpm + Turborepo. Hono + Zod (+ `@hono/zod-openapi`) for the API and action registry. Official MCP TypeScript SDK v2 (Streamable HTTP, stateless). Postgres + Drizzle. Better Auth (orgs, API keys, OAuth provider). pg-boss for jobs. Vite + React SPA with a local store, an IndexedDB outbox and a `ReadSyncAdapter` (Electric default, PowerSync swap). LiveKit (server + SIP) with LiveKit Agents in TypeScript. Telephony via adapters (Telnyx default, Twilio, Plivo, BYO SIP). Calendar via own adapters (Google, Microsoft, CalDAV for iCloud and others, Calendly, Cal.com).

## Core rules

1. **Every action goes through the registry.** Define it once with `defineAction()` (name, Zod input, permission, optional optimistic `patch`, server `handler`, event). Never add a REST route, MCP tool, UI mutation or agent tool that bypasses the registry.
2. **Local-first.** UI mutations apply locally and go through the outbox; never block the UI on a network round trip for a user action.
3. **Show the result of what the user just did, immediately; never require a reload or a wait for the next poll.** Most tables are polled, not live (`LIVE_TABLES` in `apps/web/src/storeCache.ts`), so a write outside the outbox brings its own result: a direct action uses `useWriteAction`; a cached read (`useQuery`) gets `setQueryData` or `refreshQuery` right after the write; a redirect that writes on the server (OAuth: calendar connect) calls `refreshOnReturn(tables)` (`apps/web/src/refreshOnReturn.ts`) before leaving, so those tables show as loading on return, never the state from before; anything else that changes rows the user waits for: `store.refresh(tables, { wait: true })`.
4. **Providers behind interfaces.** Telephony, speech, LLM, calendar and sync code talks to an interface; vendor SDKs live only in their adapter.
5. **Postgres is the source of truth.** Schema changes only via Drizzle migrations. Change the schema by expand/contract, so the previous release keeps working.
6. **Self-hosting works at every commit.** `docker compose up` must keep working; a new service needs a compose entry (`<<: *service`, `mem_limit`, `cpus`) and its env vars in `.env.example`.
7. **Open-source ready.** No secrets, keys, customer data or internal notes in the repo.
8. **The operator decides the rules for calls.** Recording notices, AI disclosure, greetings and outbound rules are settings, not fixed behaviour: laws differ by country and state ([docs/operator-responsibilities.md](docs/operator-responsibilities.md)). Add a new rule as a setting with a safe default.
9. **Terms:** Assistant (not Receptionist), Remind/Reminder (not Snooze). Demo data: Brightwater Plumbing & Heating, Portland; assistant "Maya"; owner Mike Brennan.
10. **No user-visible English in code**, in `.ts` as much as `.tsx` (labels built in helpers, fallbacks, error messages the page shows). Add the key to `packages/i18n/locales/en/<ns>.json` and use `t()` (`i18n().t()` outside components); never edit other locales in a feature PR. `pnpm i18n:check` fails on hardcoded English under `apps/web/src`; `packages/i18n/hardcoded-baseline.json` is empty and stays empty, never raise it. `// i18n-ignore: <why>` only for text that is not UI, never to get a PR green. Dates, numbers and currency only through `useFormat()`, `fmt()` or `intlLocale()`, never without a locale or with one written in the code. Email and push text lives only in `apps/api/src/emails` (`getT(locale)`); other server-side text the web app shows is a key and params (or written with the reader's `Words`), not English; `server-text-baseline.json` only goes down, a file it does not list stays at 0. Details: [docs/translations.md](docs/translations.md).
11. **No prompt change that no person saw.** Any change to text the assistant reads (system prompt `apps/agent/src/prompt.ts`, tool descriptions and results, collection steps in `apps/agent/src/collect/`, summary prompts) needs an explicit OK from a maintainer on the exact text before merge: show old and new text in the chat and quote it in the PR description, then wait for a clear yes to that text. Passing tests or call tests are not an OK; an OK for the idea is not an OK for the wording.

## Repo layout

- `apps/api`: Hono server. Better Auth at `/api/auth/*`, `POST /v1/actions/<name>` (the one write path), `GET /v1/shape/<table>` (read sync via Electric, workspace-filtered), handlers in `src/handlers.ts`.
- `apps/web`: Vite React SPA (local store + outbox). `apps/agent`: LiveKit voice agent and the call simulator; talks to the API only through `src/api-client.ts`.
- `packages/db`: Drizzle schema + migrations; row types in `src/types.ts`, shared with the browser. Columns are snake_case in TS too.
- `packages/actions`: the registry. Most actions are a declarative `patch` (optimistic in the browser, a workspace-scoped UPDATE on the server); the rest get a handler in `apps/api`.
- `packages/sync`: local store, IndexedDB outbox, `ReadSyncAdapter` (Electric). `packages/telephony`: `TelephonyProvider` + adapters (Telnyx, the default; Twilio; `dev`), selected by `TELEPHONY_PROVIDER`.
- Admin area ([docs/architecture.md](docs/architecture.md) §12): instance admins (`instance:admin`), `GET /v1/admin/*`, provider keys in `provider_settings` encrypted with `SECRETS_KEY`, providers described in `packages/actions/src/admin.ts`. Keys belong there, not in `.env` (`.env` holds only what the install needs before the database). An action that takes a secret lists the field under `sensitive` so the command log stores it redacted.
- `prototypes/inbox-html`: reference UI.

Workspace = Better Auth organization; every synced table has `workspace_id` and a `version` bumped by trigger.

## Commands

The ones every session needs; everything else (voice, recordings, call and load tests, self-host stack, dev mode, snapshots, seeding) is in [docs/commands.md](docs/commands.md).

- `pnpm install`, then `scripts/setup.sh` (`.env` with random secrets; a plain copy of `.env.example` leaves `SECRETS_KEY` empty).
- `pnpm db:up` (Postgres 5433, Electric 3001), `pnpm db:migrate`, `pnpm db:seed` (prints the demo login).
- `pnpm dev` (API 3100, web 5173), `pnpm typecheck`, `pnpm lint`, `pnpm test` (API tests need `pnpm db:up`).
- `pnpm format <files>`: only the files you touched, never the whole repo.
- Schema change: edit `packages/db/src/schema.ts`, `pnpm db:generate`, `pnpm db:migrate`.
- Simulate a call without provider keys: `pnpm --filter @linedesk/agent simulate`.

## Tasks

Work starts from a GitHub issue; for anything bigger, agree on the approach in the issue first ([CONTRIBUTING.md](CONTRIBUTING.md)). Before calling a change done, check it in the running app (browser, screenshots), not only with tests.

## Git workflow

- Trunk-based: the trunk is `main`. Work on a short-lived branch, open a PR into the trunk, merge (squash). One logical change per PR.
- PRs need passing typecheck, lint and image build (`.github/workflows/ci.yml`; details in [docs/ci.md](docs/ci.md)), and in the public repository signed-off commits (DCO, CONTRIBUTING.md). Speed first: don't run or wait for the test suite during development; it runs on every push to the trunk. Run single tests locally when you want to. Still add tests for new actions (handler + `apply` + permission) and for adapters (contract tests).
- After a merge, watch the Tests run (`tests.yml`) until it is green. A red run comments on the merged PR: fix it in a new PR into the trunk before the next release (or answer there why your change did not cause it).
- Changes to auth, permissions, tenancy, secrets or deploy get one independent security review before merging.

## Code style

- Small, focused functions; clear names; handle errors explicitly; validate input at boundaries (Zod).
- Follow existing patterns; prefer editing over adding files; no speculative abstractions (YAGNI).
- Only erasable TypeScript syntax (the images run `.ts` directly on Node): no enums, namespaces or constructor parameter properties (`erasableSyntaxOnly` makes `pnpm typecheck` fail on them); relative imports keep the `.ts` extension.
- A new API test file that sets provider keys, instance settings, instance admins or stored provider tests goes into `INSTANCE_WIDE_FILES` (`apps/api/vitest.config.ts`).
- UI follows the design principles: black primary, green only for live/unread, red only for urgent/missed, shadows for raised cards, every action keyboard-reachable with a tooltip showing its key.
- Every pointer to another place in the app is a link via `AppLink` (`apps/web/src/ui/AppLink.tsx`; in a message a tag rendered with `appLink`/`adminLink`), one look everywhere ([docs/design-principles.md](docs/design-principles.md), rule 18).
- Keep the machine usable: stop servers and containers you started when you pause or finish; run the API test suite file by file if the machine is busy.
