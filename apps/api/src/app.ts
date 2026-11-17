import {
  actions,
  avatarUrlOf,
  CLONE_BODY_MAX_BYTES,
  inputSchema,
  IRREVERSIBLE_ACTIONS,
  openApiDocument,
  type WorkspaceCreateData,
  workspaceNameProblem,
} from '@linedesk/actions'
import { requestCountryHint } from './country-hint.ts'
import {
  member,
  organization,
  passkey,
  SIGNUP_COUNTRIES,
  user,
  workspace_icons,
  tableNames,
  type TableName,
} from '@linedesk/db'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

/** The largest action request body, except voice.clone (a recording). */
const ACTION_BODY_MAX_BYTES = 4 * 1024 * 1024
import { setFirstPassword } from './account.ts'
import { registerDemoCallRoutes } from './demo-call.ts'
import { API_KEY_REQUESTS_PER_MINUTE, apiKeyWithinLimit, isApiKey, keyOf, tooManyInvalidApiKeys } from './api-keys.ts'
import { shapeFilter } from './records.ts'
import { isPersonalKey } from './personal-keys.ts'
import { personalKeyMayRequest } from './key-reads.ts'
import { registerAdminRoutes } from './admin-routes.ts'
import { publicHealth } from './admin-overview.ts'
import { registerSetupUnsubscribeRoutes } from './setup-unsubscribe.ts'
import { registerEmailRecipientRoutes } from './email-recipients.ts'
import { registerStripeWebhookRoute } from './stripe-webhook.ts'
import { registerTestLookupRoute } from './test-lookup.ts'
import { addressBucket, clientIpHeaders, clientIpOf, withClientIp } from './client-ip.ts'
import { admitSignupCode, selfServeState, TURNSTILE_ACTION, turnstileKeys } from './self-serve.ts'
import { legalTerms } from './legal-terms.ts'
import { fromSignupPage } from './signup-gate.ts'
import { partnersOf } from './partners.ts'
import { MCP_MAX_BODY_BYTES, serveMcp } from './mcp.ts'
import { serveSetupMcp } from './setup-mcp.ts'
import { mcpCors, registerOAuthRoutes } from './oauth.ts'
import { setsUpByHand } from './install-setup.ts'
import { authMethods, currentAuthMethods } from './auth-methods.ts'
import { browserErrorReporting, errorReportingEnabled, type ReportedUser, reportError } from './error-reporting.ts'
import { billingRules } from './billing-rules.ts'
import { workspaceBillFacts } from './billing-page.ts'
import { currentBranding, manifestFor, readLogo } from './branding.ts'
import { profileChangedBy } from './team-member-edit.ts'
import { avatarVersionOf, readAvatarFor } from './user-avatar.ts'
import { iconUrlOf, readIconFor } from './workspace-icon.ts'
import { auth, TRUSTED_ORIGINS, WEB_ORIGIN } from './auth.ts'
import { refuseCrossSite } from './csrf.ts'
import { calendarCallback } from './calendar-callback.ts'
import { appCallback } from './app-callback.ts'
import { calendarToolModes, connectWays } from './calendar-tools.ts'
import {
  ACCOUNT_HEADER,
  accessLost,
  accountRefusal,
  clientOutdated,
  resolveActor,
  resolveCaller,
  tooManyInvalidAgentTokens,
  WORKSPACE_HEADER,
  WORKSPACE_STATE_HEADER,
  workspaceRefusal,
  type Actor,
} from './context.ts'
import { db } from './db.ts'
import { completeSetup, markSetupSignIn, SetupError, setupInput, setupNeeded, takeSetupSignIn } from './setup.ts'
import { COOKIE_ACTIONS } from './impersonation.ts'
import { NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { registerImpersonationRoutes } from './impersonation-routes.ts'
import { registerAuthenticatorRoutes } from './authenticator-routes.ts'
import { registerIntegrationRoutes } from './integration-routes.ts'
import { registerSignInLinkRoutes } from './sign-in-link-routes.ts'
import { AUTHENTICATOR_ROUTE_ACTIONS, hasAuthenticator } from './authenticator.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { previewInvitation } from './invitations.ts'
import { registerJobberWebhookRoute } from './jobber-webhook.ts'
import { ADMIN_CHECK_FIRST, mayCreateWorkspace, WORKSPACE_CREATION_CLOSED } from './workspace-creation.ts'
import { businessSetupFor, onboardingFor, phoneSetupFor } from './onboarding.ts'
import { firstUse } from './sample-calls.ts'
import { starPromptFor } from './star-prompt.ts'
import { voiceFailing } from './provider-failures.ts'
import { voiceReady } from './provider-settings.ts'
import { isSignedRecordingRequest, serveRecording, serveSignedRecording } from './recording-route.ts'
import { previewLanguage, servePreview } from './voices.ts'
import { runAction, runnableBy } from './run-action.ts'
import { brandingForActor, partnerLogoFor } from './partner-brand.ts'

const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://localhost:3001'
/** Electric refuses shape requests without it (docker-compose.yml); only the API has it. */
const ELECTRIC_SECRET = process.env.ELECTRIC_SECRET

let readSyncLoggedAt = 0
/** At most one line a minute while Electric can't be reached, so a dead read sync doesn't flood the log. */
function logReadSyncDown(err: Error) {
  if (Date.now() - readSyncLoggedAt < 60_000) return
  readSyncLoggedAt = Date.now()
  const cause = err.cause instanceof Error ? err.cause.message : err.message
  console.error(`read sync is unavailable: Electric at ${ELECTRIC_URL} can't be reached (${cause})`)
}

export const app = new Hono<{ Variables: { actor: Actor } }>()

/** Who an API error happened for (error-reporting.ts): the member (also behind an API key) with email and name; the agent by id. */
async function reportedUser(actor: Actor | undefined): Promise<ReportedUser | null> {
  if (!actor) return null
  const known: ReportedUser = { id: actor.actorId, workspaceId: actor.workspaceId }
  if (actor.role === 'agent') return known
  // The member's email and name, unless the database is what failed: then the id alone after a second.
  const lookup = db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, actor.actorId))
    .then(([member]) => ({ ...known, email: member?.email, name: member?.name }))
    .catch(() => known)
  const timeout = new Promise<ReportedUser>(resolve => setTimeout(() => resolve(known), 1000).unref())
  return Promise.race([lookup, timeout])
}

