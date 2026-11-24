// An instance admin's authenticator app (TOTP, totp.ts): the fallback to the passkey for Server admin (decisions of
// 2026-11-15, LIN-275; docs/architecture.md §12), for an emergency or a computer without the passkey. The passkey stays
// required: an admin without one is asked to add one (`enrol`), whether or not they have the app. A code from the app is
// the check, like a passkey sign-in: it marks this session (session.passkeyVerifiedAt, the one "second factor checked
// at" column every rule reads), for ADMIN_PASSKEY_HOURS. The web app then offers to add a passkey on that computer.
// Rules:
// - Only instance admins (secondFactor:own, context.ts), never while impersonating, only with a confirmed address.
// - Only an admin with a passkey adds the app, in a session that passed the passkey check. No enrolment code adds it.
// - A check with the app needs a passkey on the account too: the app never replaces it.
// - A code works once (`last_step`) and only within one 30-second step of now. Five wrong codes in a row lock the app
//   for 15 minutes; the counter is written outside the action's transaction, so a refusal never rolls it back.
// - Adding and removing it need a passkey sign-in in this session; a check with the app's code opens Server admin and
//   lets the admin add a passkey on the computer at hand, nothing else that a passkey guards (passkeySignedIn).
// - Removing it needs that passkey sign-in too. Resetting an admin's passkeys (user.resetPasskeys, user-passkeys.ts --remove)
//   removes it too: that is the recovery path for both.
// - The secret is stored encrypted with SECRETS_KEY; without one the app cannot be added.
// - Confirm and check run only through POST /v1/account/authenticator/:step (authenticator-routes.ts), which also
//   remembers the browser and alerts the admins for a new one, as for a passkey check (admin-alerts.ts).
import { AUTHENTICATOR_LOCK_MINUTES, AUTHENTICATOR_MAX_FAILURES, type AuthenticatorStartData } from '@linedesk/actions'
import { admin_authenticators, passkey, session, type Tx, user } from '@linedesk/db'
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { brandName } from './branding.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { sendNotice } from './email.ts'
import { localeForUserId } from './email-locale.ts'
import { authenticatorChangedEmail } from './emails/templates.ts'
import { Forbidden, type Handler, type HandlerCtx, type Preparer, Reject } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { decryptSecret, encryptSecret, hasSecretsKey } from './secrets.ts'
import { matchingStep, newTotpSecret, otpauthUrl } from './totp.ts'

/** The encryption slot of a user's secret: a secret copied to another user's row does not decrypt. */
export const authenticatorSlot = (userId: string) => `admin_authenticator:${userId}`

/** The actions only their own route runs (they set the device cookie, authenticator-routes.ts). */
export const AUTHENTICATOR_ROUTE_ACTIONS: readonly string[] = [
  'account.authenticatorConfirm',
  'account.authenticatorCheck',
]

/** Whether the user has a confirmed authenticator app. */
export async function hasAuthenticator(tx: Tx | typeof db, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: admin_authenticators.user_id })
    .from(admin_authenticators)
    .where(and(eq(admin_authenticators.user_id, userId), isNotNull(admin_authenticators.confirmed_at)))
  return Boolean(row)
}

/** Removes the user's authenticator app (passkeys reset, admin role taken away). Returns whether one was confirmed. */
export async function removeAuthenticator(tx: Tx, userId: string): Promise<boolean> {
  const removed = await tx
    .delete(admin_authenticators)
    .where(eq(admin_authenticators.user_id, userId))
    .returning({ confirmed: admin_authenticators.confirmed_at })
  return removed.some(r => r.confirmed !== null)
}

type Me = { id: string; email: string; emailVerified: boolean }

/** The signed-in instance admin's own account, in their own session; refuses everyone else. */
async function ownAdmin(actor: Actor): Promise<Me> {
  if (actor.impersonation || !actor.sessionId) throw new Forbidden('Only in your own signed-in session.')
  const [account] = await db.select().from(user).where(eq(user.id, actor.actorId))
  if (!account || !isInstanceAdmin(account)) throw new Forbidden('Only server admins add an authenticator app.')
  if (!account.emailVerified) throw new Forbidden('Confirm your email address first.')
  return account
}

