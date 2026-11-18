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
// - An email code (and the sign-in link that carries one) works only on the address it was asked on (security review of
//   S5.2, H-1): the partner sees the code its client types on its address and could otherwise sign the client in on the
//   install's own address with it, with every right of the account there.
// - A session is bound to the partner address's row (`session.host_domain_id`), not only its name (review L-3): it ends
//   when the address fails or is removed or its partner is suspended (migration 0163's triggers delete it), and a name
//   added again later is a new row, which no old session fits.
import { invitation, organization, verification } from '@linedesk/db'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import { desc, eq } from 'drizzle-orm'
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

/** The address fields of a session row (auth.ts `session.additionalFields`). */
export type SessionHost = { host?: string | null; hostDomainId?: string | null }

/**
 * What a session made on this address holds: the partner address's name and row, or nulls for the install's own.
 * Undefined for an address that is neither (nothing is made or accepted there).
 */
export const sessionHostFor = (host: RequestHost): { host: string | null; hostDomainId: string | null } | undefined =>
  host.kind === 'partner'
    ? { host: host.hostname, hostDomainId: host.domainId }
    : host.kind === 'main'
      ? { host: null, hostDomainId: null }
      : undefined

/** Whether a session (or an email code, codeFitsHost) may be used on this address: only on the one it was made on. */
export function sessionFitsHost(made: SessionHost | null | undefined, host: RequestHost): boolean {
  const here = sessionHostFor(host)
  return (
    here !== undefined &&
    !!made &&
    (made.host ?? null) === here.host &&
    (made.hostDomainId ?? null) === here.hostDomainId
  )
}

/**
 * Better Auth `session.create`: the session's address. No session on an address that is neither the install's nor a
 * live partner's (none reaches Better Auth; never one that would count as the install's).
 */
export const sessionHostHooks = {
  session: {
    create: {
      before: async (created: Record<string, unknown>, ctx?: unknown) => {
        const here = sessionHostFor(hostOfAuthContext(ctx))
        if (here === undefined) return false
        return { data: { ...created, ...here } }
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
  // Only an invitation to one of the partner's client workspaces (guardPartnerHostAuth). Listing the person's
  // invitations is not here: it would show their other business relations (review L-1); the email's link names one.
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
/** An email code (or its sign-in link) used on another address than the one it was asked on. */
export const CODE_OTHER_ADDRESS = 'code_other_address'

/** How long an email code lives (auth.ts emailOTP `expiresIn`): its address is kept as long. */
const CODE_SECONDS = 600

/**
 * The email code kinds bound to the address they were asked on, by the endpoint that takes them: signing in (the
 * sign-in link uses the same endpoint) and confirming the email (which signs in too). Password reset and email change
 * codes are the install's own address's anyway.
 */
const CODE_ENDPOINTS: Readonly<Record<string, 'sign-in' | 'email-verification'>> = {
  '/sign-in/email-otp': 'sign-in',
  '/email-otp/verify-email': 'email-verification',
}
const BOUND_CODE_TYPES: ReadonlySet<string> = new Set(Object.values(CODE_ENDPOINTS))

/** Next to Better Auth's own row for the code (`<type>-otp-<email>`), never matched by its `<type>-otp-%` cleanups. */
const codeHostIdentifier = (type: string, email: string) => `code-host-${type}-${email.toLowerCase()}`

/**
 * Better Auth's `sendVerificationOTP` (auth.ts), before the code is emailed: the address the code was asked on,
 * replacing the one of the code before (Better Auth keeps one code per address and kind, so a new code from the
 * install's own address makes signing in there work again). Throws when it cannot be stored, so no code goes out
 * without it.
 */
export async function rememberCodeHost(email: string, type: string, ctx: unknown): Promise<void> {
  if (!BOUND_CODE_TYPES.has(type)) return
  const identifier = codeHostIdentifier(type, email)
  const here = sessionHostFor(hostOfAuthContext(ctx))
  await db.transaction(async tx => {
    await tx.delete(verification).where(eq(verification.identifier, identifier))
    // An address that is neither the install's nor a live partner's (none reaches Better Auth) binds the code nowhere.
    await tx.insert(verification).values({
      id: crypto.randomUUID(),
      identifier,
      value: JSON.stringify(here ?? { host: '', hostDomainId: '' }),
      expiresAt: new Date(Date.now() + CODE_SECONDS * 1000),
    })
  })
}

/**
 * Whether the email code of this kind for this address may be used on this address: only where it was asked. A code
 * with no address stored (none since this check exists; Better Auth's server-only ones) counts as the install's own.
 */
export async function codeFitsHost(type: string, email: string, host: RequestHost): Promise<boolean> {
  const [row] = await db
    .select({ value: verification.value })
    .from(verification)
    .where(eq(verification.identifier, codeHostIdentifier(type, email)))
    .orderBy(desc(verification.createdAt))
    .limit(1)
  let made: SessionHost = { host: null, hostDomainId: null }
  if (row)
    try {
      made = JSON.parse(row.value) as SessionHost
    } catch {
      return false
    }
  return sessionFitsHost(made, host)
}

/** The code endpoints on any address: a code asked on another one is refused before Better Auth looks at it. */
async function refuseCodeFromOtherAddress(path: string, body: Record<string, unknown>, host: RequestHost) {
  const type = CODE_ENDPOINTS[path]
  if (!type) return
  const email = typeof body.email === 'string' ? body.email : ''
  if (!(await codeFitsHost(type, email, host)))
    // i18n-ignore: Better Auth's refusal text for API clients; the web app reads the code and words it itself
    throw new APIError('FORBIDDEN', { code: CODE_OTHER_ADDRESS, message: 'Ask for a new code on this page.' })
}

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
    if (current && !sessionFitsHost(current.session as SessionHost, host))
      // i18n-ignore: Better Auth's refusal text for API clients; the web app reads the code and words it itself
      throw new APIError('UNAUTHORIZED', { code: SESSION_OTHER_ADDRESS, message: 'Sign in again.' })
  }
  const path = c?.path ?? ''
  const body = (c?.body ?? {}) as Record<string, unknown>
  // Both ways: a code asked on a partner's address signs in only there, one asked on the install's own only there.
  await refuseCodeFromOtherAddress(path, body, host)
  if (host.kind !== 'partner') return
  if (!PARTNER_HOST_AUTH_PATHS.has(path)) throw mainHostOnly()
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
    if (row?.partnerId !== host.partnerId) throw otherPartner()
  }
  // Only an invitation to one of the partner's client workspaces (review L-1).
  if (path === '/organization/accept-invitation') {
    const invitationId = typeof body.invitationId === 'string' ? body.invitationId : null
    if (!invitationId) throw mainHostOnly()
    const [row] = await db
      .select({ partnerId: organization.partnerId })
      .from(invitation)
      .innerJoin(organization, eq(organization.id, invitation.organizationId))
      .where(eq(invitation.id, invitationId))
    if (row?.partnerId !== host.partnerId) throw otherPartner()
  }
}

// i18n-ignore: Better Auth's refusal text for API clients; the web app reads the code and words it itself
const otherPartner = () =>
  new APIError('FORBIDDEN', { code: 'other_partner', message: 'This workspace is not available here.' })