app.onError((err, c) => {
  console.error('request failed', err)
  // Reported in the background, so the 500 never waits on the member lookup.
  if (errorReportingEnabled()) void reportedUser(c.get('actor')).then(member => reportError(err, member))
  return c.json({ ok: false, error: 'internal error' }, 500)
})

app.get('/healthz', c => c.json({ ok: true }))
app.on(['GET', 'POST'], '/api/auth/*', c => auth.handler(withClientIp(c)))
// Public: one-click unsubscribe from setup emails, by a signed token instead of a session (setup-unsubscribe.ts).
registerSetupUnsubscribeRoutes(app)
// Public: confirming and stopping call emails to an address outside the team, by token (email-recipients.ts).
registerEmailRecipientRoutes(app)

// Before every /v1 route: a write signed in by the cookie only from the web app, as JSON (csrf.ts).
app.use('/v1/*', refuseCrossSite(TRUSTED_ORIGINS))

// Public: Stripe's webhook, checked by its signature, 404 while billing is off (stripe-webhook.ts).
registerStripeWebhookRoute(app)
// Public: Jobber's webhook (APP_DISCONNECT), checked by its signature, 404 while Jobber is not set up (jobber-webhook.ts).
registerJobberWebhookRoute(app)

// Public: the sign-in screen asks which methods this install offers, and whether it still needs its first admin.
app.get('/v1/auth-methods', async c =>
  c.json({ ...currentAuthMethods(), errorReporting: browserErrorReporting(), setupNeeded: await setupNeeded(db) }),
)

// Public: for uptime checks from outside, whether the voice agent is there to answer calls (admin-overview.ts).
app.get('/v1/health', c => {
  const { status, body } = publicHealth()
  c.header('cache-control', 'no-store')
  return c.json(body, status)
})

// Public: the product name, logo and color an instance admin set (branding.ts), for every page including sign-in. A
// signed-in session whose active workspace is a white-label partner's client gets the partner's brand instead
// (partner-brand.ts, S4); the web app asks again after switching workspace. Only the session cookie counts here, never
// an API key, so nothing about keys is learnt or counted on this public route.
app.get('/v1/branding', async c => {
  c.header('cache-control', 'private, no-cache')
  c.header('vary', 'cookie')
  const session = c.req.header('cookie') && !c.req.header('authorization')
  const actor = session ? await resolveActor(c.req.raw.headers, clientIpOf(c)).catch(() => null) : null
  return c.json((await brandingForActor(actor).catch(() => null)) ?? currentBranding())
})
app.get('/v1/branding/manifest.webmanifest', c => {
  c.header('cache-control', 'no-cache')
  c.header('content-type', 'application/manifest+json')
  return c.body(JSON.stringify(manifestFor()))
})
// The logo's address changes with every new logo (?v=), so it is cached for good.
app.get('/v1/branding/logo.png', async c => {
  const logo = await readLogo(db)
  if (!logo) return c.json({ ok: false, error: 'no logo' }, 404)
  c.header('content-type', 'image/png')
  c.header('cache-control', 'public, max-age=31536000, immutable')
  return c.body(new Uint8Array(logo))
})

// A white-label partner's logo (partner-brand.ts). A PNG checked like the install's (decodeLogo), never anything a
// browser would run. The approved one is public, its address changes with every new logo; a draft only for the
// partner's team and the instance admins, never cached.
app.get('/v1/branding/partners/:partnerId/logo.png', async c => {
  const found = await partnerLogoFor(c.req.param('partnerId'), c.req.query('v'), async () =>
    c.req.header('cookie') ? ((await auth.api.getSession({ headers: c.req.raw.headers }))?.user.id ?? null) : null,
  )
  if (!found) {
    // Never kept by a cache in front (a CDN caches a 404 on a .png for minutes): a draft probed anonymously, or a logo
    // approved a moment ago, is answered by this server again (security review of #1111, C-1).
    c.header('cache-control', 'no-store')
    return c.json({ ok: false, error: 'no logo' }, 404)
  }
  c.header('content-type', 'image/png')
  c.header('x-content-type-options', 'nosniff')
  c.header('content-security-policy', "default-src 'none'")
  c.header('cache-control', found.approved ? 'public, max-age=31536000, immutable' : 'private, no-store')
  return c.body(new Uint8Array(found.logo))
})

