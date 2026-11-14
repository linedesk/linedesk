// Environment access for the agent: fail early and name what is missing.

/** The agent the SIP dispatch rule and test calls send business calls to. */
export const AGENT_NAME = 'linedesk'
/**
 * The name this worker registers under: AGENT_NAME, unless the AGENT_NAME env var names another one. Only the load test
 * sets it, for the worker that plays the test callers, so they are not counted in the business worker's memory.
 */
export const workerAgentName = () => process.env.AGENT_NAME || AGENT_NAME

/** The secret in .env.example and docker-compose.yml; fine on localhost, never anywhere else. */
export const DEV_LIVEKIT_SECRET = 'devsecret-change-me-at-least-32-chars'

export const livekitEnv = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const

type Env = Record<string, string | undefined>

/** Returns the named variables, or throws listing every one that is not set. */
export function requireEnv<K extends string>(names: readonly K[], env: Env = process.env): Record<K, string> {
  const missing = names.filter(name => !env[name])
  if (missing.length) throw new Error(`Missing environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Set ${missing.length > 1 ? 'them' : 'it'} in .env (see .env.example).`)
  return Object.fromEntries(names.map(name => [name, env[name]!])) as Record<K, string>
}

const isLocalUrl = (url: string) => /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)

/** LiveKit settings. Refuses the development secret outside local development. */
export function requireLivekitEnv(env: Env = process.env) {
  const livekit = requireEnv(livekitEnv, env)
  const development = env.NODE_ENV !== 'production' && isLocalUrl(livekit.LIVEKIT_URL)
  if (livekit.LIVEKIT_API_SECRET === DEV_LIVEKIT_SECRET && !development) {
    throw new Error('LIVEKIT_API_SECRET is still the development default. Set your own secret (at least 32 characters) in .env and in the LiveKit server config.')
  }
  return livekit
}

/** LiveKit's API is served over http(s) on the same host as the ws(s) URL. */
export const livekitHttpUrl = (wsUrl: string) => wsUrl.replace(/^ws/, 'http')

/** Runs a script's main function; prints the error message instead of a stack trace. */
export function runScript(main: () => Promise<void>) {
  main().catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
