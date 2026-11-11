#!/bin/sh
# docker compose for development: the whole-application file plus the local dev ports.
# .env.example supplies the development values (compose requires the LiveKit key and secret);
# .env, when it exists, overrides them. So `pnpm db:up` also works on a fresh checkout.
set -e
cd "$(dirname "$0")/.."
if [ -f .env ]; then
  exec docker compose --env-file .env.example --env-file .env -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.snapshot.yml "$@"
fi
exec docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.dev.yml -f docker-compose.snapshot.yml "$@"