// Public, only while nobody has an account: the setup code from the server log makes the first admin (setup.ts).
// Whoever holds the setup code is the operator, so their passkey enrolment code comes straight back to this browser
// (`enrolment`, null when admins need no passkey): the first passkey needs no command on the server.
app.post('/v1/setup', async c => {
  const parsed = setupInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' }, 400)
  let made: Awaited<ReturnType<typeof completeSetup>>
  try {
    made = await completeSetup(db, parsed.data, clientIpOf(c))
  } catch (e) {
    if (e instanceof SetupError) return c.json({ ok: false, error: e.message }, e.status)
    throw e
  }
  const { userId, enrolment } = made
  // Signed in at once, with the password just chosen; no "new device" alert for this first sign-in.
  if (!authMethods.password) return c.json({ ok: true, signedIn: false, enrolment })
  markSetupSignIn(userId)
  try {
    const signedIn = await auth.api.signInEmail({
      body: { email: parsed.data.email, password: parsed.data.password },
      headers: c.req.raw.headers,
      asResponse: true,
    })
    if (!signedIn.ok) return signedIn
    // Better Auth's answer with its cookies, and the enrolment code added to its body.
    const body = (await signedIn.json().catch(() => ({}))) as Record<string, unknown>
    const headers = new Headers(signedIn.headers)
    headers.delete('content-length')
    headers.set('content-type', 'application/json')
    headers.set('cache-control', 'no-store')
    return new Response(JSON.stringify({ ...body, enrolment }), { status: signedIn.status, headers })
  } finally {
    takeSetupSignIn(userId)
  }
})

// Public: the invitation link shows whom it is for and which workspace, before sign-in.
app.get('/v1/invitations/:id', async c => c.json(await previewInvitation(c.req.param('id'))))

// Public: the page the sign-in email's button opens, and its Continue (sign-in-link.ts).
registerSignInLinkRoutes(app)

export { WORKSPACE_CREATION_CLOSED }

// What New workspace prefills its country with (country-hint.ts): the visitor's country from the proxy in front, else
// the time zone's, else the browser language's region; null when none says. Signed-in accounts only; nothing is stored.
app.get('/v1/workspaces/country-hint', async c => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) return c.json({ ok: false, error: 'not signed in' }, 401)
  const hint = requestCountryHint(c.req.raw.headers, {
    timeZone: c.req.query('timeZone'),
    locale: c.req.query('locale'),
  })
  c.header('cache-control', 'no-store')
  return c.json({ ok: true, hint })
})

// Create a workspace (= organization) for the signed-in server admin, with its assistant, and make it active: the
// app's New workspace. The checks below answer as before; the workspace itself is made by workspace.create without an
// owner (workspace-creation-handlers.ts), in one transaction, logged and audited like every other way to make one.
app.post('/v1/workspaces', async c => {
  const headers = c.req.raw.headers
  const session = await auth.api.getSession({ headers })
  if (!session) return c.json({ ok: false, error: 'not signed in' }, 401)
  // A workspace made as the user would outlast the impersonation (impersonation-guard.ts).
  if (session.session.impersonatedBy) return c.json({ ok: false, error: NOT_WHILE_IMPERSONATING }, 403)
  // Only server admins create workspaces (workspace-creation.ts); everyone else is invited.
  // The session's own instance:admin (context.ts: after the admin sign-in check), not the account's flag alone.
  const caller = await resolveCaller(headers, clientIpOf(c))
  // A server admin whose session has not passed the admin sign-in check yet: that first, then the workspace.
  if ('actor' in caller && caller.actor.adminSecondFactor)
    return c.json({ ok: false, code: 'admin_second_factor', error: ADMIN_CHECK_FIRST }, 403)
  if (!('actor' in caller) || !mayCreateWorkspace(caller.actor))
    return c.json({ ok: false, code: 'workspace_creation_closed', error: WORKSPACE_CREATION_CLOSED }, 403)
  const body = await c.req
    .json<{ name?: unknown; timeZone?: unknown; country?: unknown; locale?: unknown }>()
    .catch(() => ({ name: undefined, timeZone: undefined, country: undefined, locale: undefined }))
  const problem = workspaceNameProblem(body.name)
  if (problem) return c.json({ ok: false, error: problem }, 422)
  const name = (body.name as string).trim()
  // A time zone that is not one falls back to the default, as before (onboarding.ts, workspaceTimeZone).
  const timeZone = typeof body.timeZone === 'string' && body.timeZone.length <= 64 ? body.timeZone : undefined
  // The country only when picked in New workspace (workspace.create checks it; left as prefilled it stays Automatic),
  // and the hint it was prefilled with: from this request (country-hint.ts), as GET /v1/workspaces/country-hint gave it.
  const country = typeof body.country === 'string' && body.country ? body.country : undefined
  const countryHint = requestCountryHint(headers, { timeZone, locale: body.locale })
  const made = await runAction(
    'workspace.create',
    {
      name,
      ...(timeZone ? { timeZone } : {}),
      ...(country ? { country } : {}),
      ...(countryHint ? { countryHint } : {}),
    },
    caller.actor,
  )
  // Refused by workspace.create: 403 as before; invalid input stays 422.
  if (!made.body.ok) return c.json(made.body, made.status === 409 ? 403 : made.status)
  const { workspace } = made.body.data as WorkspaceCreateData
  return c.json({ ok: true, workspace })
})

/** The hostnames the sign-up page's Turnstile token may have been solved on: the app's own origins. */
const SIGNUP_HOSTNAMES = TRUSTED_ORIGINS.map(origin => new URL(origin).hostname.toLowerCase())

