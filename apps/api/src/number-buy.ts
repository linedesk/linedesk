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

import {
  BASE_BUY_OFFERS,
  type BuyNumberType,
  type BuyOffer,
  DEFAULT_DE_AREA_CODES,
  english,
  type GermanNumbersData,
  HELD_NUMBERS_ALERT_AT,
} from '@linedesk/actions'
import { instance_settings, phone_numbers, type Tx } from '@linedesk/db'
import { and, eq, like, sql } from 'drizzle-orm'
import type { Handler } from './handler-context.ts'

const KEY = 'number_buy.de'
/** E.164 of a German number. */
const DE_PREFIX = '+49'

type Reader = Pick<Tx, 'select'>
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
  return { ...s, numbers: await heldNumbersCount(tx), alertAt: HELD_NUMBERS_ALERT_AT }
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
      areaCodes: s.numberType === 'local' ? s.areaCodes : [],
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
    return { rows: {}, data: await germanNumbersData(tx) }
  },
}
