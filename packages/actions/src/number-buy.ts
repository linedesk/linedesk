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
  /** The area codes offered for a local number (without the trunk 0). */
  areaCodes: string[]
  /** The carrier's requirement group the numbers are ordered with (Telnyx); empty: not set up yet. */
  requirementGroupId: string
  /** The German numbers set up on the install's carrier account now, and the count that warns the admin. */
  numbers: number
  alertAt: number
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

export const germanNumbersSet = defineAction({
  name: 'germanNumbers.set',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Turn German numbers held in the install's name on or off, pick the kind (local or national 032) and the area codes of a local one, and set the carrier's requirement group they are ordered with (the install's own, approved by the carrier). Numbers already set up are kept.",
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
