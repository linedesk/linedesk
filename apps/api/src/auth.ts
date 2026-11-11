import { adminAlertHooks } from './admin-alerts.ts'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP, genericOAuth, organization } from 'better-auth/plugins'
import { authConfig } from './auth-methods.ts'
import {
  accountLinkingHooks,
  dropUnprovenAccessBeforeEmailLink,
  endSessionsAfterEmailLink,
  mapGoogleProfile,
  mapMicrosoftProfile,
  mapOidcProfile,
} from './account-linking.ts'
import { auditHooks, recordAuthEndpoint } from './audit.ts'
import { CLIENT_IP_HEADER } from './client-ip.ts'
import { mergeDatabaseHooks } from './db-hooks.ts'
import { githubProvider } from './github-sign-in.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { confirmationCodeEmail as confirmationCodeTemplate, signInCodeEmail } from './emails/templates.ts'
import { refuseExistingMember, sendVerificationEmail } from './invitations.ts'
import { countSignInFailures, limitSignIns } from './sign-in-limits.ts'
import { refuseWhileImpersonating } from './impersonation-guard.ts'
import { instanceAdminHooks } from './instance-admin.ts'
import { guardPasskeyChanges, notifyPasskeyChange, passkeyPlugin, passkeyRelyingParty } from './passkeys.ts'
import { maySendSignInCode } from './signup-gate.ts'
import { starOnGrantHooks } from './star-prompt.ts'
import { releaseWorkspaceClones } from './voices.ts'

const { google, microsoft, github, oidc, trustedProviders, methods } = authConfig

/** Where the web app is served from; the only origin browser requests are accepted from. */
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'

/**
 * An origin as a browser sends it in `Origin`: scheme, lower-case host, port only when not the
 * default. A configured `https://App.example.com:443/` would otherwise never match and refuse every
 * cookie-signed write (csrf.ts).
 */
