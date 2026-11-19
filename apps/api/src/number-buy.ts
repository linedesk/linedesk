// The countries a number can be bought in on this install, and which kind of number (packages/actions/src/number-buy.ts,
// decision of 2026-11-19). The US, Canada and Puerto Rico always (local numbers by area code); Germany always on the
// install's carrier account, ready once an instance admin turned it on (Server admin › System › German numbers, key
// `number_buy.de`) with the carrier's requirement group: a number held in the install's own name, so the business hands
// in no documents. Until then German workspaces read that numbers are being set up (and the operator gets an ALERT);
// sign-up does not depend on it (signup-access.ts). Linedesk Cloud offers
// Heidelberg 06221, where it has its seat; a national 032 number is the other kind, for when the carrier has stock
// (config only). Only on the install's carrier account: a workspace on its own carrier account buys where its carrier
// lets it, as before. Off by default.
//
// `numberBuyOffers` is the one list the API, the app (the phone setup status), MCP and the setup agent's texts read.
//
// The area code is the one of the requirement group's address (the number must be local to the seat it is held at):
// read from the carrier when Server admin opens German numbers (`germanNumbers.group`, at most every 5 minutes, and
// at once after a save) and kept in `number_buy.de.area`, so buying never waits for the carrier. Only while none is
// found for the address are the area codes typed in Server admin offered (default 6221). The group's status never
// blocks buying: a group in review still orders, and the operator's ALERTs name its status.

import {
  BASE_BUY_OFFERS,
  type BuyNumberType,
  type BuyOffer,
  DEFAULT_DE_AREA_CODES,
  english,
  type GermanGroupData,
  type GermanGroupState,
  type GermanNumbersData,
  HELD_NUMBERS_ALERT_AT,
} from '@linedesk/actions'
import { instance_settings, phone_numbers, type Tx } from '@linedesk/db'
import { TelephonyError, type OwnedNumber, type TelephonyProvider } from '@linedesk/telephony'
import { and, eq, like, sql } from 'drizzle-orm'
import type { Handler } from './handler-context.ts'
import { telephonyProvider } from './provider-settings.ts'

const KEY = 'number_buy.de'
/** The area code found for the requirement group's address (Found), kept between reads of the carrier. */
const AREA_KEY = 'number_buy.de.area'
/** How long a read of the requirement group at the carrier is reused. */
export const GROUP_CACHE_MS = 5 * 60_000
/** E.164 of a German number. */
const DE_PREFIX = '+49'

type Reader = Pick<Tx, 'select'>
type Writer = Pick<Tx, 'select' | 'insert' | 'delete'>
/** The area code of the group's address: for that group only (another group id has its own address). */
type Found = { groupId: string; areaCode: string; city: string }
type Setting = { on: boolean; numberType: BuyNumberType; areaCodes: string[]; requirementGroupId: string }
const OFF: Setting = { on: false, numberType: 'local', areaCodes: [...DEFAULT_DE_AREA_CODES], requirementGroupId: '' }

/**
 * Refused while German numbers are on but cannot be bought yet (no requirement group, or the carrier has none in
 * stock). The web app matches the start (phoneSetupErrorText) and says it calmly; the operator gets an ALERT.
 */
export const NUMBERS_BEING_SET_UP = english.t('server.api.numbersBeingSetUp')

async function setting(tx: Reader): Promise<Setting> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, KEY))
  try {
    const value = row ? (JSON.parse(row.value) as Partial<Setting>) : {}
    const codes = Array.isArray(value.areaCodes) ? value.areaCodes.filter(c => /^[1-9]\d{1,4}$/.test(String(c))) : []
    return {
      on: value.on === true,
      numberType: value.numberType === 'national' ? 'national' : 'local',
      areaCodes: codes.length ? codes : [...DEFAULT_DE_AREA_CODES],
      requirementGroupId: typeof value.requirementGroupId === 'string' ? value.requirementGroupId : '',
    }
  } catch {
    return OFF
  }
}

