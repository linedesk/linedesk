// One email, one account (docs/architecture.md, "Sign-in providers and account linking"). A provider
// sign-in lands in the account with the same email, whichever way that account was made (email code,
// invitation, another provider), but only when the provider proves the address is verified. A
// provider that cannot prove it signs nobody in: its user has no email, and Better Auth stops with
// `email_not_found` before it looks up or creates a user. GitHub's rule is in github-sign-in.ts.
import {
  account,
  agent_setup_keys,
  api_keys,
  assistants,
  app_connections,
  calendar_connections,
  integration_subscriptions,
  invitation,
  member,
  passkey,
  phone_numbers,
  push_subscriptions,
  session,
  user,
  webhook_endpoints,
} from '@linedesk/db'
import { DEFAULT_TRANSFERS } from '@linedesk/db/types'
import { APIError } from 'better-auth/api'
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import { type AuthEventName, recordAuthEvent, urlHost } from './audit.ts'
import { db } from './db.ts'
import { lockSetupKeysOf, revokePersonalKeysOf } from './passkey-enrolment.ts'

/** Microsoft's tenant for personal accounts (Outlook.com, Hotmail, Live): Microsoft verifies their addresses. */
export const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'

const isTrue = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1'

/**
 * Whether a Microsoft ID token proves its `email`: a personal account, or a work account whose
 * tenant owns the email's domain (`xms_edov`, an optional claim the app registration must add) or
 * that lists the address as a verified primary email (`verified_primary_email`, optional claim).
 * A plain `email` claim from a work account is not proof: any tenant can set it to any address.
 */
export function microsoftEmailVerified(claims: Record<string, unknown>): boolean {
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null
  if (!email) return false
  if (claims.tid === MICROSOFT_CONSUMER_TENANT) return true
  if (isTrue(claims.xms_edov)) return true
  const primary = claims.verified_primary_email
  const listed = Array.isArray(primary) ? primary : typeof primary === 'string' ? [primary] : []
  return listed.some(address => typeof address === 'string' && address.toLowerCase() === email)
}

/** Better Auth `mapProfileToUser` for Microsoft: no email unless the token proves it. */
export const mapMicrosoftProfile = (claims: Record<string, unknown>) =>
  microsoftEmailVerified(claims) ? { emailVerified: true } : { email: null, emailVerified: false }

/** Better Auth `mapProfileToUser` for Google: no email unless Google says it is verified. */
export const mapGoogleProfile = (profile: { email_verified?: unknown }) =>
  isTrue(profile.email_verified) ? { emailVerified: true } : { email: null, emailVerified: false }

