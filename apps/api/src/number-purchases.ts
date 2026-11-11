// Buying numbers on the install's carrier account: the operator pays for every one, and anyone can sign up,
// so whoever is not an instance admin gets a few US numbers and no more. A workspace's own carrier account
// is its own money and has no limits here. Every purchase is logged in `number_purchases`, which outlives
// the number, so buying and releasing in a loop counts too; the row is committed before the carrier is
// asked, so a purchase whose action fails afterwards (and is released again) still counts.
import { number_purchases, phone_numbers, type Tx } from '@linedesk/db'
import { and, eq, gt, ne, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { ownCommitDb } from './db.ts'

/** Numbers a workspace may hold and buy (per 30 days) on the install's account, unless an instance admin buys them. */
export const INSTALL_NUMBERS_PER_WORKSPACE = 2
/** Purchases one user may make on the install's account in a day, over all their workspaces. */
export const INSTALL_PURCHASES_PER_USER_PER_DAY = 2
/** Purchases on the install's account in an hour, over the whole install (instance admins not counted). */
export const INSTALL_PURCHASES_PER_HOUR = 10

type Env = Record<string, string | undefined>
const positive = (value: string | undefined, fallback: number) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * Purchases on the install's account by members who are not instance admins, over the whole install: per day
 * and per 30 days. The operator's ceiling on what sign-ups can cost; `NUMBER_PURCHASES_PER_DAY` and
 * `NUMBER_PURCHASES_PER_30_DAYS` change it.
 */
export function installPurchaseCaps(env: Env = process.env) {
  return { perDay: positive(env.NUMBER_PURCHASES_PER_DAY, 20), per30Days: positive(env.NUMBER_PURCHASES_PER_30_DAYS, 100) }
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const since = (now: string, ms: number) => new Date(Date.parse(now) - ms).toISOString()

export const US_ONLY = 'Numbers on this Linedesk are bought by US area code: give an area code instead of a number.'
export const NOT_WITH_API_KEY = 'Numbers on this Linedesk are bought in the app, not with an API key.'
export const NUMBER_SETUP_BUSY = 'Another number is being set up, try again in a moment.'
export const INSTALL_CAP_REACHED = 'This Linedesk has given out as many numbers as it allows for now: try again later, or ask whoever runs it.'
const ASK_ADMIN = 'ask whoever runs your Linedesk, or use your own carrier account'

async function countPurchases(tx: Tx, where: ReturnType<typeof and>) {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(number_purchases).where(where)
  return row?.count ?? 0
}

/**
 * Why the actor may not buy a number on the install's account now, or null. Instance admins always may.
 * Purchases on the install's account run one at a time: one that comes while another is under way is refused
 * at once (NUMBER_SETUP_BUSY) instead of holding a database connection while it waits.
 */
export async function installPurchaseRefusal(tx: Tx, actor: Actor, workspaceId: string, { byNumber, now }: { byNumber: boolean; now: string }, env: Env = process.env): Promise<string | null> {
  if (actor.permissions.includes('instance:admin')) return null
  // A key is a script: nobody looks at what it buys. Buying on the operator's account is for people in the app.
  if (actor.apiKeyId) return NOT_WITH_API_KEY
  // A search by area code is a US search (country: 'US'); a number typed in could be anywhere.
  if (byNumber) return US_ONLY
  // Serialised, so parallel purchases cannot all pass the counts below.
  const { rows } = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext('number_purchases:install')) as locked`)
  if (rows[0]?.locked !== true) return NUMBER_SETUP_BUSY
  // What the operator pays for: the install's account, bought by someone who is not an admin, not the free `dev` carrier.
  const counted = and(eq(number_purchases.carrier_account, 'install'), eq(number_purchases.by_admin, false), ne(number_purchases.provider, 'dev'))
  const [held] = await tx.select({ count: sql<number>`count(*)::int` }).from(phone_numbers)
    .where(and(eq(phone_numbers.workspace_id, workspaceId), eq(phone_numbers.carrier_account, 'install'), eq(phone_numbers.purchased, true)))
  const recent = await countPurchases(tx, and(counted, eq(number_purchases.workspace_id, workspaceId), gt(number_purchases.created_at, since(now, 30 * DAY_MS))))
  if ((held?.count ?? 0) >= INSTALL_NUMBERS_PER_WORKSPACE || recent >= INSTALL_NUMBERS_PER_WORKSPACE) {
    return `A workspace can get ${INSTALL_NUMBERS_PER_WORKSPACE} numbers through this Linedesk: ${ASK_ADMIN}.`
  }
  if (await countPurchases(tx, and(counted, eq(number_purchases.actor_id, actor.actorId), gt(number_purchases.created_at, since(now, DAY_MS)))) >= INSTALL_PURCHASES_PER_USER_PER_DAY) {
    return `You bought ${INSTALL_PURCHASES_PER_USER_PER_DAY} numbers today: try again tomorrow, or ${ASK_ADMIN}.`
  }
  if (await countPurchases(tx, and(counted, gt(number_purchases.created_at, since(now, HOUR_MS)))) >= INSTALL_PURCHASES_PER_HOUR) {
    return 'Too many numbers were bought on this Linedesk in the last hour: try again later.'
  }
  const caps = installPurchaseCaps(env)
  const today = await countPurchases(tx, and(counted, gt(number_purchases.created_at, since(now, DAY_MS))))
  const month = await countPurchases(tx, and(counted, gt(number_purchases.created_at, since(now, 30 * DAY_MS))))
  if (today >= caps.perDay || month >= caps.per30Days) {
    // For the operator: the install's ceiling is reached, sign-ups cannot buy numbers until it moves.
    console.error(`ALERT number purchases: the install-wide cap is reached (${today}/${caps.perDay} today, ${month}/${caps.per30Days} in 30 days); purchase refused for workspace ${workspaceId}`)
    return INSTALL_CAP_REACHED
  }
  return null
}

/**
 * Logs a purchase about to be made, committed on its own (not in the action's transaction): if the carrier
 * then bills the number and the action fails, the attempt still counts against every limit above. Through
 * its own pool (ownCommitDb): the action's transaction holds a connection of the main one meanwhile.
 */
export async function logPurchase(actor: Actor, values: { workspaceId: string; e164: string; provider: string; carrierAccount: 'install' | 'workspace' }) {
  await ownCommitDb.insert(number_purchases).values({
    id: `np_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
    workspace_id: values.workspaceId, actor_id: actor.actorId, e164: values.e164, provider: values.provider, carrier_account: values.carrierAccount,
    by_admin: actor.permissions.includes('instance:admin'),
  })
}
