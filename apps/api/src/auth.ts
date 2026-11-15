import { adminAlertHooks } from './admin-alerts.ts'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { emailOTP, genericOAuth, organization } from 'better-auth/plugins'
import { authConfig, emailCodesOn } from './auth-methods.ts'
import { accountLinkingHooks, mapGoogleProfile, mapMicrosoftProfile, mapOidcProfile } from './account-linking.ts'
import { auditHooks, recordAuthEndpoint } from './audit.ts'
import { CLIENT_IP_HEADER } from './client-ip.ts'
import { mergeDatabaseHooks } from './db-hooks.ts'
import { githubProvider } from './github-sign-in.ts'
import { db } from './db.ts'
import { finishEmailChange, guardEmailChange, sameAnswerForEmailChange, sendEmailChangeCode } from './email-change.ts'
import { emailSender } from './email.ts'
import { confirmationCodeEmail as confirmationCodeTemplate, signInCodeEmail } from './emails/templates.ts'
import { refuseExistingMember } from './invitations.ts'
import { countSignInFailures, limitSignIns } from './sign-in-limits.ts'
import { refuseWhileImpersonating } from './impersonation-guard.ts'
import { instanceAdminHooks } from './instance-admin.ts'
import {
  guardPasskeyChanges,
  notifyPasskeyChange,
  passkeyPlugin,
  passkeyRelyingParty,
  refuseUnverifiedPasskey,
} from './passkeys.ts'
import {
  ALLOWED_TRIES,
  afterPasswordReset,
  endSessionsAfterReset,
  guardPasswordReset,
  PASSWORD_RESET_PATHS,
  sameAnswerForRefusedCodes,
  sendPasswordResetCode,
} from './password-reset.ts'
import { maySendSignInCode } from './signup-gate.ts'
import { starOnGrantHooks } from './star-prompt.ts'
import { personNameHooks } from './team-member-edit.ts'
import { clearProfileChangeAfterOwnUpdate } from './user-avatar.ts'
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
  const bad = (why: string) =>
    new Error(`WEB_ORIGIN must be an http(s) address like https://app.example.com (${why}): ${origin}`)
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
 * localhost address next to its public tunnel (dev mode runs with NODE_ENV=production, so this is not
 * tied to it). Every origin listed can use the session cookie: leave it empty on real installs.
 */
function devOrigins(): string[] {
  const raw = process.env.LINEDESK_DEV_ORIGINS?.trim()
  if (!raw) return []
  console.warn(`LINEDESK_DEV_ORIGINS is set: sign-ins are also accepted from ${raw} (local development only).`)
  return raw
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
    .map(normaliseOrigin)
}

export const TRUSTED_ORIGINS: readonly string[] = [...new Set([normaliseOrigin(WEB_ORIGIN), ...devOrigins()])]

/**
 * How many workspaces a member can create (`WORKSPACE_LIMIT` in .env): a positive whole number, or unset or empty for
 * no limit (the default). Anything else stops the API at start instead of quietly running without the limit meant.
 */
export function parseWorkspaceLimit(raw: string | undefined): number | null {
  const value = raw?.trim()
  if (!value) return null
  if (!/^[1-9][0-9]{0,8}$/.test(value))
    throw new Error(
      `WORKSPACE_LIMIT must be a positive whole number (the most workspaces one member can create), or empty for no limit; got "${value}"`,
    )
  return Number(value)
}

/** The workspace limit per member; null: none. */
export const WORKSPACE_LIMIT = parseWorkspaceLimit(process.env.WORKSPACE_LIMIT)

/** What a member hears at the limit: the app's New workspace and the setup agent say the same. */
export const workspaceLimitText = (limit: number) => `You can create up to ${limit} workspaces.`

/** Where the browser asks for a passkey challenge, and how often one address may (per minute). */
export const PASSKEY_CHALLENGE_PATH = '/passkey/generate-authenticate-options'
export const PASSKEY_CHALLENGE_LIMIT = { window: 60, max: 20 }

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

/**
 * The email code endpoints (sign-in, confirmation, password reset, email change) are there only while email can go
 * out. The plugin is always loaded, so email connected in Server admin › Providers turns them on without a restart.
 */
export const isEmailCodePath = (path: string) => path.startsWith('/email-otp/') || path.endsWith('/email-otp')
function refuseEmailCodesWithoutEmail(ctx: { path: string }) {
  if (isEmailCodePath(ctx.path) && !emailCodesOn()) throw new APIError('NOT_FOUND')
}

const beforeAuthEndpoints = createAuthMiddleware(async ctx => {
  refuseEmailCodesWithoutEmail(ctx)
  refuseIdTokenSignIn(ctx)
  await limitSignIns(ctx)
  await refuseWhileImpersonating(ctx)
  await guardPasskeyChanges(ctx)
  refuseUnverifiedPasskey(ctx)
  await guardPasswordReset(ctx)
  // The first step of proving the current address is answered from here (email-change.ts).
  return guardEmailChange(ctx)
})

