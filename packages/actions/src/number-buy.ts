// The countries a number can be bought in, and which kind of number (decision of 2026-11-19). One list for the API,
// the app, MCP and the agent's texts: the US, Canada and Puerto Rico (local numbers by area code) always; Germany once
// an instance admin turned it on (Server admin › System › German numbers) with the carrier's approved requirement
// group: a number held in the install's own name (Linedesk Cloud: Heidelberg 06221), so the business hands in no
// documents. The API answers an install's list with `numberBuyOffers` (apps/api/src/number-buy.ts); the app reads it
// from the phone setup status (`buy`).
import { z } from 'zod'
import { type AreaCode, areaCodesIn, NUMBER_BUY_COUNTRIES } from './area-codes.ts'
import { defineAction } from './define.ts'

/** The kind of number bought: local (by area code) or national (Germany 032, no area code). */
export const BUY_NUMBER_TYPES = ['local', 'national'] as const
export type BuyNumberType = (typeof BUY_NUMBER_TYPES)[number]

/**
 * A country a number can be bought in. `areaCodes`: the area codes offered, without the trunk 0 (Germany: `6221`);
 * absent for the US, Canada and Puerto Rico, whose list is AREA_CODES; empty for a national number (no area code).
 * `ready`: the install can buy there now; false while an admin turned the country on but its carrier setup (the
 * requirement group) is missing: the app then says calmly that numbers there are being set up, and the API refuses
 * with an ALERT for the operator.
 */
export type BuyOffer = { country: string; numberType: BuyNumberType; areaCodes?: string[]; ready: boolean }

/** The offers every install has: local numbers by area code in NUMBER_BUY_COUNTRIES. */
export const BASE_BUY_OFFERS: readonly BuyOffer[] = NUMBER_BUY_COUNTRIES.map(country => ({
  country,
  numberType: 'local',
  ready: true,
}))

/** The German area codes offered while an admin set none: Heidelberg, where Linedesk has its seat. */
export const DEFAULT_DE_AREA_CODES: readonly string[] = ['6221']

/** The offer of `country` (ISO 3166-1 alpha-2, any case) in `offers`, or undefined: no number can be bought there. */
export const buyOfferIn = (offers: readonly BuyOffer[], country: string | null | undefined): BuyOffer | undefined => {
  const code = country?.trim().toUpperCase()
  return code ? offers.find(o => o.country === code) : undefined
}

/** The names of the German area codes an install offers by default (others show as the code alone). */
// i18n-ignore: a place name, the same in every language
const DE_AREA_NAMES: Readonly<Record<string, string>> = { '6221': 'Heidelberg' }

/** The area codes the buyer picks from for an offer: the listed ones, else the country's (AREA_CODES). */
export const offerAreaCodes = (offer: BuyOffer | undefined): readonly AreaCode[] => {
  if (!offer) return []
  if (!offer.areaCodes) return areaCodesIn(offer.country)
  return offer.areaCodes.map(code => ({ code, city: DE_AREA_NAMES[code] ?? '', state: '', country: offer.country }))
}

/** An area code as people dial it: with the trunk 0 in Germany (06221), as it is in North America (503). */
export const areaCodeShown = (code: string, country: string | null | undefined): string =>
  country?.toUpperCase() === 'DE' && code ? `0${code}` : code

/** Whether the buyer picks an area code for the offer: local numbers; a national one has none. */
export const offerHasAreaCode = (offer: BuyOffer | undefined): boolean => !offer || offer.numberType === 'local'

/**
 * The German numbers held in the install's name before the admin is warned: an access holds at most 10 single
 * numbers, more may need a BNetzA certificate (Vfg. 25/2006, Anlage 1). A warning only, never a block.
 */
export const HELD_NUMBERS_ALERT_AT = 8

