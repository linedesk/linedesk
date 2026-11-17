#!/bin/sh
# Start the API container: check secrets, apply migrations, serve.
set -e

# Better Auth would prefer the versioned secrets over BETTER_AUTH_SECRET, unchecked (apps/api/src/auth-secret.ts).
if [ -n "$BETTER_AUTH_SECRETS" ]; then
  echo "BETTER_AUTH_SECRETS is set. Linedesk uses only BETTER_AUTH_SECRET: remove BETTER_AUTH_SECRETS from .env." >&2
  exit 1
fi
case "$BETTER_AUTH_SECRET" in
  "" | change-me*)
    echo "BETTER_AUTH_SECRET is not set. Put a long random string in .env, e.g. the output of: openssl rand -base64 32" >&2
    exit 1
    ;;
esac
if [ "${#BETTER_AUTH_SECRET}" -lt 32 ]; then
  echo "BETTER_AUTH_SECRET is shorter than 32 characters. Put a long random string in .env, e.g. the output of: openssl rand -base64 32" >&2
  exit 1
fi
case "$DATABASE_URL" in
  *://*:linedesk@*)
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
# A placeholder token would let anyone act as the voice agent: treat it as not set (agent access off).
# Any other token must be at least 32 characters (the API refuses to start otherwise).
case "$AGENT_API_TOKEN" in
  change-me | dev-agent-token-not-for-a-server-0000)
    echo "AGENT_API_TOKEN is still the placeholder; agent access stays off until you set a random value in .env (openssl rand -hex 24)." >&2
    unset AGENT_API_TOKEN
    ;;
esac
if [ -n "$AGENT_API_TOKEN" ] && [ "${#AGENT_API_TOKEN}" -lt 32 ]; then
  echo "AGENT_API_TOKEN is shorter than 32 characters. Put a random value in .env, e.g. the output of: openssl rand -hex 24" >&2
  exit 1
fi

node packages/db/src/migrate.ts
# Something starts the API again when it exits (Docker's restart policy, dev mode's runner): a change to
# the sign-in or email settings in the admin area restarts it to apply them (apps/api/src/instance-env.ts).
export LINEDESK_SELF_RESTART=1
exec node apps/api/src/server.ts