// After: wrong codes and passwords count towards their limits (sign-in-limits.ts); the audit log
// records the auth endpoints that change how someone signs in (audit.ts), a name the person changed themselves
// clears "Last changed by" on their profile (user-avatar.ts), and the account is
// emailed when a passkey is added or removed (passkeys.ts). A password reset ends the account's
// sessions once more, and every refused reset or email change code gets one answer (password-reset.ts,
// email-change.ts): last, since that replaces the response. An email change ends the other sessions and
// tells the old address first, so nothing after it can skip that.
const afterAuthEndpoints = createAuthMiddleware(async ctx => {
  // First: once an address changed, the other sessions end and the old address is told, whatever follows.
  await finishEmailChange(ctx)
  await countSignInFailures(ctx)
  await recordAuthEndpoint(ctx)
  await clearProfileChangeAfterOwnUpdate(ctx)
  await notifyPasskeyChange(ctx)
  await endSessionsAfterReset(ctx)
  sameAnswerForRefusedCodes(ctx)
  sameAnswerForEmailChange(ctx)
})

/**
 * Workspaces are created, renamed and removed only through Linedesk: workspace.create makes the
 * assistant and settings with it (workspace-creation-handlers.ts, for the app's POST /v1/workspaces,
 * the setup MCP and Server admin), and nothing else may delete a workspace and leave its numbers,
 * contacts and assistants behind. Better Auth's own endpoints for these are off over HTTP. Only the
 * seed and the workspace-create.ts CLI still call `auth.api.createOrganization`: Better Auth's
 * `organizationLimit` guards nothing else; workspace.create applies WORKSPACE_LIMIT itself.
 */
const WORKSPACE_WRITE_PATHS = ['/organization/create', '/organization/update', '/organization/delete']
const TEAM_WRITE_PATHS = [
  '/organization/invite-member',
  '/organization/cancel-invitation',
  '/organization/update-member-role',
  '/organization/remove-member',
  '/organization/leave',
  '/organization/reject-invitation',
]
// Better Auth's reads that show pending invitees' addresses to every member; team.list shows them to owners and admins only.
const INVITATION_READ_PATHS = ['/organization/get-full-organization', '/organization/list-invitations']
// Better Auth's endpoints that hand a signed-in account's provider tokens to the browser. Linedesk
// never needs them there, and a script injected into the page would get the member's GitHub token.
const PROVIDER_TOKEN_PATHS = ['/get-access-token', '/account-info', '/refresh-token']
/**
 * The plugin's plain verification check is not offered, nor its older duplicate of
 * request-password-reset. The password reset itself (password-reset.ts) is on only where password
 * sign-in is; the email change (email-change.ts) wherever email codes are.
 */
const UNUSED_EMAIL_CODE_PATHS = ['/forget-password/email-otp', '/email-otp/check-verification-otp']
/**
 * Better Auth's "Confirm your email" link: off, the app confirms addresses with codes (sign-in, ConfirmEmail). With no
 * `emailVerification` set it sends nothing, but `/verify-email` would still take a signed token, so both are closed.
 */
const EMAIL_LINK_PATHS = ['/send-verification-email', '/verify-email']
const OFF_PASSWORD_RESET_PATHS = methods.password ? [] : PASSWORD_RESET_PATHS

export { signInCodeEmail }

/**
 * The code that confirms a signed-in member's own address (only asked for by them, see
 * sign-in-limits.ts). Names the site it is for (the address people open, as for passkeys), so a code
 * someone asks for elsewhere stands out.
 */
export const confirmationCodeEmail = (otp: string, env: Record<string, string | undefined> = process.env) =>
  confirmationCodeTemplate(otp, passkeyRelyingParty(env).origin)

