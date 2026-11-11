# Live mode (test server)

Live mode runs `api`, `web` and `agent` from a git checkout on the server instead of from built images. A change to the code shows within seconds, and an update is a fast-forward of that checkout instead of an image build. It is for a test server only: production and self-hosting stay on images (`docker-compose.yml` alone, the default).

| | Image mode (default) | Live mode |
|---|---|---|
| Code | baked into images | the checkout, mounted at `/app` |
| Update | build, then start-first replacement (`scripts/deploy.sh`) | `git merge --ff-only` (`scripts/deploy-live.sh`), seconds |
| Web | built SPA behind Caddy | Vite dev server with hot reload behind the same Caddy |
| API | restarted by a deploy, without downtime | restarts in place on a change (~2 s); Caddy holds and retries requests |
| Agent | new worker first, old one finishes its calls | restarts on a change to `apps/agent` or `packages`; **running calls end** |
| Dependencies | installed in the image | one volume (`live_node_modules`); `pnpm install --frozen-lockfile` when `pnpm-lock.yaml` changes |

Everything else (Postgres and its volume, Electric, the proxy, LiveKit, SIP, egress, Redis, `.env`) is the same in both modes, so switching keeps all data.

## How it works

- `docker-compose.live.yml` overrides the three services: one small image (`Dockerfile` target `live`: Node and pnpm, no code), the checkout mounted at `/app`, `node_modules` in a volume, and `docker/live-run.mjs` as the entry point.
- `docker/live-run.mjs` installs the dependencies when the lockfile changed (one service at a time, under a lock; the first install takes a few minutes and ~0.5 GB of memory), starts the service, restarts it when a watched directory changes (api: `apps/api/src`, `packages`; agent: `apps/agent/src`, `packages`; changes to `*.test.ts` are ignored) and starts it again after a crash. A restart sends SIGTERM and SIGKILL 5 s later. `docker compose stop` still gives the agent its full stop grace period.
- The API runs `docker/api-entrypoint.sh` on every start, so new migrations are applied when they arrive. Expand/contract still applies (docs/architecture.md §11).
- Web: Vite takes the public URL from `PUBLIC_URL` and opens its hot-reload WebSocket there (`wss://<host>:443` behind https), so the page and the API keep one origin and the session cookie works. It serves only the web app and the packages it is built from (`server.fs.allow`), never server code or `.env`.
- The proxy skips a container that failed a request for 1 s instead of 10 s (`LINEDESK_PROXY_FAIL_DURATION`), because in live mode the API restarts on the same address.
- A new `docker/live-run.mjs` restarts its containers by itself; a new Caddyfile is reloaded by `scripts/deploy.sh`; a change to the compose files is applied by the next deploy (start-first for api and web, like image mode).

## Switching

In the `.env` of the checkout the stack runs from:

```
LINEDESK_MODE=live
COMPOSE_FILE=docker-compose.yml${LINEDESK_MODE:+:docker-compose.$LINEDESK_MODE.yml}
```

then `scripts/deploy.sh`. The `COMPOSE_FILE` line stays in both modes; it adds `docker-compose.live.yml` only while `LINEDESK_MODE=live`, so plain `docker compose ...` commands always match the mode. Back to images: `LINEDESK_MODE=` (empty) and `scripts/deploy.sh`, which builds the images and replaces the live containers start-first. The `live_node_modules` volume can then be removed (`docker volume rm <project>_live_node_modules`, ~0.75 GB).

## Updates

`scripts/deploy.sh` in live mode hands over to `scripts/deploy-live.sh [<commit>]`, which:

1. refuses (logs why, exits 1, touches nothing) when the checkout is not on `main`, has local changes or untracked files, or cannot fast-forward;
2. fetches `origin main` and fast-forwards to the commit (default: the newest `origin/main`);
3. runs `scripts/deploy.sh --no-build`: recreates only services whose compose settings changed and reloads a new Caddyfile. The code itself is picked up by the watchers.

The checkout needs read access to the repository (on the test server: a read-only deploy key). The GitHub workflow (`.github/workflows/deploy-staging.yml`) stays the same; with the repository variable `STAGING_MODE=live` it deploys every green main without waiting for the 10-minute gap.

## Coding on the server

One session edits the server's checkout at a time; everyone else keeps working in local worktrees and PRs.

```sh
ssh -A <server>                      # -A: your own key pushes; nothing is stored on the server
cd <checkout>                        # the directory the stack runs from
git switch -c tim/<topic>            # from now on deploys refuse (not on main) until you switch back
# edit: the web app hot-reloads, the API restarts in ~2 s, the agent restarts (ends running calls)
docker compose logs -f api           # or web, agent
docker compose exec api pnpm typecheck
docker compose exec agent node src/call-test.ts <scenario>
git -c user.name="…" -c user.email="…" commit -am "…"
git push git@github.com:<owner>/<repo>.git tim/<topic>   # with the forwarded key; origin is read-only
git switch main                      # clean again: the next deploy fast-forwards
```

Then open the PR as usual. When it is merged, the next deploy brings it back through `main`. Without agent forwarding, fetch the branch from your machine instead: `git fetch ssh://<server><checkout> tim/<topic>` and push from there.

While the checkout is on a branch or has uncommitted changes, every deploy fails with the reason in the log (and the GitHub run is red); that is intended, nothing on the server is overwritten. Don't run `pnpm install` on the host: the dependencies belong to the containers (`docker compose exec api pnpm …`).

## Resources

Measured on a local stack (agent with one warm process, after a test call and browsing the app):

| Process | Image mode | Live mode |
|---|---|---|
| api | ~100 MB | ~120 MB + runner ~50 MB |
| web | ~25 MB (Caddy) | ~125 MB (Vite) + runner ~45 MB |
| agent | ~280–500 MB | same + runner ~45 MB |
| `pnpm install` (once, then on lockfile changes, one container at a time) | in the image build | ~480 MB on 2 cores (~1.1 GB on 8+) |

So live mode needs about 0.3 GB more steady memory, plus ~0.5 GB while it installs. Limits (`docker-compose.live.yml`, override with `LINEDESK_LIVE_*_MEM` / `_CPUS`): api 768 MB / 1 CPU, web 768 MB / 1 CPU, agent 896 MB on the voice cores. The volume takes ~0.75 GB of disk.
