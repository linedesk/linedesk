// The rule for BETTER_AUTH_SECRET, also checked where a start skips docker/api-entrypoint.sh (a PaaS start command,
// `docker run --entrypoint`, `node apps/api/src/server.ts` with NODE_ENV=production).

export const MIN_AUTH_SECRET_LENGTH = 32

// i18n-ignore: a startup log line for the operator (stderr before the API serves), never shown in the web app
const howToSet = 'Put a long random string in .env, e.g. the output of: openssl rand -base64 32'

/**
 * Why the install's sign-in secret must not be used, or null when it is fine. Outside production only a missing secret
 * (Better Auth would fall back to AUTH_SECRET or its public default) and BETTER_AUTH_SECRETS are refused; the
 * placeholder and a short secret only where NODE_ENV=production.
 */
export function authSecretProblem(env: Record<string, string | undefined>, { production = false } = {}): string | null {
  // Better Auth prefers the versioned secrets over BETTER_AUTH_SECRET; Linedesk checks and documents only the one.
  if (env.BETTER_AUTH_SECRETS)
    return 'BETTER_AUTH_SECRETS is set. Linedesk uses only BETTER_AUTH_SECRET: remove BETTER_AUTH_SECRETS from .env.'
  const secret = env.BETTER_AUTH_SECRET
  if (!secret || (production && secret.startsWith('change-me'))) return `BETTER_AUTH_SECRET is not set. ${howToSet}`
  if (!production) return null
  if (secret.length < MIN_AUTH_SECRET_LENGTH)
    return `BETTER_AUTH_SECRET is shorter than ${MIN_AUTH_SECRET_LENGTH} characters. ${howToSet}`
  return null
}
