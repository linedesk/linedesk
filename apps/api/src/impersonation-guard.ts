// What an instance admin may not do while signed in as another user (docs/architecture.md §12):
// nothing that changes the account's credentials or security, and nothing that would let the
// impersonation outlive its hour. Runs before Better Auth's own endpoints.
import { IMPERSONATION_MINUTES } from '@linedesk/actions'
import { APIError, getSessionFromCtx } from 'better-auth/api'

type AuthCtx = Parameters<typeof getSessionFromCtx>[0]

/**
 * Better Auth endpoints refused while impersonating: passwords (also checking one), the profile, email, deleting the account, other
 * sessions (listing them would hand out their tokens), linked sign-in accounts and their tokens,
 * passkeys (adding, renaming, removing or listing them), joining a workspace by invitation, and confirming the
 * user's email address (also asking for a confirmation code: `refusedConfirmationRequest`).
 */
export const IMPERSONATION_REFUSED_PATHS = [
  '/change-password',
  '/set-password',
  '/email-otp/reset-password',
  // Would let an admin test guesses at the user's password, or change their name and picture.
  '/verify-password',
  '/update-user',
  '/change-email',
  // Moving the account to another address (email-change.ts): the admin could then sign in as the user for good.
  '/email-otp/request-email-change',
  '/email-otp/change-email',
  // Confirming an unconfirmed member's address: the admin must not prove an address they can't read for the user.
  '/email-otp/verify-email',
  '/delete-user',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/update-session',
  '/link-social',
  '/unlink-account',
  '/list-accounts',
  '/account-info',
  '/get-access-token',
  '/refresh-token',
  '/oauth2/link',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/update-passkey',
  '/passkey/delete-passkey',
  '/passkey/list-user-passkeys',
  '/organization/accept-invitation',
] as const

export const NOT_WHILE_IMPERSONATING = 'Not possible while signed in as another user.'

/**
 * Registry actions an impersonated session may run, besides reading (docs/architecture.md §12). An
 * impersonation is for seeing Linedesk as the user does: everything else is refused centrally in
 * run-action, so no new action can give the admin access that outlasts the hour (invite themselves,
 * mint an API key, point a webhook or a transfer elsewhere, change the carrier or numbers).
 * Only the inbox triage the user would not mind, and ending the impersonation.
 */
export const IMPERSONATION_ALLOWED_WRITES: ReadonlySet<string> = new Set([
  'impersonation.stop',
  'call.markRead',
  'call.markUnread',
  'call.markDone',
  'call.markNotDone',
  'call.remind',
  'call.clearReminder',
])

/**
 * Read-only actions refused too: those that still do something outside Linedesk (send a request, start
 * a call), and the bulk export of the workspace's calls (an impersonation is for support, not for taking
 * customer data out).
 */
const IMPERSONATION_REFUSED_READS: ReadonlySet<string> = new Set(['webhook.test', 'call.lookUpCaller', 'call.askWebhook', 'carrier.test', 'assistant.startTestCall', 'knowledge.import', 'business.search', 'business.import', 'call.listen', 'call.takeOver', 'call.export', 'phoneNumber.lookupLine', 'workspace.deletePreview'])

/** Whether an impersonated session may run this action. */
export function mayRunWhileImpersonating(def: { name: string; readOnly?: boolean }): boolean {
  if (def.readOnly) return !IMPERSONATION_REFUSED_READS.has(def.name)
  return IMPERSONATION_ALLOWED_WRITES.has(def.name)
}

const refusedPath = (path: string) => IMPERSONATION_REFUSED_PATHS.some(p => path === p || path.startsWith(`${p}/`))

/**
 * `/email-otp/send-verification-otp` also sends sign-in codes, which need no session; only a confirmation code
 * (`email-verification`) for the signed-in user is refused, the request half of `/email-otp/verify-email`.
 */
const refusedConfirmationRequest = (ctx: AuthCtx) =>
  ctx.path === '/email-otp/send-verification-otp' &&
  (ctx.body as { type?: unknown } | undefined)?.type === 'email-verification'

/** Throws 403 when the request is for a refused endpoint and its session is an impersonation. */
export async function refuseWhileImpersonating(ctx: AuthCtx) {
  if (!refusedPath(ctx.path) && !refusedConfirmationRequest(ctx)) return
  const session = await getSessionFromCtx(ctx).catch(() => null)
  if ((session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy) {
    throw new APIError('FORBIDDEN', { code: 'NOT_WHILE_IMPERSONATING', message: NOT_WHILE_IMPERSONATING })
  }
}

/** An impersonation ends at the latest this long after it started, whatever the session's expiry says. */
export const impersonationEndsAt = (createdAt: Date) => new Date(createdAt.getTime() + IMPERSONATION_MINUTES * 60_000)

type SessionUpdate = { expiresAt?: Date }

/**
 * Better Auth extends a session when it is used (`updateAge`). An impersonation keeps the expiry it
 * started with. Runs in Better Auth's `session.update.before` database hook; the session being
 * refreshed is the request's (`ctx.context.session`).
 */
export function keepImpersonationExpiry(
  data: SessionUpdate,
  ctx: { context?: { session?: unknown } } | null | undefined,
) {
  const current = (ctx?.context?.session as { session?: { impersonatedBy?: string | null; expiresAt: Date } } | null)
    ?.session
  if (!data.expiresAt || !current?.impersonatedBy) return undefined
  return { data: { ...data, expiresAt: current.expiresAt } }
}