export function normaliseOrigin(origin: string): string {
  const bad = (why: string) => new Error(`WEB_ORIGIN must be an http(s) address like https://app.example.com (${why}): ${origin}`)
  if (origin.includes('*')) throw bad('no wildcards')
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw bad('not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad('not http or https')
  // An opaque origin ("null") would match the Origin a sandboxed or file:// page sends.
  if (url.origin === 'null' || !url.hostname) throw bad('no host')
  return url.origin
}

/** The origins whose pages may use the session cookie: Better Auth's and /v1's cross-site checks (csrf.ts). */
/**
 * Extra origins for local development only (LINEDESK_DEV_ORIGINS, comma-separated), e.g. the stack's
 * localhost address next to its public tunnel (live mode runs with NODE_ENV=production, so this is not
 * tied to it). Every origin listed can use the session cookie: leave it empty on real installs.
 */
function devOrigins(): string[] {
  const raw = process.env.LINEDESK_DEV_ORIGINS?.trim()
  if (!raw) return []
  console.warn(`LINEDESK_DEV_ORIGINS is set: sign-ins are also accepted from ${raw} (local development only).`)
  return raw.split(',').map(o => o.trim()).filter(Boolean).map(normaliseOrigin)
}

export const TRUSTED_ORIGINS: readonly string[] = [...new Set([normaliseOrigin(WEB_ORIGIN), ...devOrigins()])]

/** A member can create this many workspaces. */
export const WORKSPACE_LIMIT = 5

/** The endpoints that take a provider's ID token straight from the client instead of the redirect. */
const ID_TOKEN_PATHS = ['/sign-in/social', '/link-social']

/**
 * Better Auth signs in (or links) with a provider ID token the client posts, without the redirect
 * and its state check. Linedesk only uses the redirect, so a posted ID token is refused: it would be
 * a way in that the sign-in limits and the admin alerts do not see.
 */
export function refuseIdTokenSignIn(ctx: { path: string; body?: unknown }) {
  if (!ID_TOKEN_PATHS.includes(ctx.path)) return
  if ((ctx.body as { idToken?: unknown } | undefined)?.idToken === undefined) return
  throw new APIError('FORBIDDEN', { code: 'ID_TOKEN_SIGN_IN_OFF', message: "Sign in on the provider's page." })
}

const beforeAuthEndpoints = createAuthMiddleware(async ctx => {
  refuseIdTokenSignIn(ctx)
  await limitSignIns(ctx)
  await refuseWhileImpersonating(ctx)
  await guardPasskeyChanges(ctx)
})

// After: wrong codes and passwords count towards their limits (sign-in-limits.ts); the audit log
// records the auth endpoints that change how someone signs in (audit.ts), and the account is
// emailed when a passkey is added or removed (passkeys.ts).
const afterAuthEndpoints = createAuthMiddleware(async ctx => {
  await countSignInFailures(ctx)
  await recordAuthEndpoint(ctx)
  await notifyPasskeyChange(ctx)
})

/** The plugin's endpoints for password reset, email change and plain verification are not offered. */
/**
 * Workspaces are created, renamed and removed only through Linedesk: POST /v1/workspaces makes the
 * assistant and settings with it, and nothing else may delete a workspace and leave its numbers,
 * contacts and assistants behind. Better Auth's own endpoints for these are off over HTTP; the API
 * still calls `auth.api.createOrganization` itself.
 */
const WORKSPACE_WRITE_PATHS = ['/organization/create', '/organization/update', '/organization/delete']
const TEAM_WRITE_PATHS = ['/organization/invite-member', '/organization/cancel-invitation', '/organization/update-member-role', '/organization/remove-member', '/organization/leave', '/organization/reject-invitation']
// Better Auth's reads that show pending invitees' addresses to every member; team.list shows them to owners and admins only.
const INVITATION_READ_PATHS = ['/organization/get-full-organization', '/organization/list-invitations']
// Better Auth's endpoints that hand a signed-in account's provider tokens to the browser. Linedesk
// never needs them there, and a script injected into the page would get the member's GitHub token.
const PROVIDER_TOKEN_PATHS = ['/get-access-token', '/account-info', '/refresh-token']
const UNUSED_EMAIL_CODE_PATHS = [
  '/email-otp/request-password-reset', '/forget-password/email-otp', '/email-otp/reset-password',
  '/email-otp/check-verification-otp', '/email-otp/request-email-change', '/email-otp/change-email',
]

export { signInCodeEmail }

/**
 * The code that confirms a signed-in member's own address (only asked for by them, see
 * sign-in-limits.ts). Names the site it is for (the address people open, as for passkeys), so a code
 * someone asks for elsewhere stands out.
 */
export const confirmationCodeEmail = (otp: string, env: Record<string, string | undefined> = process.env) =>
  confirmationCodeTemplate(otp, passkeyRelyingParty(env).origin)

/** Sign-in and confirmation codes are sent; the plugin's other code types (password reset, email change) are not offered. */
async function sendSignInCode({ email, otp, type }: { email: string; otp: string; type: string }) {
  if (type === 'email-verification') {
    await emailSender.send({ to: email, ...confirmationCodeEmail(otp) })
    return
  }
  if (type !== 'sign-in') return
  // Closed sign-up: no code to an address that cannot sign in.
  if (!(await maySendSignInCode(db, email))) return
  // Not awaited: waiting for SMTP only for real accounts would tell anyone which addresses have one.
  void emailSender.send({ to: email, ...signInCodeEmail(otp) }).catch(err => console.error('sign-in email failed', err))
}

// Workspace = Better Auth organization. Sign-in methods: see auth-methods.ts.
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: [...TRUSTED_ORIGINS],
  // A failed provider sign-in that names no page of its own (expired or unknown state) goes to the
  // app's sign-in screen, which explains `?error=` in plain words, never to Better Auth's error page.
  onAPIError: { errorURL: WEB_ORIGIN },
  emailAndPassword: { enabled: methods.password },
  databaseHooks: mergeDatabaseHooks(instanceAdminHooks, accountLinkingHooks, auditHooks, starOnGrantHooks, adminAlertHooks),
  emailVerification: {
    sendVerificationEmail,
    autoSignInAfterVerification: true,
    // Opened without a session of that account: whatever got in before the address was proven goes
    // (account-linking.ts). Before the address is marked verified, so a failure stops the confirmation.
    beforeEmailVerification: async (target, request) => {
      const current = request ? await auth.api.getSession({ headers: request.headers }).catch(() => null) : null
      await dropUnprovenAccessBeforeEmailLink(target, current?.user.id ?? null)
    },
    // A session made while that cleanup ran goes too; the opener's new session is made after this.
    afterEmailVerification: async (target, request) => {
      const current = request ? await auth.api.getSession({ headers: request.headers }).catch(() => null) : null
      await endSessionsAfterEmailLink(target, current?.user.id ?? null)
    },
  },
  socialProviders: {
    // A sign-in whose email the provider does not prove has no email and signs nobody in (account-linking.ts).
    ...(google && { google: { ...google, mapProfileToUser: mapGoogleProfile } }),
    ...(microsoft && { microsoft: { ...microsoft, mapProfileToUser: mapMicrosoftProfile } }),
    ...(github && { github: githubProvider(github) }),
  },
  // One person, one account: a provider sign-in joins the account with the same email. Which
  // providers are trusted for that without an email-verified claim: see auth-methods.ts.
  // One email, one account: a provider sign-in with a proven email joins the account with that
  // email, also one whose email was never verified (an invitation); see account-linking.ts.
  // Provider tokens are stored encrypted with BETTER_AUTH_SECRET (rows from before stay readable as they are).
  account: { accountLinking: { enabled: true, trustedProviders, requireLocalEmailVerified: false }, encryptOAuthTokens: true },
  // On in every environment, not only when NODE_ENV says production.
  rateLimit: { enabled: true },
  // The client address comes from our own header (client-ip.ts), never from one the client sets.
  advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
  // Members and invitations change only through the team.* actions (team.ts), which apply the
  // workspace's rules (last owner, who may change an owner). Accepting stays Better Auth's endpoint.
  disabledPaths: [...UNUSED_EMAIL_CODE_PATHS, ...PROVIDER_TOKEN_PATHS, ...TEAM_WRITE_PATHS, ...INVITATION_READ_PATHS, ...WORKSPACE_WRITE_PATHS],
  hooks: { before: beforeAuthEndpoints, after: afterAuthEndpoints },
  // Set by user.impersonate only (impersonation.ts); `input: false` keeps clients from setting it.
  // passkeyVerifiedAt: set by the session.create hook on a passkey sign-in (admin-second-factor.ts).
  session: {
    additionalFields: {
      impersonatedBy: { type: 'string', required: false, input: false },
      passkeyVerifiedAt: { type: 'date', required: false, input: false },
    },
  },
  plugins: [
    organization({
      organizationLimit: WORKSPACE_LIMIT,
      // Only the invited address, and only once it is verified, can accept.
      requireEmailVerificationOnInvitation: true,
      organizationHooks: {
        beforeAcceptInvitation: refuseExistingMember,
        // Its cloned voices are deleted at the provider too.
        beforeDeleteOrganization: async ({ organization }) => {
          await db.transaction(tx => releaseWorkspaceClones(tx, organization.id))
        },
      },
    }),
    // Email sign-in by a typed code: 6 digits, 10 minutes, 3 tries per code, stored hashed, at most 3 requests a minute per IP.
    ...(methods.emailCode
      ? [emailOTP({ sendVerificationOTP: sendSignInCode, otpLength: 6, expiresIn: 600, allowedAttempts: 3, storeOTP: 'hashed', rateLimit: { window: 60, max: 3 } })]
      : []),
    // Passkeys sign in existing accounts only; they are added in Account settings (passkeys.ts).
    ...(methods.passkey ? [passkeyPlugin(process.env)] : []),
    // Like Google: no email unless the provider says it is verified (`email_verified`) or the address is on a domain listed in OIDC_TRUST_EMAIL_DOMAINS, so an unproven address creates nobody.
    ...(oidc ? [genericOAuth({ config: [{ providerId: 'oidc', clientId: oidc.clientId, clientSecret: oidc.clientSecret, discoveryUrl: oidc.discoveryUrl, scopes: ['openid', 'profile', 'email'], pkce: true, mapProfileToUser: profile => mapOidcProfile(profile) }] })] : []),
  ],
})
