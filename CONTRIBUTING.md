# Contributing to Linedesk

Thanks for helping. Linedesk is an AI front desk for businesses: an assistant answers calls, sums them up and books appointments, and a keyboard-first inbox shows what needs a person.

## Before you start

- Bugs and small fixes: open a pull request directly.
- Anything bigger (a new feature, a new provider, a schema change): open an issue first so we can agree on the approach before you spend time on it.
- Security problems: never in a public issue. See [SECURITY.md](SECURITY.md).
- Be kind. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies everywhere in the project.

## Set up

Requirements: Node 22.18 or newer (it runs the TypeScript files directly), pnpm 10, Docker.

```sh
pnpm install
scripts/setup.sh  # .env with random secrets, SECRETS_KEY included (a plain copy of .env.example leaves it empty)
pnpm db:up        # Postgres on 5433, Electric on 3001
pnpm db:migrate
pnpm db:seed      # prints the demo sign-in
pnpm dev          # API on 3100, web app on 5173
```

The demo sign-in uses a password. Email codes go nowhere until email is connected (Admin › Providers): for local development uncomment `EMAIL_TO_LOG=true` in `.env` to print them to the API log. Sign-up is closed by default (`AUTH_SIGNUP_ENABLED=true` opens it).

Test data that every new local stack and worktree starts with: fill your account's workspace once (`pnpm db:seed -- --user you@example.com`), then `pnpm dev:snapshot`. A new database restores the snapshot (`~/.linedesk/dev-snapshot.dump`) by itself; `pnpm dev:restore --force` replaces an existing one. Details in [CLAUDE.md](CLAUDE.md) (commands).

Simulate a call without any provider keys: `pnpm --filter @linedesk/agent simulate` (dials the install's only number; otherwise add `--to <your Linedesk number>` or set `SIM_TO_NUMBER`). Real calls, voice and recordings: see [CLAUDE.md](CLAUDE.md) (commands) and [docs/architecture.md](docs/architecture.md).

## How the code is built

Read these first; pull requests that go against them are sent back:

- [docs/architecture.md](docs/architecture.md): how the system works.
- [docs/design-principles.md](docs/design-principles.md): UI rules.
- [CLAUDE.md](CLAUDE.md): conventions and commands (written for every contributor, human or not).

The rules that matter most:

1. **Every write goes through the action registry** (`packages/actions`, `defineAction()`). No REST route, MCP tool, UI mutation or agent tool may bypass it.
2. **Local-first.** The web app applies changes locally and sends them through the outbox; it never waits on the network for a user action.
3. **Providers behind interfaces.** Vendor SDKs live only in their adapter (telephony, speech, language model, calendar, sync).
4. **Postgres is the source of truth.** Schema changes only through Drizzle migrations (`pnpm db:generate`).
5. **Self-hosting works at every commit.** `docker compose up` keeps working; a new service needs a compose entry and its variables in `.env.example`.
6. **No secrets, keys, customer data or internal notes** in code, tests, fixtures or commits. Use the demo business (Brightwater Plumbing & Heating) and `555` phone numbers in examples.

## Pull requests

- Branch from `main`; one logical change per pull request. We squash on merge.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` must pass (CI runs all three). The API tests need Postgres (`pnpm db:up`).
- `pnpm format <files>` formats only the files you touched; please don't reformat unrelated code.
- New actions need tests (handler, `apply` and permission); new adapters need contract tests.
- UI changes: add a screenshot to the pull request and check the change in the running app, not only in tests.
- Describe what changed and why, and how you checked it. Product or architecture decisions go in the description under "Decisions".
