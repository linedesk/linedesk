// Buying numbers on the install's carrier account: the operator pays for every one, and anyone can sign up,
// so whoever is not an instance admin gets a few numbers (the buy offers: number-buy.ts) and no more. A workspace's own
// carrier account is its own money and has no limits here. Every purchase is logged in `number_purchases`, which
// outlives the number, so buying and releasing in a loop counts too; the row is committed before the carrier is
// asked, so a purchase whose action fails afterwards (and is released again) still counts.
import { number_purchases, phone_numbers, type Tx } from '@linedesk/db'
import {
  type BuyOffer,
  buyableAreaCode,
  buyingCountryOf,
  buyOfferIn,
  canBuyNumbersIn,
  countryOfNumber,
  english,
  nameInSentence,
} from '@linedesk/actions'
import { and, eq, gt, ne, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { ownCommitDb } from './db.ts'
import { workspaceLocale } from './workspace-locale.ts'

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
  return {
    perDay: positive(env.NUMBER_PURCHASES_PER_DAY, 20),
    per30Days: positive(env.NUMBER_PURCHASES_PER_30_DAYS, 100),
  }
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const since = (now: string, ms: number) => new Date(Date.parse(now) - ms).toISOString()

export const BY_AREA_CODE_ONLY =
  'Numbers on this server are bought by area code: give an area code instead of a number.'
export const NOT_WITH_API_KEY = 'Numbers on this server are bought in the app, not with an API key.'
export const NUMBER_SETUP_BUSY = 'Another number is being set up, try again in a moment.'
export const INSTALL_CAP_REACHED =
  'This server has given out as many numbers as it allows for now: try again later, or ask whoever runs it.'
const ASK_ADMIN = 'ask whoever runs this server, or use your own carrier account'

/**
 * When the carrier needs an address or documents for local numbers in the country (TelephonyError
 * `country_requirements`). Its own words, never the carrier's: those name the operator's requirements. The web app
 * matches the start (phoneSetupErrorText).
 */
export const NUMBERS_NEED_DOCUMENTS =
  "Numbers in this country can't be bought here yet: connect a number the business already has."
/** When a number order did not complete and was cancelled (`not_activated`); the operator has an ALERT in the log. */
export const NUMBER_NOT_ACTIVATED = 'This number could not be activated: try another area code.'

/** The start of the refusal for a purchase outside the buy offers; the web app matches it (phoneSetupErrorText). */
export const BUY_COUNTRIES_ONLY = 'Buying numbers is not available in this country on this server'

/**
 * The country a purchase is in: the country the owner was shown (buyingCountryOf, LIN-645): the workspace's as set or
 * worked out (a number, the business phone, holidays), or its hint when the install has a buy offer there, so a
 * German business left on its hint is refused a US area code instead of becoming a US workspace by the number. When
 * nothing is known (the US fallback) or the hint's country has no offer, the area code or the number being bought
 * names it: a new business in Puerto Rico buys a 787 number and the number then sets the workspace's country
 * (workspaceCountryOf). `wanted` is that area code or number; one outside the buying countries names nothing. LIN-300.
 */
export async function purchaseCountry(
  tx: Tx,
  workspaceId: string,
  wanted: { areaCode?: string; e164?: string },
  offers: readonly BuyOffer[],
): Promise<string> {
  const locale = await workspaceLocale(tx, workspaceId)
  const shown = buyingCountryOf({ country: locale.resolvedCountry, source: locale.countrySource }, offers)
  if (shown) return shown
  const named = wanted.e164
    ? countryOfNumber(wanted.e164)
    : wanted.areaCode
      ? buyableAreaCode(wanted.areaCode)?.country
      : null
  return named && canBuyNumbersIn(named) ? named : locale.resolvedCountry
}

/**
 * Why a workspace in `country` may not buy a number at all, or null: only workspaces in a country of the buy offers
 * (numberBuyOffers) can. Any carrier account, any actor: elsewhere a business connects a number it already has.
 * Q6, 2026-11-15; LIN-300.
 */
export function buyCountryRefusal(country: string, offers: readonly BuyOffer[]): string | null {
  if (buyOfferIn(offers, country)) return null
  return `${BUY_COUNTRIES_ONLY}; this workspace is in ${country}. Connect a number already in the carrier account instead: give its number (e164) without purchase.`
}

/**
 * Why the workspace may not buy in `areaCode`, or null: a number is bought in the workspace's own country, so a
 * Canadian area code is for a workspace in Canada (LIN-300), and only in an area code of the country's offer (its
 * listed codes; AREA_CODES for the US, Canada and Puerto Rico). An offer without area codes (a national number) takes
 * none.
 */
export function areaCodeCountryRefusal(areaCode: string, country: string, offer?: BuyOffer): string | null {
  if (offer?.areaCodes) {
    if (offer.areaCodes.includes(areaCode)) return null
    return offer.areaCodes.length
      ? english.t('server.api.areaCodeNotOffered', {
          areaCode,
          country: nameInSentence(country),
          areaCodes: offer.areaCodes.join(', '),
        })
      : english.t('server.api.numbersWithoutAreaCode', { country: nameInSentence(country) })
  }
  const area = buyableAreaCode(areaCode)
  if (!area) return english.t('server.api.areaCodeNotBuyable', { areaCode })
  if (area.country === country) return null
  return `Area code ${areaCode} is in ${nameInSentence(area.country)}, but this workspace is in ${nameInSentence(country)}: pick an area code there, or change the workspace's country first.`
}

/**
 * Why the workspace may not buy the number `e164` typed in, or null: like an area code, a number is bought in the
 * workspace's own country (LIN-300), so a Canadian workspace cannot buy a Jamaican number on its own account either.
 */
export function numberCountryRefusal(e164: string, country: string): string | null {
  const of = countryOfNumber(e164)
  if (of === country) return null
  const where = of ? `is in ${nameInSentence(of)}` : 'has no country'
  return `Number ${e164} ${where}, but this workspace is in ${nameInSentence(country)}: buy a number there, or change the workspace's country first.`
}

async function countPurchases(tx: Tx, where: ReturnType<typeof and>) {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(number_purchases).where(where)
  return row?.count ?? 0
}

/**
 * Why the actor may not buy a number on the install's account now, or null. Instance admins always may.
 * Purchases on the install's account run one at a time: one that comes while another is under way is refused
 * at once (NUMBER_SETUP_BUSY) instead of holding a database connection while it waits.
 */
export async function installPurchaseRefusal(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  { byNumber, now }: { byNumber: boolean; now: string },
  env: Env = process.env,
): Promise<string | null> {
  if (actor.permissions.includes('instance:admin')) return null
  // A key is a script: nobody looks at what it buys. Buying on the operator's account is for people in the app.
  if (actor.apiKeyId || actor.personalKeyId) return NOT_WITH_API_KEY
  // A search by area code stays in the area code's country (AREA_CODES); a number typed in could be anywhere.
  if (byNumber) return BY_AREA_CODE_ONLY
  // Serialised, so parallel purchases cannot all pass the counts below.
  const { rows } = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtext('number_purchases:install')) as locked`,
  )
  if (rows[0]?.locked !== true) return NUMBER_SETUP_BUSY
  // What the operator pays for: the install's account, bought by someone who is not an admin, not the free `dev` carrier.
  const counted = and(
    eq(number_purchases.carrier_account, 'install'),
    eq(number_purchases.by_admin, false),
    ne(number_purchases.provider, 'dev'),
  )
  const [held] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(phone_numbers)
    .where(
      and(
        eq(phone_numbers.workspace_id, workspaceId),
        eq(phone_numbers.carrier_account, 'install'),
        eq(phone_numbers.purchased, true),
      ),
    )
  const recent = await countPurchases(
    tx,
    and(
      counted,
      eq(number_purchases.workspace_id, workspaceId),
      gt(number_purchases.created_at, since(now, 30 * DAY_MS)),
    ),
  )
  if ((held?.count ?? 0) >= INSTALL_NUMBERS_PER_WORKSPACE || recent >= INSTALL_NUMBERS_PER_WORKSPACE) {
    return `A workspace can get ${INSTALL_NUMBERS_PER_WORKSPACE} numbers through this server: ${ASK_ADMIN}.`
  }
  if (
    (await countPurchases(
      tx,
      and(counted, eq(number_purchases.actor_id, actor.actorId), gt(number_purchases.created_at, since(now, DAY_MS))),
    )) >= INSTALL_PURCHASES_PER_USER_PER_DAY
  ) {
    return `You bought ${INSTALL_PURCHASES_PER_USER_PER_DAY} numbers today: try again tomorrow, or ${ASK_ADMIN}.`
  }
  if (
    (await countPurchases(tx, and(counted, gt(number_purchases.created_at, since(now, HOUR_MS))))) >=
    INSTALL_PURCHASES_PER_HOUR
  ) {
    return 'Too many numbers were bought on this server in the last hour: try again later.'
  }
  const caps = installPurchaseCaps(env)
  const today = await countPurchases(tx, and(counted, gt(number_purchases.created_at, since(now, DAY_MS))))
  const month = await countPurchases(tx, and(counted, gt(number_purchases.created_at, since(now, 30 * DAY_MS))))
  if (today >= caps.perDay || month >= caps.per30Days) {
    // For the operator: the install's ceiling is reached, sign-ups cannot buy numbers until it moves.
    console.error(
      `ALERT number purchases: the install-wide cap is reached (${today}/${caps.perDay} today, ${month}/${caps.per30Days} in 30 days); purchase refused for workspace ${workspaceId}`,
    )
    return INSTALL_CAP_REACHED
  }
  return null
}

/**
 * Logs a purchase about to be made, committed on its own (not in the action's transaction): if the carrier
 * then bills the number and the action fails, the attempt still counts against every limit above. Through
 * its own pool (ownCommitDb): the action's transaction holds a connection of the main one meanwhile.
 */
export async function logPurchase(
  actor: Actor,
  values: {
    workspaceId: string
    e164: string
    provider: string
    carrierAccount: 'install' | 'workspace'
  },
) {
  await ownCommitDb.insert(number_purchases).values({
    id: `np_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
    workspace_id: values.workspaceId,
    actor_id: actor.actorId,
    e164: values.e164,
    provider: values.provider,
    carrier_account: values.carrierAccount,
    by_admin: actor.permissions.includes('instance:admin'),
  })
}
