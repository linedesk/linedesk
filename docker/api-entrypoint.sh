#!/bin/sh
# Start the API container: check secrets, apply migrations, serve.
set -e

case "$BETTER_AUTH_SECRET" in
  "" | change-me*)
    echo "BETTER_AUTH_SECRET is not set. Put a long random string in .env, e.g. the output of: openssl rand -base64 32" >&2
    exit 1
    ;;
esac
case "$DATABASE_URL" in
  *://linedesk:linedesk@*)
    echo "POSTGRES_PASSWORD is not set. Put a random value in .env before the first start, e.g. the output of: openssl rand -hex 24" >&2
    exit 1
    ;;
esac
if [ -z "$ELECTRIC_SECRET" ] || [ "$ELECTRIC_SECRET" = "dev-electric-secret-change-me" ]; then
  echo "ELECTRIC_SECRET is not set or still the development value. Put a random value in .env, e.g. the output of: openssl rand -hex 24" >&2
  exit 1
fi
if [ "$LIVEKIT_API_SECRET" = "devsecret-change-me-at-least-32-chars" ]; then
  echo "LIVEKIT_API_KEY and LIVEKIT_API_SECRET are still the development values. Generate your own and put them in .env: docker run --rm livekit/livekit-server generate-keys" >&2
  exit 1
fi
# The placeholder token would let anyone act as the voice agent: treat it as not set (agent access off).
if [ "$AGENT_API_TOKEN" = "change-me" ]; then
  echo "AGENT_API_TOKEN is still the placeholder; agent access stays off until you set a random value in .env." >&2
  unset AGENT_API_TOKEN
fi

node packages/db/src/migrate.ts
exec node apps/api/src/server.ts
