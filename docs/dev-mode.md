# Dev mode (your machine or a test server)

Dev mode runs `api`, `web` and `agent` from a git checkout instead of from built images (it was called live mode until 2026-11; `scripts/deploy.sh` moves an old `.env` over by itself). A change to the code shows within seconds, and an update is a fast-forward of that checkout instead of an image build. It is for development and a test server only: production and self-hosting stay on images (`docker-compose.yml` alone, the default).

| | Image mode (default) | Dev mode |
|---|---|---|
| Code | baked into images | the checkout, mounted at `/app` |
| Update | build, then start-first replacement (`scripts/deploy.sh`) | `git merge --ff-only` (`scripts/deploy-dev.sh`), seconds |
| Web | built SPA behind Caddy | Vite dev server with hot reload behind the same Caddy |
| API | restarted by a deploy, without downtime | restarts in place on a change (~2 s); Caddy holds and retries requests |
| Agent | new worker first, old one finishes its calls | restarts on a change to `apps/agent` or `packages`; **running calls end** |
| Dependencies | installed in the image | one volume (`dev_node_modules`); `pnpm install --frozen-lockfile` when `pnpm-lock.yaml` changes |

Everything else (Postgres and its volume, Electric, the proxy, LiveKit, SIP, egress, Redis, `.env`) is the same in both modes, so switching keeps all data.

## How it works

- `docker-compose.dev.yml` overrides the three services: one small image (`Dockerfile` target `dev`: Node and pnpm, no code), the checkout mounted at `/app`, `node_modules` in a volume, and `docker/dev-run.mjs` as the entry point.
- `docker/dev-run.mjs` installs the dependencies when the lockfile changed (one service at a time, under a lock; the first install takes a few minutes and ~0.5 GB of memory), starts the service, restarts it when a watched directory changes (api: `apps/api/src`, `packages`; agent: `apps/agent/src`, `packages`; changes to `*.test.ts` are ignored) and starts it again after a crash. A restart sends SIGTERM and SIGKILL 5 s later. `docker compose stop` still gives the agent its full stop grace period.
- Web and agent never see the checkout's `.env` (an empty file is mounted over `/app/.env`); they get only the variables `docker-compose.yml` gives them, as in image mode. The agent's checkout is read-only, so it never installs (`LINEDESK_DEV_INSTALL=wait`: it waits until the api or web container has installed the lockfile); the process that handles caller audio and LLM tool calls cannot change the code the other services run.
- The API runs `docker/api-entrypoint.sh` on every start, so new migrations are applied when they arrive. Expand/contract still applies (docs/architecture.md §11).
- Web: Vite takes the public URL from `PUBLIC_URL` and opens its hot-reload WebSocket there (`wss://<host>:443` behind https), so the page and the API keep one origin and the session cookie works. It serves only the web app and the packages it is built from (`server.fs.allow`), never server code or `.env`.
- The proxy skips a container that failed a request for 1 s instead of 10 s (`LINEDESK_PROXY_FAIL_DURATION`), because in dev mode the API restarts on the same address.
- A new `docker/dev-run.mjs` restarts its containers by itself; a new Caddyfile is reloaded by `scripts/deploy.sh`; a change to the compose files is applied by the next deploy (start-first for api and web, like image mode).

## Switching

In the `.env` of the checkout the stack runs from:

```
LINEDESK_MODE=dev
COMPOSE_FILE=docker-compose.yml${LINEDESK_MODE:+:docker-compose.$LINEDESK_MODE.yml}
```

then `scripts/deploy.sh`. The `COMPOSE_FILE` line stays in both modes; it adds `docker-compose.dev.yml` only while `LINEDESK_MODE=dev`, so plain `docker compose ...` commands always match the mode. Back to images: `LINEDESK_MODE=` (empty) and `scripts/deploy.sh`, which builds the images and replaces the live containers start-first. The `dev_node_modules` volume can then be removed (`docker volume rm <project>_dev_node_modules`, ~0.75 GB).

## Updates

`scripts/deploy.sh` in dev mode hands over to `scripts/deploy-dev.sh [<commit>]`, which:

1. refuses (logs why, exits 1, touches nothing) when the checkout is not on its branch, has local changes or untracked files, or cannot fast-forward;
2. fetches the branch from `origin` and fast-forwards to the commit (default: the branch's newest commit);
3. runs `scripts/deploy.sh --no-build`: recreates only services whose compose settings changed and reloads a new Caddyfile. The code itself is picked up by the watchers.

The branch is `LINEDESK_DEV_BRANCH` in `.env` (default `master-dev`, the trunk; docs/ci.md, "Branches"); the checkout stays on it.

The checkout needs read access to the repository (on the test server: a read-only deploy key). The GitHub workflow (`.github/workflows/deploy-staging.yml`) stays the same and deploys every green `master-dev` at once; the repository variable `STAGING_MODE=dev` turns its image build off.

## Coding on the server

One session edits the server's checkout at a time; everyone else keeps working in local worktrees and PRs.

```sh
ssh -A <server>                      # -A: your own key pushes; nothing is stored on the server
cd <checkout>                        # the directory the stack runs from
git switch -c tim/<topic>            # from now on deploys refuse (not on its branch) until you switch back
# edit: the web app hot-reloads, the API restarts in ~2 s, the agent restarts (ends running calls)
docker compose logs -f api           # or web, agent
docker compose exec api pnpm typecheck
docker compose exec agent node src/call-test.ts <scenario>
git -c user.name="…" -c user.email="…" commit -am "…"
git push git@github.com:<owner>/<repo>.git tim/<topic>   # with the forwarded key; origin is read-only
git switch master-dev                # back to its branch (LINEDESK_DEV_BRANCH): the next deploy fast-forwards
```

Then open the PR as usual. When it is merged, the next deploy brings it back through `master-dev`. Without agent forwarding, fetch the branch from your machine instead: `git fetch ssh://<server><checkout> tim/<topic>` and push from there.

While the checkout is on a branch or has uncommitted changes, every deploy fails with the reason in the log (and the GitHub run is red); that is intended, nothing on the server is overwritten. Don't run `pnpm install` on the host: the dependencies belong to the containers (`docker compose exec api pnpm …`).

## Resources

Measured on a local stack (agent with one warm process, after a test call and browsing the app):

| Process | Image mode | Dev mode |
|---|---|---|
| api | ~100 MB | ~120 MB + runner ~50 MB |
| web | ~25 MB (Caddy) | ~125 MB (Vite) + runner ~45 MB |
| agent | ~280–500 MB | same + runner ~45 MB |
| `pnpm install` (once, then on lockfile changes, one container at a time) | in the image build | ~480 MB on 2 cores (~1.1 GB on 8+) |

So dev mode needs about 0.3 GB more steady memory, plus ~0.5 GB while it installs. Limits (`docker-compose.dev.yml`, override with `LINEDESK_DEV_*_MEM` / `_CPUS`): api 768 MB / 1 CPU, web 768 MB / 1 CPU, agent 896 MB on the voice cores. The volume takes ~0.75 GB of disk.
