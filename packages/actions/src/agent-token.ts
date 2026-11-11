// The install-wide agent token (AGENT_API_TOKEN): the rule the API and the voice agent both check at startup.

export const MIN_AGENT_TOKEN_LENGTH = 32
/** The value in .env.example: works on a developer machine, refused where NODE_ENV=production. */
export const DEV_AGENT_TOKEN = 'dev-agent-token-not-for-a-server-0000'

const howToSet = 'Set a random value in .env, e.g. the output of: openssl rand -hex 24'

/** Why `token` must not be used as the agent token, or null when it is fine. */
export function agentTokenProblem(token: string | undefined, { production = false } = {}): string | null {
  if (!token) return 'AGENT_API_TOKEN is not set.'
  if (token === 'change-me' || (production && token === DEV_AGENT_TOKEN))
    return `AGENT_API_TOKEN is still the placeholder from .env.example. ${howToSet}`
  if (token.length < MIN_AGENT_TOKEN_LENGTH)
    return `AGENT_API_TOKEN is shorter than ${MIN_AGENT_TOKEN_LENGTH} characters. ${howToSet}`
  return null
}
