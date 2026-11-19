# CI

What runs on a pull request and on the trunk, and how to reproduce it locally. In the public repository every job runs
on GitHub-hosted runners (`ubuntu-24.04`); the maintainers' own copy runs the same jobs on Depot runners (the
`runs-on` expression in each workflow picks one by repository). Deploys to the maintainers' servers are not part of the
public repository.

| Workflow | Trigger | Jobs |
| --- | --- | --- |
| `ci.yml` | every pull request, every push to `master-dev` or `master-prod`, by hand (Actions → CI → Run workflow) | `check`: install, typecheck, lint, `pnpm i18n:check` (missing translations allowed), the scrub tests, `pnpm db:check-journal` (the migrations journal's `idx` and `when` strictly increase) and the Zapier app's checks. `images`: builds the api, web and proxy images (self-hosting must work at every commit). `secrets`: gitleaks over the history of the tested commit. Pull requests into `master-prod` also run `release-source` and `release-translations` (releases, see "Branches"). |
| `tests.yml` | every push to `master-dev`, by hand (Actions → Tests → Run workflow) | `test`: the full test suite with Postgres, in four parallel parts. `report`: a red run on `master-dev` comments on the merged PR. |
| `dco.yml` | every pull request (public repository) | `sign-off`: every commit of the pull request has a `Signed-off-by:` line (CONTRIBUTING.md, "Developer Certificate of Origin"). |

## Branches

- `master-dev` is the trunk. Work on a short-lived branch, open a pull request into `master-dev`; it is squash-merged.
- `master-prod` is what the hosted service runs. It only takes a pull request from `master-dev` (a release), opened
  by a maintainer; before it, the release translation pass (docs/translations.md) brings every language up to date.

## Tests

Pull requests wait only for `ci.yml` (typecheck, lint, the language check, the scrub tests, the images, secrets; about
a minute). The full suite runs on every push to `master-dev`; a red run comments on the PR that was merged, and
whoever merged it fixes it in a new PR. Run the tests that touch your change locally before you open the PR:
`pnpm test`, or `pnpm --filter @linedesk/api exec vitest run <file>` (the API tests need `pnpm db:up`).

Postgres for the tests runs with `max_locks_per_transaction=1024`: the API tests' global setup creates and migrates
about 26 databases at the same time, which fails with "out of shared memory" (53200) at the default of 64. `pnpm db:up`
starts the dev Postgres that way (`docker-compose.ports.yml`). To run the API shards like CI against your own
container: `docker run -d --name <unique> -p 127.0.0.1:<free port>:5432 -e POSTGRES_USER=linedesk -e
POSTGRES_PASSWORD=linedesk -e POSTGRES_DB=linedesk_test <image of docker-compose.yml> postgres -c
max_locks_per_transaction=1024`, then `CI=true TEST_DATABASE_URL=postgres://linedesk:linedesk@127.0.0.1:<port>/linedesk_test
pnpm --filter @linedesk/api exec vitest run --shard=1/3`.

## Secret scanning

The `secrets` job runs [gitleaks](https://github.com/gitleaks/gitleaks) over the whole history of the tested
commit on every pull request and push to `master-dev` and `master-prod` (`--log-opts=HEAD`: for a pull request that is
`master-dev` plus the branch's own commits, never other branches). It uses gitleaks' default rules plus the exception
in `.gitleaks.toml`. The binary is pinned by version and SHA-256 in `ci.yml`; to update, change both values from the
release's `checksums.txt`.

- Fake keys in tests: put `0123456789` in the value (`'bucket-secret-0123456789'`); that is the only exception.
- Run it locally before pushing: `brew install gitleaks`, then `gitleaks git --redact --log-opts=HEAD .`
- A finding on the PR: if it is a real key, revoke it at the provider first, then remove it from the branch's
  history (squash merge alone does not remove it from the PR's commits). If it is a false positive, change the
  test value.

## Hardening

- `.github/CODEOWNERS`: changes to `.github/` (workflows, CODEOWNERS) and `.gitleaks.toml` request a review from a
  maintainer.
- Every `actions/checkout` sets `persist-credentials: false`, so the job token is not left in `.git/config`. No
  job pushes or fetches after the checkout; a job that needs to must pass a token explicitly.
- No workflow uses `pull_request_target`, and pull request jobs get no secrets, so a pull request from a fork runs
  with read-only access.