/** `OIDC_TRUST_EMAIL_DOMAINS`: the domains the OIDC provider owns, lower case. */
export const oidcTrustedEmailDomains = (env: Record<string, string | undefined> = process.env) =>
  (env.OIDC_TRUST_EMAIL_DOMAINS ?? '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean)

/** Whether `email` is on one of `domains` exactly (a subdomain is another domain the IdP may not own). */
function onTrustedDomain(email: unknown, domains: string[]): boolean {
  if (typeof email !== 'string' || domains.length === 0) return false
  const at = email.lastIndexOf('@')
  return (
    at > 0 &&
    domains.includes(
      email
        .slice(at + 1)
        .trim()
        .toLowerCase(),
    )
  )
}

/**
 * Better Auth `mapProfileToUser` for the OIDC provider: the same rule as Google (`email_verified`),
 * or, opted in with `OIDC_TRUST_EMAIL_DOMAINS`, an address on a domain the provider owns (identity
 * providers like a company's own Keycloak often send no `email_verified`). A provider that does send
 * the claim is taken at its word, also when it says false.
 */
export function mapOidcProfile(
  profile: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
) {
  const proven =
    profile.email_verified === undefined
      ? onTrustedDomain(profile.email, oidcTrustedEmailDomains(env))
      : isTrue(profile.email_verified)
  return proven ? { emailVerified: true } : { email: null, emailVerified: false }
}

/**
 * Everything that got into an account before its address was proven, removed in one transaction:
 * other sign-in accounts (the password, providers), passkeys, sessions, push subscriptions, personal API keys, API keys
 * the account created (revoked, with their integration subscriptions), webhook endpoints and calendar connections it created, and invitations
 * it sent that are still pending, and where calls go in the workspaces it owns (resetCallRoutingOf).
 * Whoever held an account made with another person's address (a password sign-up from before
 * sign-up closed, #734) must keep no way in and no way to receive their data. Workspaces and their members stay (they are the account's now); `keepAccountId`
 * is the provider account being linked, which proves the address.
 */
export async function dropUnprovenAccessOf(userId: string, keepAccountId?: string) {
  const { reset, withdrawn, dropped } = await db.transaction(async tx => {
    // The person's setup-link lock first, as every revoke (#832 N6): a link made at this moment is ended below.
    await lockSetupKeysOf(tx, userId)
    await tx
      .delete(account)
      .where(
        keepAccountId ? and(eq(account.userId, userId), ne(account.id, keepAccountId)) : eq(account.userId, userId),
      )
    await tx.delete(passkey).where(eq(passkey.userId, userId))
    await tx.delete(session).where(eq(session.userId, userId))
    // As push.ts dropUserPush; not imported, push.ts reaches back to auth.ts.
    await tx.delete(push_subscriptions).where(eq(push_subscriptions.user_id, userId))
    const revokedKeys = await tx
      .update(api_keys)
      .set({ revoked_at: new Date().toISOString() })
      .where(and(eq(api_keys.created_by, userId), isNull(api_keys.revoked_at)))
      .returning({ id: api_keys.id, name: api_keys.name, workspaceId: api_keys.workspace_id })
    // And their Zapier subscriptions, as integrations.ts dropKeySubscriptions; not imported, integrations.ts reaches
    // back to auth.ts (through webhooks.ts).
    const subscriptions =
      revokedKeys.length > 0
        ? await tx
            .delete(integration_subscriptions)
            .where(
              inArray(
                integration_subscriptions.api_key_id,
                revokedKeys.map(k => k.id),
              ),
            )
            .returning({ event: integration_subscriptions.event, workspaceId: integration_subscriptions.workspace_id })
        : []
    // So are AI agent setup links (agent-setup.ts); an unproven account is no instance admin, but never keep one.
    const setupLinks = await tx
      .update(agent_setup_keys)
      .set({ revoked_at: new Date().toISOString(), ended_reason: 'account_recovery' })
      .where(and(eq(agent_setup_keys.created_by, userId), isNull(agent_setup_keys.revoked_at)))
      .returning({ workspaceId: agent_setup_keys.workspace_id })
    // And its personal API keys: each acts as the account (LIN-339 security review).
    const personalKeys = await revokePersonalKeysOf(tx, userId)
    const webhooks = await tx
      .delete(webhook_endpoints)
      .where(eq(webhook_endpoints.created_by, userId))
      .returning({ url: webhook_endpoints.url, workspaceId: webhook_endpoints.workspace_id })
    // A calendar it connected would receive bookings with callers' details.
    const calendars = await tx
      .delete(calendar_connections)
      .where(eq(calendar_connections.connected_by, userId))
      .returning({ provider: calendar_connections.provider, workspaceId: calendar_connections.workspace_id })
    // So would an app it connected (HubSpot): every finished call goes there.
    const apps = await tx
      .delete(app_connections)
      .where(eq(app_connections.connected_by, userId))
      .returning({ provider: app_connections.provider, workspaceId: app_connections.workspace_id })
    const withdrawn = await tx
      .update(invitation)
      .set({ status: 'canceled' })
      .where(and(eq(invitation.inviterId, userId), eq(invitation.status, 'pending')))
      .returning({ email: invitation.email, workspaceId: invitation.organizationId })
    const dropped: Dropped[] = [
      ...revokedKeys.map(k => ({ event: 'api_key_dropped' as const, method: k.name, workspaceId: k.workspaceId })),
      ...subscriptions.map(s => ({
        event: 'zapier_subscription_dropped' as const,
        method: s.event,
        workspaceId: s.workspaceId,
      })),
      ...setupLinks.map(l => ({ event: 'setup_link_dropped' as const, method: null, workspaceId: l.workspaceId })),
      ...personalKeys.map(k => ({ event: 'personal_key_dropped' as const, method: k.name, workspaceId: null })),
      // The host only: a webhook URL's path or query can carry the receiver's token (urlHost).
      ...webhooks.map(w => ({ event: 'webhook_dropped' as const, method: urlHost(w.url), workspaceId: w.workspaceId })),
      ...calendars.map(c => ({ event: 'calendar_dropped' as const, method: c.provider, workspaceId: c.workspaceId })),
      ...apps.map(a => ({ event: 'app_dropped' as const, method: a.provider, workspaceId: a.workspaceId })),
    ]
    return { reset: await resetCallRoutingOf(tx, userId), withdrawn, dropped }
  })
  // In the audit log, per workspace (after the transaction: the log never stops the cleanup). Each cancelled
  // invitation as team.ts cancelSentInvitations writes it (LIN-504; inline like the cleanups above, so auth.ts
  // never loads team.ts).
  for (const workspaceId of reset) await recordAuthEvent({ event: 'call_routing_reset', userId, workspaceId })
  for (const invite of withdrawn)
    await recordAuthEvent({
      event: 'invitation_withdrawn',
      userId,
      method: invite.email,
      workspaceId: invite.workspaceId,
    })
  // And every key, link, webhook and connection removed, one line each where it was (LIN-523).
  for (const item of dropped) await recordAuthEvent({ userId, ...item })
}

/** One thing dropUnprovenAccessOf removed, as its audit line: what it was (`method`) and where. */
type Dropped = { event: AuthEventName; method: string | null; workspaceId: string | null }

/**
 * Where calls go, set up in the workspaces the account created before its address was proven: the
 * assistants' transfer contacts (back to the default, without a number) and numbers marked as
 * forwarding every call go back to the defaults. Returns the workspaces where something changed.
 * Only workspaces it owns and was the first member of (the one who created it): an unconfirmed account
 * cannot be made owner or admin of someone else's workspace (membership.add invites it instead,
 * membership.setRole refuses), and if it were, that business's call routing stays as it is.
 */
/** An assistant with a transfer contact that has a number (switched on or not). */
const hasTransferNumber = sql`jsonb_path_exists(${assistants.transfers}, '$[*] ? (@.number != null)')`

async function resetCallRoutingOf(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userId: string) {
  const owned = await tx
    .select({ id: member.organizationId })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        eq(member.role, 'owner'),
        sql`not exists (select 1 from member earlier where earlier.organization_id = ${member.organizationId} and earlier.created_at < ${member.createdAt})`,
      ),
    )
  const ids = owned.map(row => row.id)
  if (!ids.length) return []
  const transfers = await tx
    .update(assistants)
    .set({ transfers: DEFAULT_TRANSFERS, transfer_urgent: false, transfer_number: null })
    .where(
      and(
        inArray(assistants.workspace_id, ids),
        or(eq(assistants.transfer_urgent, true), isNotNull(assistants.transfer_number), hasTransferNumber),
      ),
    )
    .returning({ workspaceId: assistants.workspace_id })
  const forwards = await tx
    .update(phone_numbers)
    .set({ mode: 'forward_conditional' })
    .where(and(inArray(phone_numbers.workspace_id, ids), eq(phone_numbers.mode, 'forward_all')))
    .returning({ workspaceId: phone_numbers.workspace_id })
  return [...new Set([...transfers, ...forwards].map(row => row.workspaceId))]
}

