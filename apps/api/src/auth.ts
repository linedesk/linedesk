import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP, genericOAuth, organization } from 'better-auth/plugins'
import { authConfig } from './auth-methods.ts'
import { accountLinkingHooks, mapGoogleProfile, mapMicrosoftProfile, mapOidcProfile } from './account-linking.ts'
import { auditHooks, recordAuthEndpoint } from './audit.ts'
import { CLIENT_IP_HEADER } from './client-ip.ts'
import { mergeDatabaseHooks } from './db-hooks.ts'
import { githubProvider } from './github-sign-in.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { refuseExistingMember, sendVerificationEmail } from './invitations.ts'
import { countSignInFailures, limitSignIns } from './sign-in-limits.ts'
import { refuseWhileImpersonating } from './impersonation-guard.ts'
import { instanceAdminHooks } from './instance-admin.ts'
import { guardPasskeyChanges, notifyPasskeyChange, passkeyPlugin } from './passkeys.ts'
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
export const TRUSTED_ORIGINS: readonly string[] = [normaliseOrigin(WEB_ORIGIN)]

/** A member can create this many workspaces. */
export const WORKSPACE_LIMIT = 5

const beforeAuthEndpoints = createAuthMiddleware(async ctx => {
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
  '/email-otp/request-password-reset', '/forget-password/email-otp', '/email-otp/reset-password', '/email-otp/verify-email',
  '/email-otp/check-verification-otp', '/email-otp/request-email-change', '/email-otp/change-email',
]

/** The sign-in email: the code in the subject and the body, no link. */
export const signInCodeEmail = (otp: string) => ({
  subject: `${otp} is your Linedesk sign-in code`,
  text: `${otp} is your Linedesk sign-in code.\n\nEnter it on the sign-in page. It works once and expires in 10 minutes. If you did not ask for it, you can ignore this email.`,
})

/** Only sign-in codes are sent; the plugin's other code types (password reset, email change) are not offered. */
async function sendSignInCode({ email, otp, type }: { email: string; otp: string; type: string }) {
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
  emailAndPassword: { enabled: methods.password },
  databaseHooks: mergeDatabaseHooks(instanceAdminHooks, accountLinkingHooks, auditHooks, starOnGrantHooks),
  emailVerification: { sendVerificationEmail, autoSignInAfterVerification: true },
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