// Self-serve sign-up on an install that bills its workspaces (self-serve.ts, docs/billing.md §3.1). Public: whether it is open and the
// Turnstile site key for the page, and the terms and privacy policy (links and versions) the page shows next to its
// button (A9). Nothing else (no counts, no reason it is closed).
app.get('/v1/signup/config', async c => {
  const state = await db.transaction(tx => selfServeState(tx))
  const siteKey =
    state.open && state.rules.turnstile ? ((await db.transaction(tx => turnstileKeys(tx)))?.siteKey ?? null) : null
  const terms = state.open ? legalTerms().terms : null
  c.header('cache-control', 'no-store')
  // The plan the page signs up for, at the install's prices (Server admin › Billing): public, like a pricing page.
  const rules = state.open ? await billingRules(db) : null
  const plan = rules
    ? { monthlyCents: rules.workspaceMonthlyCents, yearlyCents: rules.workspaceYearlyCents, trialDays: rules.trialDays }
    : null
  // The partner plan (`?plan=partner`, docs/white-label.md): its base fee, plus a workspace's price per client.
  const partnerPlan = rules
    ? {
        monthlyCents: rules.partnerMonthlyCents,
        yearlyCents: rules.partnerYearlyCents,
        trialDays: rules.trialDays,
        trialClients: state.rules.trialWorkspacesPartner,
      }
    : null
  return c.json({
    ok: true,
    open: state.open,
    turnstileSiteKey: siteKey,
    countries: SIGNUP_COUNTRIES,
    plan,
    partnerPlan,
    terms,
  })
})

// Public: an email code for the sign-up page. Every check (open, the address, its domain, Turnstile, the limits) runs
// before the code is sent, and the answer never says whether the address has an account. The code itself is Better
// Auth's sign-in code; entering it signs in, and creates the account (signup-gate.ts) only after this attempt.
app.post('/v1/signup/code', async c => {
  const body = await c.req
    .json<{ email?: unknown; token?: unknown }>()
    .catch(() => ({ email: undefined, token: undefined }))
  if (typeof body.email !== 'string') return c.json({ ok: false, code: 'invalid_email' }, 422)
  const email = body.email.trim().toLowerCase()
  const ip = clientIpOf(c)
  const answer = await admitSignupCode(db, {
    email,
    ip,
    ipBucket: addressBucket(ip),
    token: typeof body.token === 'string' ? body.token : '',
    turnstile: { action: TURNSTILE_ACTION, hostnames: SIGNUP_HOSTNAMES },
  })
  c.header('cache-control', 'no-store')
  if (!answer.ok) {
    const status =
      answer.reason === 'too_many' || answer.reason === 'busy' ? 429 : answer.reason === 'closed' ? 404 : 422
    return c.json({ ok: false, code: answer.reason }, status)
  }
  // Committed above, so the sign-in code's own check (signup-gate.ts maySendSignInCode) sees the attempt; only this
  // route sends a code to an address that has no account yet (fromSignupPage, security review F4 of #960).
  await fromSignupPage(() =>
    auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' }, headers: clientIpHeaders(c) }),
  )
  return c.json({ ok: true })
})

// account.signUp for the signed-in person (no workspace needed yet): the account's own permission `account`, given
// only here, only to a session of the person themselves (never an API key, the agent or an impersonation).
app.post('/v1/signup', async c => {
  const headers = c.req.raw.headers
  const session = await auth.api.getSession({ headers })
  if (!session) return c.json({ ok: false, error: 'not signed in', code: 'signed_out' }, 401)
  if (session.session.impersonatedBy) return c.json({ ok: false, error: NOT_WHILE_IMPERSONATING }, 403)
  const [account] = await db.select().from(user).where(eq(user.id, session.user.id))
  if (!account || account.disabledAt) return c.json({ ok: false, error: 'not signed in', code: 'signed_out' }, 401)
  const actor: Actor = {
    actorId: account.id,
    role: 'member',
    workspaceId: null,
    permissions: ['account:signUp'],
    sessionId: session.session.id,
    sessionExpiresAt: new Date(session.session.expiresAt),
  }
  const made = await runAction('account.signUp', await c.req.json().catch(() => null), actor)
  return c.json(made.body, made.status)
})

// Public, before the guard: the API description lists no data, only the public actions' schemas.
const openApi = openApiDocument(actions.values(), process.env.PUBLIC_URL || WEB_ORIGIN)
app.get('/v1/openapi.json', c => c.json(openApi))

// OAuth sign-in for MCP clients (oauth.ts, LIN-126): metadata, client registration, authorize and token.
app.use(
  '/oauth/register',
  bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: 'invalid_client_metadata' }, 413) }),
)
app.use('/oauth/token', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: 'invalid_request' }, 413) }))
registerOAuthRoutes(app)

// MCP for a workspace's own AI tools: API keys only, its own gate (mcp.ts). Any origin may call it (CORS without
// cookies: the key is the only way in), so browser-based clients work.
app.use('/mcp', mcpCors)
// The size limit applies while the body is read, also to a chunked one without content-length.
app.use(
  '/mcp',
  bodyLimit({ maxSize: MCP_MAX_BODY_BYTES, onError: c => c.json({ ok: false, error: 'request too large' }, 413) }),
)
// A personal key's api_get tool reads the API as the key, through the same routes and checks (key-reads.ts).
app.all('/mcp', c => serveMcp(c.req.raw, clientIpOf(c), async (path, headers) => app.request(path, { headers }, c.env)))
// Setup MCP for an AI agent setting up the install: setup keys only, in the path or as Bearer (setup-mcp.ts).
const setupMcpLimit = bodyLimit({
  maxSize: MCP_MAX_BODY_BYTES,
  onError: c => c.json({ ok: false, error: 'request too large' }, 413),
})
app.use('/mcp/setup', setupMcpLimit)
app.use('/mcp/setup/*', setupMcpLimit)
app.all('/mcp/setup', c => serveSetupMcp(c.req.raw, null, clientIpOf(c)))
app.all('/mcp/setup/:key', c => serveSetupMcp(c.req.raw, c.req.param('key'), clientIpOf(c)))