async function foundArea(tx: Reader): Promise<Found | null> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, AREA_KEY))
  try {
    const value = row ? (JSON.parse(row.value) as Partial<Found>) : null
    if (!value || typeof value.groupId !== 'string' || !/^[1-9]\d{1,4}$/.test(String(value.areaCode))) return null
    return { groupId: value.groupId, areaCode: String(value.areaCode), city: String(value.city ?? '') }
  } catch {
    return null
  }
}

async function storeFoundArea(tx: Writer, found: Found | null, now: string) {
  const current = await foundArea(tx)
  if (JSON.stringify(current) === JSON.stringify(found)) return
  if (!found) {
    await tx.delete(instance_settings).where(eq(instance_settings.key, AREA_KEY))
    return
  }
  const value = JSON.stringify(found)
  await tx
    .insert(instance_settings)
    .values({ key: AREA_KEY, value, updated_at: now, updated_by: null })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now } })
}

/** The area codes offered for a local number: the one of the group's address, else the saved ones. */
async function offeredAreaCodes(tx: Reader, s: Setting): Promise<{ areaCodes: string[]; city: string | null }> {
  const found = await foundArea(tx)
  if (found && s.requirementGroupId && found.groupId === s.requirementGroupId)
    return { areaCodes: [found.areaCode], city: found.city }
  return { areaCodes: s.areaCodes, city: null }
}

/** The German numbers set up on the install's carrier account (held in the install's name). */
export async function heldNumbersCount(tx: Reader): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(phone_numbers)
    .where(and(eq(phone_numbers.carrier_account, 'install'), like(phone_numbers.e164, `${DE_PREFIX}%`)))
  return row?.count ?? 0
}

export async function germanNumbersData(tx: Reader): Promise<GermanNumbersData> {
  const s = await setting(tx)
  const offered = await offeredAreaCodes(tx, s)
  return {
    ...s,
    areaCodes: offered.areaCodes,
    areaCodeCity: offered.city,
    savedAreaCodes: s.areaCodes,
    numbers: await heldNumbersCount(tx),
    alertAt: HELD_NUMBERS_ALERT_AT,
  }
}

const groupCache = new Map<string, { at: number; data: GermanGroupData }>()
/** Forgets every read of a requirement group (a save in Server admin; tests). */
export const forgetGroupReads = () => groupCache.clear()

const STATE_OF_STATUS: Record<string, GermanGroupState> = {
  approved: 'approved',
  'pending-approval': 'in_review',
  unapproved: 'unapproved',
  declined: 'declined',
  expired: 'expired',
}

/**
 * The requirement group's state at the carrier, its address and the area code of the address's town (kept for
 * buying, AREA_KEY). Read at most every GROUP_CACHE_MS unless `refresh`. Never throws: a carrier that fails is
 * `unreachable`. Only reads at the carrier. `provider`: the install's carrier, null when none is set up.
 */
