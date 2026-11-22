#!/bin/sh
# The compose project of this checkout's dev stack (`pnpm db:up`, `pnpm dev:snapshot`): COMPOSE_PROJECT_NAME from the
# environment or .env (scripts/dev-env.sh writes one), else linedesk-dev-<checkout folder>. Never the plain `linedesk`
# of docker-compose.yml, which a self-hosted install on the same machine uses for its stack and its data.
set -eu
cd "$(dirname "$0")/.."
name=${COMPOSE_PROJECT_NAME:-$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"'")}
if [ -z "$name" ]; then
  folder=$(basename "$(pwd)" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-' | sed 's/-*$//')
  name="linedesk-dev-$folder"
fi
printf '%s\n' "$name"