/** Sign-in, confirmation, password reset and email change codes. */
async function sendSignInCode({ email, otp, type }: { email: string; otp: string; type: string }, ctx?: unknown) {
  if (type === 'change-email') return sendEmailChangeCode(email, otp, ctx)
  if (type === 'email-verification') {
    await emailSender.send({ to: email, ...confirmationCodeEmail(otp) })
    return
  }
  if (type === 'forget-password') return sendPasswordResetCode(email, otp)
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
  // A reset by emailed code (password-reset.ts) ends every session of the account.
  // No open sign-up (signup-gate.ts): the endpoint is off before it looks the address up, so it cannot tell which
  // addresses have an account. Accounts with a password still sign in with it.
  emailAndPassword: {
    enabled: methods.password,
    disableSignUp: true,
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: afterPasswordReset,
  },
  databaseHooks: mergeDatabaseHooks(
    personNameHooks,
    instanceAdminHooks,
    accountLinkingHooks,
    auditHooks,
    starOnGrantHooks,
    adminAlertHooks,
  ),
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
  account: {
    accountLinking: { enabled: true, trustedProviders, requireLocalEmailVerified: false },
    encryptOAuthTokens: true,
    // A provider sign-in's state lives in one encrypted, browser-bound cookie for 10 minutes. Better
    // Auth's default keeps it in the database for 10 minutes but checks a second cookie that lasts
    // only 5, so a sign-in that took longer (a slow account chooser, MFA) failed with state_mismatch.
    storeStateStrategy: 'cookie',
  },
  // On in every environment, not only when NODE_ENV says production. A passkey challenge is asked for without an
  // account (the sign-in page, and the browser's passkey suggestion in its email field) and each one is stored until it
  // expires: at most PASSKEY_CHALLENGE_LIMIT per minute per address (expired ones are deleted daily, verifications.ts).
  rateLimit: { enabled: true, customRules: { [PASSKEY_CHALLENGE_PATH]: PASSKEY_CHALLENGE_LIMIT } },
  // The client address comes from our own header (client-ip.ts), never from one the client sets.
  advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
  // Members and invitations change only through the team.* actions (team.ts), which apply the
  // workspace's rules (last owner, who may change an owner). Accepting stays Better Auth's endpoint.
  disabledPaths: [
    ...UNUSED_EMAIL_CODE_PATHS,
    ...EMAIL_LINK_PATHS,
    ...OFF_PASSWORD_RESET_PATHS,
    ...PROVIDER_TOKEN_PATHS,
    ...TEAM_WRITE_PATHS,
    ...INVITATION_READ_PATHS,
    ...WORKSPACE_WRITE_PATHS,
  ],
  hooks: { before: beforeAuthEndpoints, after: afterAuthEndpoints },
  // Set by user.impersonate only (impersonation.ts); `input: false` keeps clients from setting it.
  // passkeyVerifiedAt: set by the session.create hook on a passkey sign-in (admin-second-factor.ts).
  // A sign-in lasts 30 days and is renewed at most once a day while it is used: a member who opens
  // Linedesk at least once a month stays signed in. Impersonations keep their own end (impersonation-guard.ts).
  session: {
    expiresIn: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
    additionalFields: {
      impersonatedBy: { type: 'string', required: false, input: false },
      passkeyVerifiedAt: { type: 'date', required: false, input: false },
      // Unused since the one-level setup link (2026-11-15): was set when a passkey sign-in gave a setup link its email
      // and sign-in grant. Kept until a later contract step (expand/contract, docs/architecture.md §11).
      passkeyGrantUsedAt: { type: 'date', required: false, input: false },
    },
  },
  plugins: [
    organization({
      // No limit unless WORKSPACE_LIMIT sets one: Better Auth checks the count only when this is a number.
      organizationLimit: WORKSPACE_LIMIT ?? undefined,
      // Only the invited address, and only once it is verified, can accept.
      requireEmailVerificationOnInvitation: true,
      organizationHooks: {
        beforeAcceptInvitation: refuseExistingMember,
        // An owner who joins through the invitation page starts the setup emails' clock (memberships.ts, ownerJoined).
        afterAcceptInvitation: async ({ member }) => {
          const { ownerJoined } = await import('./memberships.ts')
          await ownerJoined(db, member.organizationId, member.role, new Date().toISOString()).catch(err =>
            console.error('setup event signup failed', err),
          )
        },
        // Its cloned voices are deleted at the provider too.
        beforeDeleteOrganization: async ({ organization }) => {
          await db.transaction(tx => releaseWorkspaceClones(tx, organization.id))
        },
      },
    }),
    // Email sign-in by a typed code: 6 digits, 10 minutes, 3 tries per code, stored hashed, at most 3 requests a minute per IP.
    // The same codes move an account to a new address (email-change.ts). Answered only while email can go out
    // (refuseEmailCodesWithoutEmail), so connecting email needs no restart.
    emailOTP({
      sendVerificationOTP: sendSignInCode,
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: ALLOWED_TRIES,
      storeOTP: 'hashed',
      rateLimit: { window: 60, max: 3 },
      changeEmail: { enabled: true },
    }),
    // Passkeys sign in existing accounts only; they are added in Account settings (passkeys.ts).
    ...(methods.passkey ? [passkeyPlugin(process.env)] : []),
    // Like Google: no email unless the provider says it is verified (`email_verified`) or the address is on a domain listed in OIDC_TRUST_EMAIL_DOMAINS, so an unproven address creates nobody.
    ...(oidc
      ? [
          genericOAuth({
            config: [
              {
                providerId: 'oidc',
                clientId: oidc.clientId,
                clientSecret: oidc.clientSecret,
                discoveryUrl: oidc.discoveryUrl,
                scopes: ['openid', 'profile', 'email'],
                pkce: true,
                mapProfileToUser: profile => mapOidcProfile(profile),
              },
            ],
          }),
        ]
      : []),
  ],
})