/**
 * Better Auth `account.create` hook. A provider account joins a user whose email was never verified
 * (an invitation, `user.invite`, or a password sign-up from before #734): the provider just proved the
 * address, so Better Auth marks it verified. Whatever got in before without proof goes
 * (dropUnprovenAccessOf). Otherwise whoever made an account with another person's address and a
 * password would keep a way into that person's account once they sign in with Google. The new session is made after this.
 */
export async function dropUnprovenAccess(created: { id: string; userId: string; providerId: string }) {
  if (created.providerId === 'credential') return
  const [owner] = await db.select({ emailVerified: user.emailVerified }).from(user).where(eq(user.id, created.userId))
  if (!owner || owner.emailVerified) return
  await dropUnprovenAccessOf(created.userId, created.id)
}

/**
 * Better Auth `user.update` after-hook. On `/sign-in/email-otp` a user is only updated when the code
 * proved the address of an account that was not verified: Better Auth's own cleanup then removed its
 * sign-in accounts and sessions, and this removes the rest of what got in before (API keys,
 * webhooks, pending invitations, passkeys, push). The code's session is made after this.
 */
export async function dropUnprovenAccessAfterCodeSignIn(
  updated: { id: string; emailVerified?: boolean },
  ctx?: { path?: string } | null,
) {
  if (ctx?.path !== '/sign-in/email-otp' || !updated.emailVerified) return
  await dropUnprovenAccessOf(updated.id)
}

/**
 * Better Auth `session.create` before-hook for password and passkey sign-ins. Better Auth checks the
 * password or passkey, then makes the session; a confirmation (code or provider) that
 * removed it in between would otherwise leave that sign-in with a new session after its cleanup. What
 * the sign-in used must still be there when the session is made (for a passkey: any passkey, since
 * the cleanup removes all of them and an unconfirmed address cannot add one).
 */
export async function refuseSessionWithoutItsSignIn(created: { userId: string }, ctx?: { path?: string } | null) {
  if (ctx?.path === '/sign-in/email') {
    const [credential] = await db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, created.userId), eq(account.providerId, 'credential')))
      .limit(1)
    if (!credential) throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password' })
  }
  if (ctx?.path === '/passkey/verify-authentication') {
    const [key] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, created.userId)).limit(1)
    if (!key) throw new APIError('UNAUTHORIZED', { message: 'This passkey is no longer valid.' })
  }
}

export const accountLinkingHooks = {
  account: { create: { after: dropUnprovenAccess } },
  user: { update: { after: dropUnprovenAccessAfterCodeSignIn } },
  session: { create: { before: refuseSessionWithoutItsSignIn } },
}
