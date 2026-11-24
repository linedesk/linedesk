# Contributing to Linedesk

Thanks for helping. Linedesk is an AI front desk for businesses: an assistant answers calls, sums them up and books appointments, and a keyboard-first inbox shows what needs a person.

> **How pull requests land:** the maintainers develop Linedesk in their own copy of this repository, so we never press "Merge" here. When we accept your pull request, we apply it to our copy with your authorship and sign-off, close it with a comment that says so, and it reaches `main` with the next release. Details: [What happens after review](#what-happens-after-review).

## Before you start

- Bugs and small fixes: open a pull request directly.
- Anything bigger (a new feature, a new provider, a schema change): open an issue first so we can agree on the approach before you spend time on it.
- Security problems: never in a public issue. See [SECURITY.md](SECURITY.md).
- Questions and help with an install: see [SUPPORT.md](SUPPORT.md). What we plan next: [ROADMAP.md](ROADMAP.md).
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

The demo sign-in uses a password. Email codes go nowhere until email is connected (Server admin › Providers): for local development uncomment `EMAIL_TO_LOG=true` in `.env` to print them to the API log. There is no open sign-up: people get an account through an invitation or a server admin.

Test data that every new local stack and worktree starts with: fill your account's workspace once (`pnpm db:seed -- --user you@example.com`), then `pnpm dev:snapshot`. A new database restores the snapshot (`~/.linedesk/dev-snapshot.dump`) by itself; `pnpm dev:restore --force` replaces an existing one. Details in [docs/commands.md](docs/commands.md).

Simulate a call without any provider keys: `pnpm --filter @linedesk/agent simulate` (dials the install's only number; otherwise add `--to <your Linedesk number>` or set `SIM_TO_NUMBER`). Real calls, voice and recordings: see [docs/commands.md](docs/commands.md) and [docs/architecture.md](docs/architecture.md).

## How the code is built

Read these first; pull requests that go against them are sent back:

- [docs/architecture.md](docs/architecture.md): how the system works.
- [docs/design-principles.md](docs/design-principles.md): UI rules.
- [CLAUDE.md](CLAUDE.md) (also `AGENTS.md`): conventions and the main commands (written for every contributor, human or not); all commands in [docs/commands.md](docs/commands.md).

The rules that matter most:

1. **Every write goes through the action registry** (`packages/actions`, `defineAction()`). No REST route, MCP tool, UI mutation or agent tool may bypass it.
2. **Local-first.** The web app applies changes locally and sends them through the outbox; it never waits on the network for a user action.
3. **Providers behind interfaces.** Vendor SDKs live only in their adapter (telephony, speech, language model, calendar, sync).
4. **Postgres is the source of truth.** Schema changes only through Drizzle migrations (`pnpm db:generate`).
5. **Self-hosting works at every commit.** `docker compose up` keeps working; a new service needs a compose entry and its variables in `.env.example`.
6. **No secrets, keys, customer data or internal notes** in code, tests, fixtures or commits. Use the demo business (Brightwater Plumbing & Heating) and `555` phone numbers in examples.

## Translations

English is the source; the other languages are translated before each release (with AI, screen by screen) and improved by people. In a code change, add new text only to `packages/i18n/locales/en/` and use it with `t()`; never edit other languages in the same pull request. To fix a translation, edit `packages/i18n/locales/<locale>/`, record it with `pnpm i18n:lock --by human --locale <locale> --prefix <key>` and open a pull request: your wording is kept from then on. Details, and how to ask for a new language: [docs/translations.md](docs/translations.md).

## Pull requests

- Branch from `main` and open the pull request against `main`; one logical change per pull request.
- `pnpm typecheck` and `pnpm lint` must pass (CI runs both and builds the images). Run `pnpm test` (or the files you touched) locally; CI does not run the full suite on pull requests ([docs/ci.md](docs/ci.md)). The API tests need Postgres (`pnpm db:up`).
- Sign off every commit (`git commit -s`, see below); the `dco` check fails otherwise.
- `pnpm format <files>` formats only the files you touched; please don't reformat unrelated code.
- New actions need tests (handler, `apply` and permission); new adapters need contract tests.
- UI changes: add a screenshot to the pull request and check the change in the running app, not only in tests.
- Describe what changed and why, and how you checked it. Product or architecture decisions go in the description under "Decisions".

### What happens after review

The maintainers develop Linedesk in their own copy of the repository. Each release brings that copy's history to `main` by a merge, with every commit and its author. So an accepted pull request is not merged here directly: we apply your change to our copy, keeping your authorship and your sign-off, and close the pull request with a comment that says so. Your change then reaches `main` with the next release, and the release notes credit you.

## Developer Certificate of Origin

Linedesk is MIT-licensed, and we do not ask for a contributor licence agreement. Instead, every commit carries a sign-off: by adding it you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/) below, that you wrote the change or otherwise have the right to submit it under the project's licence.

Sign off with `git commit -s` (or `--signoff`). Git adds a line with the name and email of your git config, which must be your real name and an address you can be reached at (GitHub's `noreply` address is fine):

```
Signed-off-by: Jane Doe <jane@example.com>
```

Forgot it? `git commit --amend -s --no-edit` fixes the last commit; `git rebase --signoff main` signs off every commit of the branch. Then `git push --force-with-lease`. The `dco` check on the pull request lists each commit without a sign-off.

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
