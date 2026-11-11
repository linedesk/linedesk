import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP, genericOAuth, organization } from 'better-auth/plugins'
import { authConfig } from './auth-methods.ts'
import { accountLinkingHooks, mapGoogleProfile, mapMicrosoftProfile } from './account-linking.ts'
import { auditHooks, recordAuthEndpoint } from './audit.ts'
import { CLIENT_IP_HEADER } from './client-ip.ts'
import { mergeDatabaseHooks } from './db-hooks.ts'
import { githubProvider } from './github-sign-in.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { refuseExistingMember, sendVerificationEmail } from './invitations.ts'
import { createRateLimiter } from './rate-limit.ts'
import { refuseWhileImpersonating } from './impersonation-guard.ts'
import { instanceAdminHooks } from './instance-admin.ts'
import { passkeyPlugin, requireFreshSessionToRemovePasskey } from './passkeys.ts'
import { maySendSignInCode } from './signup-gate.ts'
import { releaseWorkspaceClones } from './voices.ts'

const { google, microsoft, github, oidc, trustedProviders, methods } = authConfig

/** Where the web app is served from; the only origin browser requests are accepted from. */
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'

/** A member can create this many workspaces. */
export const WORKSPACE_LIMIT = 5

// Per address, on top of Better Auth's limit per IP: 5 codes in 10 minutes (a code's lifetime), and
// 10 sign-in tries in an hour across codes, since a new code starts its own 3 tries.
const allowCodeFor = createRateLimiter({ max: 5, windowMs: 10 * 60_000 })
const allowTryFor = createRateLimiter({ max: 10, windowMs: 60 * 60_000 })

/**
 * Runs before the email-code endpoints, so a refused request creates no code and leaves the
 * current one (and its tries) as it is. Only sign-in codes exist here.
 */
const limitEmailCodes = async (ctx: Parameters<typeof refuseWhileImpersonating>[0]) => {
  const email = typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : ''
  if (ctx.path === '/email-otp/send-verification-otp') {
    if (ctx.body?.type !== 'sign-in') throw new APIError('BAD_REQUEST', { message: 'Only sign-in codes are offered.' })
    if (!allowCodeFor(email)) throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many codes for this email. Try again in a few minutes.' })
  }
  if (ctx.path === '/sign-in/email-otp' && !allowTryFor(email)) {
    throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many tries for this email. Try again later.' })
  }
}

const beforeAuthEndpoints = createAuthMiddleware(async ctx => {
  await limitEmailCodes(ctx)
  await refuseWhileImpersonating(ctx)
  await requireFreshSessionToRemovePasskey(ctx)
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
  trustedOrigins: [WEB_ORIGIN],
  emailAndPassword: { enabled: methods.password },
  databaseHooks: mergeDatabaseHooks(instanceAdminHooks, accountLinkingHooks, auditHooks),
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
  account: { accountLinking: { enabled: true, trustedProviders, requireLocalEmailVerified: false } },
  // On in every environment, not only when NODE_ENV says production.
  rateLimit: { enabled: true },
  // The client address comes from our own header (client-ip.ts), never from one the client sets.
  advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
  // Members and invitations change only through the team.* actions (team.ts), which apply the
  // workspace's rules (last owner, who may change an owner). Accepting stays Better Auth's endpoint.
  disabledPaths: [...UNUSED_EMAIL_CODE_PATHS, ...TEAM_WRITE_PATHS, ...INVITATION_READ_PATHS, ...WORKSPACE_WRITE_PATHS],
  // After: the audit log records the auth endpoints that change how someone signs in (audit.ts).
  hooks: { before: beforeAuthEndpoints, after: recordAuthEndpoint },
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
    ...(oidc ? [genericOAuth({ config: [{ providerId: 'oidc', clientId: oidc.clientId, clientSecret: oidc.clientSecret, discoveryUrl: oidc.discoveryUrl, scopes: ['openid', 'profile', 'email'], pkce: true }] })] : []),
  ],
})