/** Whether the account has a passkey: the app is only ever a fallback to one. */
async function hasPasskey(userId: string): Promise<boolean> {
  const [own] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId)).limit(1)
  return Boolean(own)
}

const PASSKEY_FIRST = 'Add a passkey first: the authenticator app is only the fallback to it.'

const PASSKEY_SIGN_IN = 'Confirm with your passkey first: changing the authenticator app needs it.'

/**
 * Adding the app needs a passkey on the account and a passkey sign-in in this session, not a code from the app: a
 * phished code must not swap in the attacker's app (LIN-275 security review).
 */
async function mayAdd(actor: Actor, me: Me): Promise<void> {
  if (!(await hasPasskey(me.id))) throw new Forbidden(PASSKEY_FIRST)
  if (!actor.passkeySignedIn) throw new Forbidden(PASSKEY_SIGN_IN)
}

const lockedText = `Too many wrong codes. Try again in ${AUTHENTICATOR_LOCK_MINUTES} minutes, or confirm with your passkey.`
const wrongText = 'That code is not right. Use the current code from your authenticator app.'

/**
 * Checks `typed` against the user's app (confirmed, or being added), outside the action's transaction so a refusal
 * never rolls the counter back. Each try is claimed first, in one statement that also checks the lock: requests sent
 * at the same time each count, and no more than AUTHENTICATOR_MAX_FAILURES are compared per lock window (LIN-275
 * security review). The fifth wrong code locks the app and starts the count again. A right code is used up
 * (`last_step`) in one conditional UPDATE, so the same code never passes twice. Returns the stored (encrypted) secret
 * that was checked; refuses with Reject.
 */
async function useCode(userId: string, typed: string, confirmed: boolean, now: number): Promise<string> {
  const nowIso = new Date(now).toISOString()
  const [claimed] = await db
    .update(admin_authenticators)
    .set({ failed_attempts: sql`${admin_authenticators.failed_attempts} + 1` })
    .where(
      and(
        eq(admin_authenticators.user_id, userId),
        confirmed ? isNotNull(admin_authenticators.confirmed_at) : isNull(admin_authenticators.confirmed_at),
        sql`(${admin_authenticators.locked_until} is null or ${admin_authenticators.locked_until} <= ${nowIso}::timestamptz)`,
      ),
    )
    .returning()
  if (!claimed) {
    const [row] = await db.select().from(admin_authenticators).where(eq(admin_authenticators.user_id, userId))
    if (row && (row.confirmed_at !== null) === confirmed) throw new Forbidden(lockedText)
    throw new Reject(
      confirmed ? 'No authenticator app is set up for your account.' : 'Start adding the authenticator app again.',
    )
  }
  if (claimed.failed_attempts > AUTHENTICATOR_MAX_FAILURES) throw new Forbidden(lockedText)
  const step = matchingStep(decryptSecret(claimed.secret, authenticatorSlot(userId)), typed, now, claimed.last_step)
  if (step === null) {
    if (claimed.failed_attempts >= AUTHENTICATOR_MAX_FAILURES) {
      // Locked for a while; the count starts again, so one wrong code later does not lock it at once again.
      const until = new Date(now + AUTHENTICATOR_LOCK_MINUTES * 60_000).toISOString()
      await db
        .update(admin_authenticators)
        .set({ locked_until: until, failed_attempts: 0 })
        .where(eq(admin_authenticators.user_id, userId))
    }
    throw new Forbidden(wrongText)
  }
  const used = await db
    .update(admin_authenticators)
    .set({ last_step: step, failed_attempts: 0, locked_until: null })
    .where(
      and(
        eq(admin_authenticators.user_id, userId),
        eq(admin_authenticators.secret, claimed.secret),
        sql`(${admin_authenticators.last_step} is null or ${admin_authenticators.last_step} < ${step})`,
      ),
    )
    .returning({ id: admin_authenticators.user_id })
  if (!used.length) throw new Forbidden(wrongText)
  return claimed.secret
}

/** This session now counts as checked (admin-second-factor.ts reads it), from `now`. */
async function markChecked(tx: Tx, actor: Actor, now: string) {
  await tx
    .update(session)
    .set({ passkeyVerifiedAt: new Date(now), secondFactorMethod: 'authenticator' })
    .where(and(eq(session.id, actor.sessionId!), eq(session.userId, actor.actorId)))
}

