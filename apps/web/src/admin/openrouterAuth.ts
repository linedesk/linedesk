// "Connect with OpenRouter": OpenRouter's OAuth PKCE flow (https://openrouter.ai/docs, "OAuth PKCE"),
// which needs no app registration. The browser makes a code verifier and its S256 challenge, sends the
// admin to openrouter.ai/auth, and on the way back trades the code for a key. The verifier lives in
// sessionStorage only until the return; the key goes straight into provider.setKeys (sensitive,
// redacted in the command log) and is never kept in the browser.

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth'
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys'
const PENDING_KEY = 'linedesk.openrouter.pending'
const RETURN_KEY = 'linedesk.openrouter.return'

/** What the admin was doing when they left for OpenRouter. */
type Pending = { verifier: string; state: string }
/** What came back: a code to exchange (with its verifier), or why there is none. */
export type OpenRouterReturn = { code: string; verifier: string } | { error: string }

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** 32 random bytes, base64url: a verifier of 43 characters, as PKCE asks. */
export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

/** The S256 challenge: base64url of the SHA-256 of the verifier. */
export async function challengeOf(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(hash))
}

/** Where OpenRouter sends the admin back: the app's root; `captureOpenRouterReturn` takes it from there. */
export const callbackUrl = (origin: string) => `${origin}/`

export function authUrl(origin: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    callback_url: callbackUrl(origin),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${OPENROUTER_AUTH_URL}?${params}`
}

/** Leaves for OpenRouter. Returns the address it went to (for tests). */
export async function startOpenRouterConnect(
  storage: Storage = sessionStorage,
  go: (url: string) => void = url => window.location.assign(url),
  origin = window.location.origin,
): Promise<string> {
  const pending: Pending = { verifier: randomToken(), state: randomToken() }
  storage.setItem(PENDING_KEY, JSON.stringify(pending))
  storage.removeItem(RETURN_KEY)
  const url = authUrl(origin, await challengeOf(pending.verifier), pending.state)
  go(url)
  return url
}

function readJson<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/**
 * At startup: when the address carries OpenRouter's answer to a connect this tab started, keep it
 * for the Providers page, clear the address and go there. Returns the hash to open, or null.
 */
export function captureOpenRouterReturn(search: string, storage: Storage = sessionStorage): string | null {
  const pending = readJson<Pending>(storage, PENDING_KEY)
  if (!pending) return null
  const params = new URLSearchParams(search)
  const code = params.get('code')
  // The verifier is good for this one return only: any other page load (Back from OpenRouter, a
  // reload) drops it too.
  storage.removeItem(PENDING_KEY)
  if (!code && !params.has('error') && !params.has('state')) return null
  const result: OpenRouterReturn =
    params.get('state') !== pending.state
      ? { error: "OpenRouter's answer didn't match this sign-in. Try again." }
      : code
        ? { code, verifier: pending.verifier }
        : { error: 'Connecting with OpenRouter was cancelled.' }
  storage.setItem(RETURN_KEY, JSON.stringify(result))
  return '#admin/providers/answering'
}

/** The answer waiting for the Providers page, if any. Reading leaves it; `clearOpenRouterReturn` removes it. */
export const peekOpenRouterReturn = (storage: Storage = sessionStorage) =>
  readJson<OpenRouterReturn>(storage, RETURN_KEY)
export const clearOpenRouterReturn = (storage: Storage = sessionStorage) => storage.removeItem(RETURN_KEY)

/** Trades the code for a key. Throws with a short reason. */
export async function exchangeCode(code: string, verifier: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(OPENROUTER_KEYS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    })
  } catch {
    throw new Error("Couldn't reach OpenRouter. Try again.")
  }
  const body = (await res.json().catch(() => null)) as { key?: unknown } | null
  if (res.ok && typeof body?.key === 'string' && body.key) return body.key
  throw new Error(
    res.status === 400 || res.status === 403
      ? 'OpenRouter did not accept the sign-in, or it expired. Try again.'
      : `OpenRouter answered ${res.status}. Try again.`,
  )
}