// Before the workspace guard: a member without a workspace has an account too.
app.post('/v1/account/password', setFirstPassword)

// The provider sends the browser back here after the consent page. Before the guard: it answers
// with a redirect to the settings page in every case, also when the session is gone.
app.get('/v1/calendar/callback/:provider', async c =>
  c.redirect(
    await calendarCallback(c.req.param('provider'), new URL(c.req.url).searchParams, c.req.raw.headers, WEB_ORIGIN),
  ),
)
// The same for a connected app such as HubSpot (app-callback.ts).
app.get('/v1/apps/callback/:app', async c =>
  c.redirect(await appCallback(c.req.param('app'), new URL(c.req.url).searchParams, c.req.raw.headers, WEB_ORIGIN)),
)

// Public demo calls from the install's own website, asked for by its gateway with a Bearer secret; 404 unless
// DEMO_CALLS=on (demo-call.ts). Before the guard: nobody is signed in.
registerDemoCallRoutes(app)

// Public: a stand-in during-call webhook with made-up answers, for trying lookups; 404 unless TEST_LOOKUP=on (test-lookup.ts).
registerTestLookupRoute(app)

app.use('/v1/*', async (c, next) => {
  // A signed recording link (the after-call webhook's) needs no sign-in: its signature is checked by the route.
  if (c.req.method === 'GET' && isSignedRecordingRequest(c.req.path, { signature: c.req.query('signature') }))
    return next()
  const ip = clientIpOf(c)
  const requested = c.req.header(WORKSPACE_HEADER) ?? null
  const caller = await resolveCaller(c.req.raw.headers, ip)
  // A tab of a workspace its member was just removed from (or their last one): no access, not "signed out".
  if ('missing' in caller && caller.missing === 'no_workspace' && requested) return c.json(accessLost(), 403)
  const actor = 'actor' in caller ? caller.actor : null
  if (!actor) {
    // An address that sent too many unknown keys is not looked up any more (api-keys.ts).
    const bearer = c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
    if ((isApiKey(bearer) || isPersonalKey(bearer)) && tooManyInvalidApiKeys(ip)) {
      c.header('retry-after', '600')
      return c.json({ ok: false, error: 'too many invalid API keys from this address; try again later' }, 429)
    }
    // Guessing the agent token: the address is refused for a while (context.ts).
    if (bearer && !isApiKey(bearer) && !isPersonalKey(bearer) && tooManyInvalidAgentTokens(ip)) {
      c.header('retry-after', '600')
      return c.json({ ok: false, error: 'too many invalid tokens from this address; try again later' }, 429)
    }
    // `signed_out`: no valid session (expired, signed out, account disabled); `no_workspace`: signed in, member of none.
    const code = 'missing' in caller ? caller.missing : 'signed_out'
    return c.json({ ok: false, error: 'not signed in or no workspace', code }, 401)
  }
  // Workspace and personal keys alike (api-keys.ts keyOf).
  const limitedKey = keyOf(actor)
  if (limitedKey && !apiKeyWithinLimit(limitedKey)) {
    c.header('retry-after', '60')
    return c.json({ ok: false, error: `rate limit: ${API_KEY_REQUESTS_PER_MINUTE} requests a minute per API key` }, 429)
  }
  // A personal key runs actions and reads the routes listed in key-reads.ts; the rest is the browser's.
  if (actor.personalKeyId && !personalKeyMayRequest(c.req.method, c.req.path))
    return c.json({ ok: false, error: 'a personal key cannot use this route (docs/api.md)', code: 'forbidden' }, 403)
  // The tab's workspace must be the session's: never read or write another one (a switch in another tab).
  const refusal =
    accountRefusal(actor, c.req.header(ACCOUNT_HEADER) ?? null) ??
    clientOutdated(actor, { method: c.req.method, path: c.req.path, header: name => c.req.header(name) }) ??
    (await workspaceRefusal(actor, requested))
  if (refusal) return c.json(refusal, 403)
  c.set('actor', actor)
  await next()
  // Whether the workspace is disabled, on every answer: an open tab notices a disable or enable at its next request.
  if (actor.workspaceId) {
    const state = actor.workspaceDisabled ? 'disabled' : 'active'
    try {
      c.res.headers.set(WORKSPACE_STATE_HEADER, state)
    } catch {
      // A response passed through as it came (immutable headers): copy it once.
      c.res = new Response(c.res.body, c.res)
      c.res.headers.set(WORKSPACE_STATE_HEADER, state)
    }
  }
})

