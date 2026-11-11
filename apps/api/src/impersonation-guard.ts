// What an instance admin may not do while signed in as another user (docs/architecture.md §12):
// nothing that changes the account's credentials or security, and nothing that would let the
// impersonation outlive its hour. Runs before Better Auth's own endpoints.
import { IMPERSONATION_MINUTES } from '@linedesk/actions'
import { APIError, getSessionFromCtx } from 'better-auth/api'

type AuthCtx = Parameters<typeof getSessionFromCtx>[0]

/**
 * Better Auth endpoints refused while impersonating: passwords (also checking one), the profile, email, deleting the account, other
 * sessions (listing them would hand out their tokens), linked sign-in accounts and their tokens,
 * passkeys (adding, renaming, removing or listing them), and joining a workspace by invitation.
 */
export const IMPERSONATION_REFUSED_PATHS = [
  '/change-password',
  '/set-password',
  // Would let an admin test guesses at the user's password, or change their name and picture.
  '/verify-password',
  '/update-user',
  '/change-email',
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

/** Read-only actions that still do something outside Linedesk (send a request, start a call): refused too. */
const IMPERSONATION_REFUSED_READS: ReadonlySet<string> = new Set(['webhook.test', 'carrier.test', 'assistant.startTestCall'])

/** Whether an impersonated session may run this action. */
export function mayRunWhileImpersonating(def: { name: string; readOnly?: boolean }): boolean {
  if (def.readOnly) return !IMPERSONATION_REFUSED_READS.has(def.name)
  return IMPERSONATION_ALLOWED_WRITES.has(def.name)
}

const refusedPath = (path: string) => IMPERSONATION_REFUSED_PATHS.some(p => path === p || path.startsWith(`${p}/`))

/** Throws 403 when the request is for a refused endpoint and its session is an impersonation. */
export async function refuseWhileImpersonating(ctx: AuthCtx) {
  if (!refusedPath(ctx.path)) return
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