export async function germanGroup(
  tx: Writer,
  provider: TelephonyProvider | null,
  { refresh = false, now = new Date().toISOString() }: { refresh?: boolean; now?: string } = {},
): Promise<GermanGroupData> {
  const s = await setting(tx)
  const id = s.requirementGroupId
  const base: GermanGroupData = {
    id,
    state: 'none',
    mismatch: null,
    address: null,
    portalUrl: null,
    areaCode: null,
    checkedAt: now,
  }
  if (!id) return base
  if (!provider?.requirementGroup) return { ...base, state: 'no_carrier' }
  const cacheKey = `${provider.name}:${id}:${s.numberType}`
  const cached = groupCache.get(cacheKey)
  if (!refresh && cached && Date.parse(now) - cached.at < GROUP_CACHE_MS) return cached.data

  let group: Awaited<ReturnType<NonNullable<TelephonyProvider['requirementGroup']>>>
  try {
    group = await provider.requirementGroup(id)
  } catch (e) {
    // Not cached, and an older answer is dropped: the next look asks again. The carrier's words, never the key.
    groupCache.delete(cacheKey)
    console.warn(
      `german numbers: requirement group ${id} could not be read: ${e instanceof Error ? e.message : String(e)}`,
    )
    const kept = await foundArea(tx)
    return { ...base, state: 'unreachable', areaCode: kept?.groupId === id ? kept.areaCode : null }
  }
  let data: GermanGroupData
  if (!group) {
    await storeFoundArea(tx, null, now)
    data = { ...base, state: 'not_found' }
  } else {
    const address = group.address
      ? { street: group.address.street, postalCode: group.address.postalCode, city: group.address.city }
      : null
    const fits = group.country === 'DE' && group.numberType === s.numberType && group.action === 'ordering'
    const shown = { ...base, address, portalUrl: group.portalUrl }
    if (!fits) {
      await storeFoundArea(tx, null, now)
      data = {
        ...shown,
        state: 'mismatch',
        mismatch: { country: group.country, numberType: group.numberType, action: group.action },
      }
    } else {
      const areaCode = await addressAreaCode(tx, provider, id, s, address?.city ?? '', now)
      data = { ...shown, state: STATE_OF_STATUS[group.status] ?? 'unapproved', areaCode }
    }
  }
  groupCache.set(cacheKey, { at: Date.parse(now), data })
  return data
}

/** The area code of the address's town at the carrier, kept for buying; the one kept before when the carrier fails. */
async function addressAreaCode(
  tx: Writer,
  provider: TelephonyProvider,
  groupId: string,
  s: Setting,
  city: string,
  now: string,
): Promise<string | null> {
  if (s.numberType !== 'local') return null
  if (!city || !provider.localAreaCode) {
    await storeFoundArea(tx, null, now)
    return null
  }
  try {
    const areaCode = await provider.localAreaCode('DE', city)
    await storeFoundArea(tx, areaCode ? { groupId, areaCode, city } : null, now)
    return areaCode
  } catch (e) {
    console.warn(
      `german numbers: the area code of ${city} could not be read: ${e instanceof Error ? e.message : String(e)}`,
    )
    const kept = await foundArea(tx)
    return kept?.groupId === groupId ? kept.areaCode : null
  }
}

/** The requirement group's state for an operator ALERT ("; requirement group … is in_review at telnyx"); never throws. */
export async function requirementGroupNote(tx: Writer, provider: TelephonyProvider): Promise<string> {
  const group = await germanGroup(tx, provider).catch(() => null)
  if (!group || group.state === 'none') return ''
  // i18n-ignore: part of an operator log line (ALERT), never shown in the app
  return `; requirement group ${group.id} is ${group.state} at ${provider.name}`
}

/**
 * Buys a German number held in the install's name with the requirement group. An order the carrier did not activate
 * gets the operator an ALERT with the group's state (a group not approved yet is the usual reason); never blocks.
 */
export async function buyHeldNumber(
  tx: Writer,
  provider: TelephonyProvider,
  e164: string,
  requirementGroupRef: string,
  workspaceId: string,
): Promise<OwnedNumber> {
  try {
    return await provider.buyNumber(e164, { requirementGroupRef })
  } catch (e) {
    if (e instanceof TelephonyError && e.code === 'not_activated')
      // i18n-ignore: an operator log line (ALERT), never shown in the app
      alertNumbersNotReady(
        workspaceId,
        `the order of ${e164} was not activated${await requirementGroupNote(tx, provider)}`,
      )
    throw e
  }
}

/** The carrier's requirement group German numbers are ordered with; null while German numbers are off or not set up. */
export async function germanRequirementGroup(tx: Reader): Promise<string | null> {
  const s = await setting(tx)
  return s.on && s.requirementGroupId ? s.requirementGroupId : null
}