/** Tells the admin once the change is committed. */
async function notify(ctx: HandlerCtx, me: Me, change: 'added' | 'removed') {
  const email = authenticatorChangedEmail(change, undefined, await localeForUserId(ctx.tx, me.id))
  const send = async () => sendNotice({ to: me.email, ...email }, 'authenticator email')
  if (ctx.onCommit) ctx.onCommit(send)
  else await send()
}

type Prepared = { me: Me; secret?: string }

export const authenticatorPreparers: Record<string, Preparer> = {
  'account.authenticatorStart': async ({ actor }): Promise<Prepared> => {
    const me = await ownAdmin(actor)
    if (await hasAuthenticator(db, me.id)) throw new Reject('An authenticator app is set up already. Remove it first.')
    if (!hasSecretsKey()) throw new Reject('This server has no SECRETS_KEY, so it cannot store an authenticator app.')
    await mayAdd(actor, me)
    return { me }
  },
  'account.authenticatorConfirm': async ({ actor, now }, input: { code: string }) => {
    const me = await ownAdmin(actor)
    await mayAdd(actor, me)
    const secret = await useCode(me.id, input.code, false, new Date(now).getTime())
    return { me, secret } satisfies Prepared
  },
  'account.authenticatorCheck': async ({ actor, now }, input: { code: string }) => {
    const me = await ownAdmin(actor)
    // The fallback to a passkey, never instead of one: without a passkey Server admin asks to add one.
    if (!(await hasPasskey(me.id))) throw new Forbidden(PASSKEY_FIRST)
    await useCode(me.id, input.code, true, new Date(now).getTime())
    return { me } satisfies Prepared
  },
  'account.authenticatorRemove': async ({ actor }) => {
    const me = await ownAdmin(actor)
    if (!actor.passkeySignedIn) throw new Forbidden(PASSKEY_SIGN_IN)
    return { me } satisfies Prepared
  },
}

export const authenticatorHandlers: Record<string, Handler> = {
  'account.authenticatorStart': async ({ tx, prepared }) => {
    const { me } = prepared as Prepared
    const secret = newTotpSecret()
    const stored = encryptSecret(secret, authenticatorSlot(me.id))
    await tx
      .insert(admin_authenticators)
      .values({ user_id: me.id, secret: stored })
      .onConflictDoUpdate({
        target: admin_authenticators.user_id,
        set: { secret: stored, confirmed_at: null, last_step: null, failed_attempts: 0, locked_until: null },
        // Never replaces a confirmed app (checked before; this keeps it so if two requests race).
        setWhere: sql`${admin_authenticators.confirmed_at} is null`,
      })
    if (await hasAuthenticator(tx, me.id)) throw new Reject('An authenticator app is set up already. Remove it first.')
    return {
      rows: {},
      data: { secret, otpauthUrl: otpauthUrl(secret, brandName(), me.email) } satisfies AuthenticatorStartData,
    }
  },

  'account.authenticatorConfirm': async ctx => {
    const { tx, actor, now } = ctx
    const { me, secret } = ctx.prepared as Prepared
    // Only the secret the code was checked against: a Start in between replaced it, and that one is not confirmed.
    const confirmed = await tx
      .update(admin_authenticators)
      .set({ confirmed_at: now })
      .where(
        and(
          eq(admin_authenticators.user_id, me.id),
          eq(admin_authenticators.secret, secret!),
          isNull(admin_authenticators.confirmed_at),
        ),
      )
      .returning({ id: admin_authenticators.user_id })
    if (!confirmed.length) throw new Reject('Start adding the authenticator app again.')
    await markChecked(tx, actor, now)
    await notify(ctx, me, 'added')
    return { rows: {}, data: { confirmed: true } }
  },

  'account.authenticatorCheck': async ({ tx, actor, now }) => {
    await markChecked(tx, actor, now)
    return { rows: {}, data: { confirmed: true } }
  },

  'account.authenticatorRemove': async ctx => {
    const { me } = ctx.prepared as Prepared
    if (await removeAuthenticator(ctx.tx, me.id)) await notify(ctx, me, 'removed')
    return { rows: {}, data: { removed: true } }
  },
}