/** `data` of germanNumbers.get and germanNumbers.set (Server admin › System › German numbers). */
export type GermanNumbersData = {
  /** German workspaces on the install's carrier account buy a number held in the install's name. */
  on: boolean
  numberType: BuyNumberType
  /**
   * The area codes offered for a local number (without the trunk 0): the one of the requirement group's address
   * (`areaCodeCity` says where), else `savedAreaCodes`.
   */
  areaCodes: string[]
  /** The town of the group's address the offered area code was found for; null: `savedAreaCodes` are offered. */
  areaCodeCity: string | null
  /** The area codes typed in Server admin, offered only while none was found for the group's address (default 6221). */
  savedAreaCodes: string[]
  /** The carrier's requirement group the numbers are ordered with (Telnyx); empty: not set up yet. */
  requirementGroupId: string
  /** The German numbers set up on the install's carrier account now, and the count that warns the admin. */
  numbers: number
  alertAt: number
}

/**
 * The requirement group's state at the carrier, for Server admin › System › German numbers. `none`: no group set;
 * `no_carrier`: the server has no carrier that orders with requirement groups; `not_found`: the carrier has no such
 * group; `unreachable`: the carrier did not answer; `mismatch`: the group is not for local German numbers to order
 * (see `mismatch`); else the carrier's status. Never blocks buying: a group in review still orders.
 */
export const GERMAN_GROUP_STATES = [
  'none',
  'no_carrier',
  'not_found',
  'unreachable',
  'mismatch',
  'approved',
  'in_review',
  'unapproved',
  'declined',
  'expired',
] as const
export type GermanGroupState = (typeof GERMAN_GROUP_STATES)[number]

/** `data` of germanNumbers.group. */
export type GermanGroupData = {
  id: string
  state: GermanGroupState
  /** What the group is for at the carrier, when it is not what German numbers need (DE, the number type, ordering). */
  mismatch: { country: string; numberType: string; action: string } | null
  /** The group's address (the seat the numbers are held at); null when the carrier has none for it. */
  address: { street: string; postalCode: string; city: string } | null
  /** The group's page in the carrier's portal; null without a carrier that has one. */
  portalUrl: string | null
  /** The area code found for the address's town (without the trunk 0); null: none found, the saved ones are offered. */
  areaCode: string | null
  /** When the carrier was asked (ISO). */
  checkedAt: string
}

export const germanNumbersGet = defineAction({
  name: 'germanNumbers.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Whether German workspaces on this install's carrier account can buy a number held in the install's name, which kind (local in the listed area codes, or national 032), the carrier's requirement group it is ordered with, and how many are set up.",
  input: z.object({}).strict(),
  permission: 'instance:admin',
  readOnly: true,
})

export const germanNumbersGroup = defineAction({
  name: 'germanNumbers.group',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The state of the carrier's requirement group German numbers are ordered with (approved, in review, declined, not found, …), its address and the area code of the address's town, which German numbers are then offered in. Read from the carrier at most every 5 minutes; refresh: true reads it now. Only reads at the carrier.",
  input: z.object({ refresh: z.boolean().optional() }).strict(),
  permission: 'instance:admin',
  readOnly: true,
})

export const germanNumbersSet = defineAction({
  name: 'germanNumbers.set',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Turn German numbers held in the install's name on or off, pick the kind (local or national 032) and the area codes of a local one, and set the carrier's requirement group they are ordered with (the install's own, approved by the carrier). The area code is the one of the group's address; areaCodes are offered only while none is found for it. Numbers already set up are kept.",
  input: z
    .object({
      on: z.boolean().optional(),
      numberType: z.enum(BUY_NUMBER_TYPES).optional(),
      areaCodes: z
        .array(z.string().regex(/^[1-9]\d{1,4}$/, 'a German area code without the leading 0, such as 6221'))
        .min(1)
        .max(20)
        .optional(),
      requirementGroupId: z
        .string()
        .trim()
        .max(100)
        .regex(/^[A-Za-z0-9_-]*$/, 'a requirement group id: letters, digits, - and _')
        .optional(),
    })
    .strict(),
  permission: 'instance:admin',
})