/**
 * Where a workspace can buy a number on this install. `account`: the carrier account the workspace buys on (its own,
 * or the install's); `provider`: that carrier's name. Germany only on the install's account with a carrier that
 * orders with a requirement group (Telnyx; `dev` for development). The setup agent's texts read it too.
 */
export async function numberBuyOffers(
  tx: Reader,
  { account, provider }: { account: 'install' | 'workspace'; provider: string | null },
): Promise<BuyOffer[]> {
  const offers = [...BASE_BUY_OFFERS]
  if (account !== 'install') return offers
  const s = await setting(tx)
  const carrierCan = provider === 'telnyx' || provider === 'dev'
  return [
    ...offers,
    {
      country: 'DE',
      numberType: s.numberType,
      areaCodes: s.numberType === 'local' ? (await offeredAreaCodes(tx, s)).areaCodes : [],
      ready: s.on && carrierCan && !!s.requirementGroupId,
    },
  ]
}

/** Why German numbers cannot be bought on the install's account yet, for the operator's ALERT. */
export async function germanNumbersNotReadyWhy(tx: Reader, provider: string): Promise<string> {
  const s = await setting(tx)
  // i18n-ignore: part of an operator log line (ALERT), never shown in the app
  if (!s.on) return 'German numbers are off (Server admin › System › German numbers)'
  // i18n-ignore: part of an operator log line (ALERT), never shown in the app
  if (!s.requirementGroupId) return 'the requirement group is not set (Server admin › System › German numbers)'
  // i18n-ignore: part of an operator log line (ALERT), never shown in the app
  return `the carrier ${provider} cannot order with a requirement group`
}

/** The operator's line in the log when a German workspace could not buy a number. */
export function alertNumbersNotReady(workspaceId: string, why: string) {
  console.error(`ALERT German number for workspace ${workspaceId} could not be bought: ${why}`)
}

/**
 * After a German number was bought on the install's account: from HELD_NUMBERS_ALERT_AT numbers on, the operator is
 * warned each time (an access holds at most 10 single numbers; more may need a BNetzA certificate). Never blocks.
 */
export async function warnAtHeldNumbersLimit(tx: Reader, e164: string) {
  if (!e164.startsWith(DE_PREFIX)) return
  const count = await heldNumbersCount(tx)
  if (count >= HELD_NUMBERS_ALERT_AT)
    console.error(
      `ALERT ${count} German numbers are held in this install's name on its carrier account (warning from ${HELD_NUMBERS_ALERT_AT}): more than 10 may need a BNetzA certificate; check with the lawyer before going on`,
    )
}

export const germanNumbersHandlers: Record<string, Handler> = {
  'germanNumbers.get': async ({ tx }) => ({ rows: {}, data: await germanNumbersData(tx) }),

  /** Server admin › System › German numbers: the group's state at the carrier. Read-only there; keeps the area code. */
  'germanNumbers.group': async ({ tx, telephony, now }, input: { refresh?: boolean }) => {
    const provider = telephony ?? (await telephonyProvider(tx).catch(() => null))
    return { rows: {}, data: await germanGroup(tx, provider, { refresh: input.refresh, now }) }
  },

  /** Server admin › System › German numbers. Audited (audit.ts). */
  'germanNumbers.set': async ({ tx, actor, now }, input: Partial<Setting>) => {
    const current = await setting(tx)
    const next: Setting = {
      on: input.on ?? current.on,
      numberType: input.numberType ?? current.numberType,
      areaCodes: input.areaCodes ? [...new Set(input.areaCodes)] : current.areaCodes,
      requirementGroupId: input.requirementGroupId ?? current.requirementGroupId,
    }
    const value = JSON.stringify(next)
    await tx
      .insert(instance_settings)
      .values({ key: KEY, value, updated_at: now, updated_by: actor.actorId })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actor.actorId } })
    if (next.requirementGroupId !== current.requirementGroupId || next.numberType !== current.numberType)
      forgetGroupReads()
    return { rows: {}, data: await germanNumbersData(tx) }
  },
}