app.get('/v1/me', async c => {
  const actor = c.get('actor')
  const [workspace] = actor.workspaceId
    ? await db
        .select({
          id: organization.id,
          name: organization.name,
          disabledAt: organization.disabledAt,
          billingState: organization.billingState,
          partnerId: organization.partnerId,
          iconVersion: workspace_icons.version,
        })
        .from(organization)
        .leftJoin(workspace_icons, eq(workspace_icons.workspace_id, organization.id))
        .where(eq(organization.id, actor.workspaceId))
    : []
  // Independent reads, side by side: the app's first screen waits for this answer.
  const [
    avatarVersion,
    changedBy,
    workspaces,
    [onboarding, businessSetup],
    phoneSetup,
    impersonation,
    passkeyEnrolment,
    hasPasskey,
    hasAuthenticator,
    starPrompt,
    setupByHand,
    locale,
    billFacts,
    partners,
  ] = await Promise.all([
    avatarVersionOf(db, actor.actorId),
    profileChangedBy(db, actor.actorId, actor.workspaceId),
    workspacesOf(actor.actorId),
    workspace
      ? onboardingFor(actor).then(async o => [o, await businessSetupFor(actor, o)] as const)
      : ([null, null] as const),
    workspace ? phoneSetupFor(actor) : null,
    impersonationOf(actor),
    needsPasskeyEnrolment(actor),
    hasPasskeyFor(actor),
    hasAuthenticatorFor(actor),
    starPromptFor(actor),
    setupByHandFor(actor),
    localeOf(actor),
    // On a bill: a sign-up waiting for Checkout is told the install's trial length and the plan's price (Server
    // admin › Billing); everyone what an extra number costs a month.
    workspace?.billingState || workspace?.partnerId ? workspaceBillFacts(workspace.id) : null,
    // Only with the `partner` permission (a session of a partner team member, never while impersonated).
    actor.permissions.includes('partner') ? partnersOf(actor.actorId) : [],
  ])
  return c.json({
    actorId: actor.actorId,
    role: actor.role,
    permissions: actor.permissions,
    // The member's own profile picture (Account settings › Profile), null without one.
    avatarUrl: avatarUrlOf(actor.actorId, avatarVersion),
    // An owner or admin changed the member's name or picture last (team-member-edit.ts): Profile says who and when.
    profileChangedBy: changedBy,
    workspace: workspace
      ? {
          id: workspace.id,
          name: workspace.name,
          disabled: Boolean(workspace.disabledAt),
          iconUrl: iconUrlOf(workspace.id, workspace.iconVersion),
          // On a bill: `pending_payment` until Checkout, then `active` or `suspended`; null off billing.
          billingState: workspace.billingState ?? null,
          // While `pending_payment`: the free trial's length in days and the plan's price at the bill's interval, as
          // the install set them; else null.
          trialDays: billFacts?.trialDays ?? null,
          plan: billFacts?.plan ?? null,
          // On a bill: what each number beyond the included one costs a month (from the balance); null off billing
          // and on a comped bill.
          extraNumberCents: billFacts?.extraNumberCents ?? null,
          // A white-label client on its partner's bill: no prices anywhere in the workspace (docs/white-label.md).
          partnerManaged: billFacts?.partnerManaged ?? false,
        }
      : null,
    // Every workspace this member belongs to, for the switcher in the profile menu: known at boot, never fetched when it opens.
    workspaces,
    onboarding,
    // After onboarding, for owners and admins: what "Find your business" offers when they go through the setup steps
    // again from the settings (onboarding.ts, businessSetupFor).
    businessSetup,
    phoneSetup,
    impersonation,
    // When the session ends: a browser opens from its local data at load only until then (apps/web/src/session.ts).
    sessionExpiresAt: actor.sessionExpiresAt?.toISOString() ?? null,
    // An instance admin whose session lacks the second factor: 'setup' (no passkey yet) or 'confirm'.
    adminSecondFactor: actor.adminSecondFactor ?? null,
    // An instance admin without a passkey: adding the first one asks for their enrolment code (passkey-enrolment.ts).
    passkeyEnrolment,
    // Whether the member has a passkey, for the app's "Add a passkey" page and card (null: passkeys are off here).
    // Their own account only: the sign-in page never learns this for an address (no account enumeration).
    hasPasskey,
    // An instance admin's authenticator app (authenticator.ts): true or false for instance admins, else null.
    hasAuthenticator,
    // This session's check was a passkey sign-in (not the app's code): adding or removing the app needs it.
    passkeySignedIn: Boolean(actor.passkeySignedIn),
    // The member's address is not confirmed yet: the app asks for a code (sensitive actions wait for it).
    emailUnconfirmed: Boolean(actor.emailUnverified && !actor.impersonation),
    // How this install introduces a new workspace after onboarding (FIRST_USE).
    firstUse: firstUse(),
    // The GitHub star prompt while it is due for this member (star-prompt.ts), else null.
    starPrompt,
    // An instance admin who chose to set up this install by hand: no agent setup page first (install-setup.ts).
    setupByHand,
    // The white-label partners whose team the person is on (partners.ts): the partner area and its menu entry.
    partners,
    // The member's UI language (user-locale.ts): `locale` null is Automatic. Signed in as someone else, the admin's
    // own browser decides (null), so they can read what they see.
    ...locale,
  })
})

/** The UI language fields of the signed-in member; both null while impersonating. */
async function localeOf({ actorId, impersonation }: Actor) {
  if (impersonation) return { locale: null, localeAuto: null }
  const [row] = await db
    .select({ locale: user.locale, localeAuto: user.localeAuto })
    .from(user)
    .where(eq(user.id, actorId))
  return { locale: row?.locale ?? null, localeAuto: row?.localeAuto ?? null }
}

/** Only for an instance admin (also before the second factor), never while signed in as someone else. */
async function setupByHandFor({ actorId, permissions, adminSecondFactor, impersonation }: Actor): Promise<boolean> {
  if (impersonation || !(permissions.includes('instance:admin') || adminSecondFactor)) return false
  return setsUpByHand(actorId)
}

/** Whether the signed-in member has a passkey; null when passkeys are off on this install or while impersonating. */
async function hasPasskeyFor({ actorId, impersonation }: Actor): Promise<boolean | null> {
  if (!authMethods.passkey || impersonation) return null
  const [any] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, actorId)).limit(1)
  return Boolean(any)
}

/** Whether the signed-in instance admin has an authenticator app; null for everyone else and while impersonating. */
async function hasAuthenticatorFor({ actorId, impersonation, permissions }: Actor): Promise<boolean | null> {
  if (impersonation || !permissions.includes('secondFactor:own')) return null
  return hasAuthenticator(db, actorId)
}

