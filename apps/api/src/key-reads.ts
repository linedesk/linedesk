// What a personal key (personal-keys.ts) reads besides actions (LIN-339): the GET routes of the web app it may call,
// each answering as for its maker. Every other /v1 route answers 403 to a personal key (app.ts): the browser-only ones
// are listed with their reason, so the coverage test (test/ui-parity.test.ts) knows every route the web app calls.
// The table rows the app syncs are read with the `records.list` action, not GET /v1/shape (Electric, browser only).

export type KeyReadRoute = {
  /** The route as app.ts declares it, `:name` for a path part. */
  path: string
  /** Offered by the MCP `api_get` tool (JSON answers only). */
  mcp: boolean
}

export const KEY_READ_ROUTES: readonly KeyReadRoute[] = [
  { path: '/v1/me', mcp: true },
  { path: '/v1/me/workspaces', mcp: true },
  { path: '/v1/me/actions', mcp: false },
  { path: '/v1/assistant/status', mcp: true },
  { path: '/v1/calendar/providers', mcp: true },
  { path: '/v1/invitations/:id', mcp: true },
  { path: '/v1/admin/workspaces', mcp: true },
  { path: '/v1/admin/users', mcp: true },
  { path: '/v1/admin/workspaces/:id/members', mcp: true },
  { path: '/v1/admin/usage', mcp: true },
  { path: '/v1/admin/audit', mcp: true },
  { path: '/v1/admin/overview', mcp: true },
  { path: '/v1/admin/latency', mcp: true },
  { path: '/v1/admin/onboarding', mcp: true },
  { path: '/v1/admin/health', mcp: true },
  { path: '/v1/admin/providers', mcp: true },
  { path: '/v1/admin/agent-setup', mcp: true },
  { path: '/v1/admin/install-setup', mcp: true },
  { path: '/v1/admin/setup-checklist', mcp: true },
  { path: '/v1/admin/system', mcp: true },
  { path: '/v1/admin/call-reviews', mcp: true },
  // Audio: over HTTP (the CLI's `get`), not as an MCP answer.
  { path: '/v1/calls/:id/recording', mcp: false },
  { path: '/v1/voices/preview/:voiceId', mcp: false },
  { path: '/v1/workspace-icons/:file', mcp: false },
  { path: '/v1/avatars/:file', mcp: false },
]

const SESSION = 'needs a signed-in browser session'
const SETUP_LINKS = 'setup links are made and read signed in as yourself'
/** Routes the web app calls that a personal key does not, with the reason (or the way a key does the same). */
export const BROWSER_ONLY_ROUTES: ReadonlyMap<string, string> = new Map([
  ['/v1/shape/:table', 'read sync streams tables to the browser; a key reads rows with the records.list action'],
  ['/v1/workspaces', 'a key makes a workspace with the workspace.create action'],
  ['/v1/workspaces/country-hint', SESSION],
  ['/v1/account/password', SESSION],
  ['/v1/account/authenticator/:step', SESSION],
  ['/v1/impersonation/start', SESSION],
  ['/v1/impersonation/stop', SESSION],
  ['/v1/workspace/agent-setup', SETUP_LINKS],
  ['/v1/partner/agent-setup', SETUP_LINKS],
  ['/v1/calendar/callback/:provider', 'the calendar provider sends the browser here'],
  ['/v1/apps/callback/:app', 'the connected app sends the browser here'],
  ['/v1/setup', 'install setup before the first account'],
  ['/v1/sign-in-link/:step', "public, the sign-in email's button"],
  ['/v1/openapi.json', 'public: the API description'],
  ['/v1/auth-methods', 'public, before sign-in'],
  ['/v1/branding', 'public, before sign-in'],
  ['/v1/branding/manifest.webmanifest', 'public, before sign-in'],
  ['/v1/branding/logo.png', 'public, before sign-in'],
  ['/v1/signup/config', 'public, the sign-up page before sign-in'],
  ['/v1/signup/code', 'public, the sign-up page asks for an email code'],
  ['/v1/signup', 'the sign-up page, signed in with an email code (docs/billing.md §3.1)'],
])

const toPattern = (path: string) => new RegExp(`^${path.replace(/:[A-Za-z]+/g, '[^/]+')}$`)
const PATTERNS = KEY_READ_ROUTES.map(route => ({ route, pattern: toPattern(route.path) }))

/** The key-readable route a request path (query allowed) is, or null. */
export function keyReadRoute(path: string): KeyReadRoute | null {
  const bare = path.split('?')[0]!.split('#')[0]!
  if (bare.includes('..') || bare.includes('//')) return null
  return PATTERNS.find(({ pattern }) => pattern.test(bare))?.route ?? null
}

/** Whether a personal key may make this /v1 request: an action, or a GET of a key-readable route. */
export const personalKeyMayRequest = (method: string, path: string) =>
  (method === 'POST' && /^\/v1\/actions\/[A-Za-z.]+$/.test(path)) || (method === 'GET' && keyReadRoute(path) !== null)
