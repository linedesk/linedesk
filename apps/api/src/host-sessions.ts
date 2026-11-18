// Sessions bound to the address they were made on (white-label S5 PR 5.2, docs/white-label.md "Own address"; the
// plan's "domain owner in the middle"). A partner owns the DNS of its address: it can point the name at its own server,
// pass the traffic on to ours and read what goes through, sign-in codes and session cookies included. So:
//
// - A session remembers the partner address it was made on (`session.host`, null on the install's own) and works only
//   there (context.ts): a cookie taken on a partner's address is worth nothing on the install's own or on another
//   partner's, and there it reaches only that partner's client workspaces, where the partner's team is admin anyway.
// - On a partner's address Better Auth answers only what a client needs to sign in and out: an email code or a sign-in
//   link, accepting an invitation, switching between the partner's client workspaces, its name and language. Passkeys,
//   passwords, provider sign-ins, changing the email, ending other sessions and deleting the account are done on the
//   install's own address (`main_host_only`), as are the account actions request-host.ts lists.
import { organization } from '@linedesk/db'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import { eq } from 'drizzle-orm'
import { db } from './db.ts'
import { MAIN_HOST_ONLY, type RequestHost, rememberedHostOf, resolveRequestHost } from './request-host.ts'

type AuthContext = { request?: Request; headers?: Headers; path?: string; body?: unknown } | null | undefined

/**
 * The address a Better Auth endpoint runs on: as the host middleware resolved it for the request (app.ts hands the
 * Request on), else from the headers a route passed to `auth.api` (sign-in-link-routes.ts). Without either the session
 * is made inside the server (an impersonation, Server admin only): the install's own.
 */
export function hostOfAuthContext(ctx: unknown): RequestHost {
  const c = ctx as AuthContext
  for (const source of [c?.request, c?.headers]) {
    if (!source) continue
    const remembered = rememberedHostOf(source)
    if (remembered) return remembered
    const headers = source instanceof Request ? source.headers : (source as Headers)
    if (typeof headers?.get === 'function') return resolveRequestHost(name => headers.get(name) ?? undefined)
  }
  return { kind: 'main' }
}

/** The value `session.host` holds for an address: the partner's host name, or null for the install's own. */
export const sessionHostFor = (host: RequestHost): string | null | undefined =>
  host.kind === 'partner' ? host.hostname : host.kind === 'main' ? null : undefined

/** Whether a session may be used on this address: only on the one it was made on. */
export function sessionFitsHost(sessionHost: string | null | undefined, host: RequestHost): boolean {
  const here = sessionHostFor(host)
  return here !== undefined && (sessionHost ?? null) === here
}

/**
 * Better Auth `session.create`: the session's address. No session on an address that is neither the install's nor a
 * live partner's (none reaches Better Auth; never one that would count as the install's).
 */
export const sessionHostHooks = {
  session: {
    create: {
      before: async (created: Record<string, unknown>, ctx?: unknown) => {
        const host = sessionHostFor(hostOfAuthContext(ctx))
        if (host === undefined) return false
        return { data: { ...created, host } }
      },
    },
  },
}

/**
 * What Better Auth answers on a partner's address (paths as Better Auth names them): signing in by email code (the
 * sign-in link uses the same endpoint), confirming the email, the session, signing out, invitations, switching the
 * workspace and the person's name and language. Anything else is the install's own address's.
 */
const PARTNER_HOST_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/get-session',
  '/sign-out',
  '/email-otp/send-verification-otp',
  '/sign-in/email-otp',
  '/email-otp/verify-email',
  '/organization/set-active',
  '/organization/list-user-invitations',
  '/organization/accept-invitation',
  // Which sign-in methods the account has (Account settings shows them); changing them is the install's own.
  '/list-accounts',
  '/update-user',
])

/** Email codes asked on a partner's address: to sign in or confirm the email, never to reset a password. */
const PARTNER_HOST_CODE_TYPES: ReadonlySet<string> = new Set(['sign-in', 'email-verification'])

/** What `update-user` may change on a partner's address: the name and the language (user-locale.ts). */
const PROFILE_FIELDS: ReadonlySet<string> = new Set(['name', 'locale', 'localeAuto'])

/** A session used on another address than the one it was made on. */
export const SESSION_OTHER_ADDRESS = 'session_other_address'

// i18n-ignore: Better Auth's refusal text for API clients; the web app reads the code and words it itself
const mainHostOnly = () =>
  new APIError('NOT_FOUND', { code: MAIN_HOST_ONLY, message: 'Do this at the standard sign-in page.' })

/**
 * Before every Better Auth endpoint (auth.ts): on a partner's address only PARTNER_HOST_AUTH_PATHS, an email code only
 * to sign in or confirm, `update-user` only for the name and language, and switching only to one of the partner's client
 * workspaces (context.ts would not follow a switch elsewhere anyway; this keeps the session's row clean).
 */
export async function guardPartnerHostAuth(ctx: unknown): Promise<void> {
  const host = hostOfAuthContext(ctx)
  const c = ctx as AuthContext
  // A session cookie made on another address (taken from a partner's address and replayed here, or the other way)
  // signs nothing in, on every Better Auth endpoint: no passkey, email change or account delete with it.
  // Only for a request from outside (app.ts hands Better Auth the Request); the server's own `auth.api` calls check the
  // session's address themselves (context.ts resolveCaller, sessionHere).
  if (c?.request?.headers.get('cookie')) {
    const current = await getSessionFromCtx(ctx as Parameters<typeof getSessionFromCtx>[0]).catch(() => null)
    if (current && !sessionFitsHost((current.session as { host?: string | null }).host, host))
      // i18n-ignore: Better Auth's refusal text for API clients; the web app reads the code and words it itself
      throw new APIError('UNAUTHORIZED', { code: SESSION_OTHER_ADDRESS, message: 'Sign in again.' })
  }
  if (host.kind !== 'partner') return
  const path = c?.path ?? ''
  if (!PARTNER_HOST_AUTH_PATHS.has(path)) throw mainHostOnly()
  const body = (c?.body ?? {}) as Record<string, unknown>
  if (path === '/email-otp/send-verification-otp' && !PARTNER_HOST_CODE_TYPES.has(String(body.type)))
    throw mainHostOnly()
  if (path === '/update-user' && Object.keys(body).some(key => !PROFILE_FIELDS.has(key))) throw mainHostOnly()
  if (path === '/organization/set-active') {
    const workspaceId = typeof body.organizationId === 'string' ? body.organizationId : null
    if (!workspaceId) throw mainHostOnly()
    const [row] = await db
      .select({ partnerId: organization.partnerId })
      .from(organization)
      .where(eq(organization.id, workspaceId))
    if (row?.partnerId !== host.partnerId)
      // i18n-ignore: Better Auth's refusal text for API clients; the web app reads the code and words it itself
      throw new APIError('FORBIDDEN', { code: 'other_partner', message: 'This workspace is not available here.' })
  }
}