/**
 * Whether this is an instance admin (by account, also before the second factor) without a passkey whose session has
 * not passed the check: adding a first passkey asks for the enrolment code then (a session checked with the
 * authenticator app adds it without, passkeys.ts).
 */
async function needsPasskeyEnrolment({ actorId, impersonation, passkeyConfirmed }: Actor): Promise<boolean> {
  if (impersonation || passkeyConfirmed) return false
  const [account] = await db.select().from(user).where(eq(user.id, actorId))
  if (!account || !isInstanceAdmin(account)) return false
  const [any] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, actorId)).limit(1)
  return !any
}

/** The workspaces a user is a member of, by name, with their icons' addresses (null: the initial shows). */
/** A disabled workspace stays in the list (the switcher shows it greyed out) but cannot be switched to. */
async function workspacesOf(userId: string) {
  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      disabledAt: organization.disabledAt,
      iconVersion: workspace_icons.version,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .leftJoin(workspace_icons, eq(workspace_icons.workspace_id, organization.id))
    .where(eq(member.userId, userId))
    .orderBy(asc(organization.name))
  return rows.map(({ id, name, disabledAt, iconVersion }) => ({
    id,
    name,
    disabled: disabledAt !== null,
    iconUrl: iconUrlOf(id, iconVersion),
  }))
}

// A workspace's icon (workspace-icon.ts), for members of that workspace: any of theirs, not only the tab's, as the
// switcher shows them all. Only ever a PNG the server checked; nosniff and a CSP that allows nothing keep the
// browser from reading it as anything else. The address changes with every new icon (?v=), so it is cached for good.
app.get('/v1/workspace-icons/:file', async c => {
  const file = c.req.param('file')
  const icon = file.endsWith('.png') ? await readIconFor(db, file.slice(0, -4), c.get('actor').actorId) : null
  if (!icon) return c.json({ ok: false, error: 'no icon' }, 404)
  c.header('content-type', 'image/png')
  c.header('x-content-type-options', 'nosniff')
  c.header('content-security-policy', "default-src 'none'; sandbox")
  c.header('cache-control', 'private, max-age=31536000, immutable')
  return c.body(new Uint8Array(icon))
})

// A person's profile picture (user-avatar.ts), for them, people who share a workspace with them and instance admins.
// Served like the workspace icon: only a PNG the server checked, nosniff and a CSP that allows nothing; the address
// changes with every new picture (?v=), so it is cached for good.
app.get('/v1/avatars/:file', async c => {
  const file = c.req.param('file')
  const png = file.endsWith('.png') ? await readAvatarFor(db, file.slice(0, -4), c.get('actor')) : null
  if (!png) return c.json({ ok: false, error: 'no picture' }, 404)
  c.header('content-type', 'image/png')
  c.header('x-content-type-options', 'nosniff')
  c.header('content-security-policy', "default-src 'none'; sandbox")
  c.header('cache-control', 'private, max-age=31536000, immutable')
  return c.body(new Uint8Array(png))
})

// The member's workspaces for the switcher, read again when the menu opens; the same list /v1/me brings at boot.
app.get('/v1/me/workspaces', async c => {
  c.header('cache-control', 'no-store')
  return c.json(await workspacesOf(c.get('actor').actorId))
})

/** Who is signed in as this user, for the banner while impersonating. */
async function impersonationOf({ actorId, impersonation }: Actor) {
  if (!impersonation) return null
  const person = (id: string) =>
    db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, id))
  const [[by], [as]] = await Promise.all([person(impersonation.by), person(actorId)])
  return by && as ? { by, user: as, expiresAt: impersonation.expiresAt.toISOString() } : null
}

// For the inbox header: can the assistant answer calls at all? Members see whether, never which key is missing or
// which provider is failing (`voiceFailing`: set up, but a lasting provider failure stops calls, LIN-111).
app.get('/v1/assistant/status', async c => {
  c.header('cache-control', 'no-store')
  const ready = await voiceReady(db)
  return c.json({ voiceReady: ready, voiceFailing: ready && (await voiceFailing(db)) })
})

// Which calendar providers members may connect on this install, and how: by consent page (an OAuth app) or with a
// key. Google and Microsoft when their app is set up; CalDAV, Calendly and Cal.com only when switched on in Server admin.
app.get('/v1/calendar/providers', async c => {
  const ways = connectWays(await calendarToolModes())
  return c.json({ providers: Object.keys(ways), ways })
})

registerAdminRoutes(app)
registerImpersonationRoutes(app)
registerAuthenticatorRoutes(app)
registerIntegrationRoutes(app)

app.get('/v1/actions', c =>
  c.json([...actions.values()].map(a => ({ name: a.name, description: a.description, permission: a.permission }))),
)

// The actions the caller may run here, with their input schema: what the `linedesk` CLI offers (packages/cli).
app.get('/v1/me/actions', c => {
  const actor = c.get('actor')
  c.header('cache-control', 'no-store')
  return c.json({
    workspaceId: actor.workspaceId ?? null,
    actions: [...actions.values()]
      .filter(def => runnableBy(def, actor))
      .map(def => ({
        name: def.name,
        description: def.description,
        permission: def.permission,
        readOnly: Boolean(def.readOnly),
        destructive: Boolean(def.destructive) || IRREVERSIBLE_ACTIONS.has(def.name),
        input: inputSchema(def),
      })),
  })
})

