// Signed out anywhere means the sign-in page, on every screen (inbox, settings, Server admin, the setup pages). Every
// request of this app to its own API (`/v1/…`, same origin) is watched: a 401 there means the session may be gone
// (expired, signed out in another tab, the account disabled). The app then asks who is signed in (loadSession,
// App.tsx) and shows the sign-in page if nobody is, instead of an error line or a screen that cannot load.
// A 401 for another reason (a proxy in front, signed in without a workspace) changes nothing: the check decides.

type Listener = () => void

const listeners = new Set<Listener>()

/** Called whenever the API answered a request of this page with 401. */
export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether a request went to this app's own API: same origin, under `/v1/`. */
export function isOwnApi(input: RequestInfo | URL, origin: string): boolean {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? input : input.url
    const url = new URL(raw, origin)
    return url.origin === origin && url.pathname.startsWith('/v1/')
  } catch {
    return false
  }
}

let installed = false

/** Wraps `fetch` once, at start (main.tsx). Requests and answers pass through unchanged. */
export function watchUnauthorized(target: { fetch: typeof fetch; location: { origin: string } } = window) {
  if (installed) return
  installed = true
  const original = target.fetch.bind(target)
  target.fetch = async (input, init) => {
    const res = await original(input, init)
    if (res.status === 401 && isOwnApi(input, target.location.origin)) for (const listener of listeners) listener()
    return res
  }
}