// A voice recording is the one large input: it is capped before the body is read; every other action at 4 MB (a contact import of 500 rows fits).
app.use(
  '/v1/actions/voice.clone',
  bodyLimit({
    maxSize: CLONE_BODY_MAX_BYTES,
    onError: c => c.json({ ok: false, error: 'the recording is larger than 10 MB' }, 413),
  }),
)
app.use('/v1/actions/:name', async (c, next) =>
  c.req.param('name') === 'voice.clone'
    ? next()
    : bodyLimit({
        maxSize: ACTION_BODY_MAX_BYTES,
        onError: c => c.json({ ok: false, error: 'request body too large' }, 413),
      })(c, next),
)

app.post('/v1/actions/:name', async c => {
  // These change which session the browser holds, so only their own routes run them.
  if (COOKIE_ACTIONS.includes(c.req.param('name')))
    return c.json({ ok: false, error: 'use POST /v1/impersonation/start or /v1/impersonation/stop' }, 400)
  // These pass the Server admin check, which also remembers this browser (authenticator-routes.ts).
  if (AUTHENTICATOR_ROUTE_ACTIONS.includes(c.req.param('name')))
    return c.json({ ok: false, error: 'use POST /v1/account/authenticator/confirm or /check' }, 400)
  const input = await c.req.json().catch(() => ({}))
  const { status, body } = await runAction(c.req.param('name'), input, c.get('actor'), c.req.header('idempotency-key'))
  return c.json(body, status)
})

app.get('/v1/voices/preview/:voiceId', c => {
  // `language`: the assistant's main language, which the sample is spoken in (missing: English).
  const asked = c.req.query('language') || undefined
  const language = asked === undefined ? undefined : previewLanguage(asked)
  if (language === null) return Response.json({ ok: false, error: 'not a supported language' }, { status: 400 })
  return servePreview(c.get('actor'), c.req.param('voiceId'), {
    providerName: c.req.query('provider') || undefined,
    language,
  })
})

app.get('/v1/calls/:id/recording', c => {
  const signature = c.req.query('signature')
  return signature === undefined
    ? serveRecording(c.get('actor'), c.req.param('id'), c.req.header('range'))
    : serveSignedRecording(c.req.param('id'), c.req.query('expires'), signature, c.req.header('range'))
})

// Read sync: proxy to Electric. The server picks the table and adds the workspace filter;
// the client only controls the stream position. The browser puts its workspace in the URL too
// (`?workspace=`), so each workspace's shape has its own URL and Electric's client keeps its
// per-URL state (expired handles) apart; it must be the request's workspace.

/** The 4xx Electric answers about the stream position, which its client handles (load the table again). */
const ELECTRIC_CLIENT_STATUSES = [400, 404, 409, 410]

const streamParams = ['offset', 'handle', 'live', 'cursor', 'live_sse', 'experimental_live_sse']
/** Read sync is the browser's: it streams whole tables, settings included (assistants, numbers, calendars, webhooks). */
export const SHAPE_NOT_FOR_API_KEYS =
  'API keys cannot use read sync; use the public API (GET /v1/openapi.json) or the MCP read tools'

app.get('/v1/shape/:table', async c => {
  const table = c.req.param('table') as TableName
  const { workspaceId, apiKeyId, role, permissions } = c.get('actor')
  if (apiKeyId || c.get('actor').personalKeyId)
    return c.json({ ok: false, error: SHAPE_NOT_FOR_API_KEYS, code: 'forbidden' }, 403)
  if (!tableNames.includes(table) || !workspaceId) return c.json({ ok: false, error: 'unknown table' }, 404)
  // Read sync is for members and API keys that read calls; never the voice agent, whose tools read nothing.
  if (role === 'agent' || !permissions.includes('call:read'))
    return c.json({ ok: false, error: 'missing permission call:read' }, 403)
  const refusal = await workspaceRefusal(c.get('actor'), c.req.query('workspace') ?? null)
  if (refusal) return c.json(refusal, 403)
  const target = new URL('/v1/shape', ELECTRIC_URL)
  for (const [k, v] of new URL(c.req.url).searchParams) if (streamParams.includes(k)) target.searchParams.set(k, v)
  target.searchParams.set('table', table)
  target.searchParams.set('replica', 'full')
  target.searchParams.set('where', shapeFilter(table, c.get('actor').permissions))
  target.searchParams.set('params[1]', workspaceId)
  if (ELECTRIC_SECRET) target.searchParams.set('secret', ELECTRIC_SECRET)
  const res = await fetch(target, { signal: c.req.raw.signal }).catch((e: unknown) => e as Error)
  // Electric down or unreachable: one log line a minute, never a stack per request; the web app retries.
  if (res instanceof Error) {
    // The browser went away (a long poll it closed): nobody reads the answer.
    if (c.req.raw.signal.aborted) return new Response(null, { status: 499 })
    logReadSyncDown(res)
    return c.json({ ok: false, error: 'read sync is unavailable' }, 503)
  }
  // Electric's own 4xx (an unknown handle, an offset out of range, a changed shape) tell the client to
  // load the table again and pass through. Any other 4xx, a 401 or 403 from Electric or a proxy in
  // front of it, is a server fault: the browser must never take it for its own session being gone.
  if (res.status >= 400 && res.status < 500 && !ELECTRIC_CLIENT_STATUSES.includes(res.status)) {
    console.error(`shape ${table}: Electric answered ${res.status}`)
    return c.json({ ok: false, error: 'read sync is unavailable' }, 502)
  }
  const headers = new Headers(res.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  // Electric allows any origin; this API answers its own app only (cookies, no CORS).
  for (const name of [...headers.keys()]) if (name.startsWith('access-control-')) headers.delete(name)
  // Never from the browser's cache: a polled table asks again with the same URL after a write.
  headers.set('cache-control', 'no-store')
  headers.append('vary', 'Cookie, Authorization')
  return new Response(res.body, { status: res.status, headers })
})
