// A white-label partner's brand (docs/white-label.md, slice S4): the product name, logo, color, support email and terms
// and privacy links its clients see instead of the install's. In the app at once (a client workspace shows it); in
// emails only once the partner is approved and its bill has a paid invoice, so a trial cannot borrow a bank's name to
// send sign-in codes and invitations from this install. Names on the install's protected list are refused.
import { z } from 'zod'
import { brandingInput } from './branding.ts'
import { defineAction } from './define.ts'

/**
 * Why a brand change was refused, sent as the rejection's `code`: the web app shows the code's key
 * (`team.partner.brand.error.<code>`); the English stays in the API body for logs and API clients.
 */
export const PARTNER_BRAND_CODES = ['name_protected'] as const
export type PartnerBrandCode = (typeof PARTNER_BRAND_CODES)[number]

/**
 * The install's protected names until an instance admin sets its own list (Server admin › Partners): this product,
 * payment, banking and big consumer brands and agencies that phishing borrows. A partner's product name may not be
 * one of them or contain one (protectedNameIn).
 */
// i18n-ignore: brand names, never translated
export const DEFAULT_PROTECTED_NAMES: readonly string[] = [
  'Linedesk',
  'Stripe',
  'PayPal',
  'Venmo',
  'Zelle',
  'Cash App',
  'Coinbase',
  'Visa',
  'Mastercard',
  'American Express',
  'Chase',
  'Bank of America',
  'Wells Fargo',
  'Citibank',
  'Capital One',
  'IRS',
  'Social Security',
  'Medicare',
  'Google',
  'Microsoft',
  'Apple',
  'Amazon',
  'Facebook',
  'Instagram',
  'WhatsApp',
  'Netflix',
  'DocuSign',
  'FedEx',
  'USPS',
  'Twilio',
  'Telnyx',
  'OpenAI',
  'Anthropic',
]

/** Digits and signs that stand in for letters in look-alike names ("G00gle", "Paypa1", "$tripe"). */
const LOOK_ALIKES: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  $: 's',
  '@': 'a',
}

/**
 * Cyrillic and Greek letters that look like Latin ones ("Сhase" with a Cyrillic С, "Lіnedesk" with a Cyrillic і),
 * folded to the Latin letter before names are compared (security review of #1111, M-1). Upper and lower case, as some
 * capitals look Latin while their small letter does not (Greek Η, Ν).
 */
// i18n-ignore: a table of look-alike letters, not text
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  А: 'a',
  а: 'a',
  В: 'b',
  в: 'b',
  Е: 'e',
  е: 'e',
  Ё: 'e',
  ё: 'e',
  З: '3',
  І: 'i',
  і: 'i',
  Ї: 'i',
  ї: 'i',
  Ј: 'j',
  ј: 'j',
  К: 'k',
  к: 'k',
  М: 'm',
  м: 'm',
  Н: 'h',
  н: 'h',
  О: 'o',
  о: 'o',
  Р: 'p',
  р: 'p',
  С: 'c',
  с: 'c',
  Т: 't',
  т: 't',
  У: 'y',
  у: 'y',
  Х: 'x',
  х: 'x',
  Ѕ: 's',
  ѕ: 's',
  Ԁ: 'd',
  ԁ: 'd',
  Ԛ: 'q',
  ԛ: 'q',
  Ԝ: 'w',
  ԝ: 'w',
  Һ: 'h',
  һ: 'h',
  Ӏ: 'l',
  ӏ: 'l',
  Ь: 'b',
  ь: 'b',
  Ү: 'y',
  ү: 'y',
  Ԍ: 'g',
  ԍ: 'g',
  // Greek
  Α: 'a',
  α: 'a',
  Β: 'b',
  β: 'b',
  Ε: 'e',
  ε: 'e',
  Ζ: 'z',
  Η: 'h',
  Ι: 'i',
  ι: 'i',
  Κ: 'k',
  κ: 'k',
  Μ: 'm',
  Ν: 'n',
  ν: 'v',
  Ο: 'o',
  ο: 'o',
  Ρ: 'p',
  ρ: 'p',
  Τ: 't',
  τ: 't',
  Υ: 'y',
  υ: 'u',
  Χ: 'x',
  χ: 'x',
  ϲ: 'c',
  Ϲ: 'c',
  ϳ: 'j',
  ɡ: 'g',
  ı: 'i',
  // Latin letters with a stroke, which NFKD keeps (security review of #1111, N-3)
  Ø: 'o',
  ø: 'o',
  Ł: 'l',
  ł: 'l',
  Đ: 'd',
  đ: 'd',
  Ħ: 'h',
  ħ: 'h',
  // Armenian and Cherokee
  Օ: 'o',
  օ: 'o',
  Ս: 'u',
  ս: 'u',
  Ꮯ: 'c',
  Ꭺ: 'a',
  Ꭼ: 'e',
  Ꮪ: 's',
  Ꭲ: 't',
}

/** Letter pairs that read as one letter in most fonts ("Arnazon", "Wvv"): folded on both sides. */
const MULTI_LETTER: [RegExp, string][] = [
  [/rn/g, 'm'],
  [/vv/g, 'w'],
]

/**
 * A name reduced to how it reads: accents gone (NFKD also folds full-width and other compatibility letters), Cyrillic
 * and Greek look-alikes folded to Latin, lower case, look-alike digits replaced, and "i" and "l" counted as one letter
 * (a "1" may stand for either: "L1nedesk", "Paypa1"), and pairs like "rn" read as "m". Then its words: the parts between
 * anything that is not a letter or digit, so "Chase.com" is "chase" and "com", and "I.R.S." the run "l", "r", "s" that
 * protectedNameIn joins again; a possessive "'s" goes first ("Chase's Desk").
 */
function words(text: string): string[] {
  const plain = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/./gu, c => CONFUSABLES[c] ?? c)
    .toLowerCase()
    .replace(/[013457$@]/g, c => LOOK_ALIKES[c] ?? c)
    .replace(/i/g, 'l')
  const folded = MULTI_LETTER.reduce((text, [pair, letter]) => text.replace(pair, letter), plain)
  return folded
    .replace(/['’]s(?=[^\p{L}\p{N}]|$)/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** A protected name glued into a longer word ("MyPayPalDesk") counts from this many letters on; shorter ones only alone. */
const SQUASHED_FROM = 6

/**
 * The protected name `name` contains, or null. A name counts when one or more words in a row spell it, punctuation
 * left out ("Chase Support", "I.R.S. Help", "Bank-of-America desk", "Bank of America"), or, for a name of at least six
 * letters, anywhere in the name with spaces taken out ("Line Desk", "googlecalls"). Accents, look-alike digits and
 * Cyrillic or Greek look-alike letters are ignored. Short names count only as whole words, so "Chasewood" and
 * "Visalia" stay free.
 */
export function protectedNameIn(name: string, protectedNames: readonly string[]): string | null {
  const have = words(name)
  const squashed = have.join('')
  for (const candidate of protectedNames) {
    const wanted = words(candidate).join('')
    if (!wanted) continue
    if (wanted.length >= SQUASHED_FROM && squashed.includes(wanted)) return candidate
    for (let i = 0; i < have.length; i++) {
      let run = ''
      for (let j = i; j < have.length && run.length < wanted.length; j++) {
        run += have[j]
        if (run === wanted) return candidate
      }
    }
  }
  return null
}

const partnerId = z.string().min(1).max(64)
const email = z.string().trim().toLowerCase().pipe(z.email().max(254))
// i18n-ignore: the API's validation message for API clients; the web app checks first (team.partner.brand.urlInvalid)
const URL_TOO_LONG = 'At most 500 characters.'
// i18n-ignore: the API's validation message for API clients; the web app checks first (team.partner.brand.urlInvalid)
const URL_NOT_HTTPS = 'Use a full https:// link.'
/** A link shown to clients: https only, nothing a browser would run. */
const httpsUrl = z
  .string()
  .trim()
  .max(500, URL_TOO_LONG)
  .refine(value => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
    } catch {
      return false
    }
  }, URL_NOT_HTTPS)

export const partnerBrandInput = z.object({
  partnerId,
  name: brandingInput.shape.name,
  color: brandingInput.shape.color,
  /** A PNG as a data URL; null removes the logo; left out keeps the current one. */
  logo: brandingInput.shape.logo,
  supportEmail: email.nullable(),
  termsUrl: httpsUrl.nullable(),
  privacyUrl: httpsUrl.nullable(),
})
export type PartnerBrandInput = z.infer<typeof partnerBrandInput>

/** The partner's saved brand, as `partnerBrand.get` and `partnerBrand.set` return it. */
export type PartnerBrand = {
  name: string
  color: string | null
  /** /v1/branding/partners/<id>/logo.png?v=<version>, or null without a logo. */
  logoUrl: string | null
  supportEmail: string | null
  termsUrl: string | null
  privacyUrl: string | null
}

/**
 * Where the brand stands with the instance admins (security review of #1111, M-2): `none` (never approved: clients and
 * emails get the install's), `pending` (the draft differs from the approved version: clients and emails keep the
 * approved one until an admin approves the change), `approved` (the draft is the approved version).
 */
export type PartnerBrandReviewState = 'none' | 'pending' | 'approved'

/**
 * `partnerBrand.get`: the partner's draft brand (null: none yet, clients see the install's), the version an instance
 * admin approved (what clients and emails get), and whether emails carry it. Emails carry the approved version once the
 * partner is `approved` and its bill has a paid subscription invoice and runs (`paid`; true where the install has no
 * billing). `canEdit`: the caller is the partner's owner and the partner is not suspended.
 */
export type PartnerBrandData = {
  brand: PartnerBrand | null
  review: { state: PartnerBrandReviewState; approved: PartnerBrand | null; approvedAt: string | null }
  emails: { active: boolean; approved: boolean; paid: boolean }
  canEdit: boolean
}

/** One partner's brand as Server admin › Partners › Brands reviews it (`partnerBrand.reviews`). */
export type PartnerBrandReview = {
  partnerId: string
  partner: string
  partnerStatus: string
  state: PartnerBrandReviewState
  /** Approve names it, so an admin approves the version they saw, never a later one. */
  revision: number
  /** The hash of the reviewed content (name, logo, support email, links); approve names it too. */
  contentHash: string
  draft: PartnerBrand
  approved: PartnerBrand | null
  updatedAt: string
  approvedAt: string | null
}
export type PartnerBrandReviewList = { brands: PartnerBrandReview[] }

/** Why an instance admin's brand review was refused, as the rejection's `code` (`admin.partners.brands.error.<code>`). */
export const PARTNER_BRAND_REVIEW_CODES = ['brand_changed', 'no_brand', 'name_protected'] as const
export type PartnerBrandReviewCode = (typeof PARTNER_BRAND_REVIEW_CODES)[number]

export const partnerBrandGet = defineAction({
  name: 'partnerBrand.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The partner's brand (product name, logo, color, support email, terms and privacy links) and whether workspace emails carry it yet (the partner approved and a paid invoice). Anyone on the partner's team.",
  input: z.object({ partnerId }),
  permission: 'partner',
  readOnly: true,
})

export const partnerBrandSet = defineAction({
  name: 'partnerBrand.set',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Set the partner's brand that its client workspaces show instead of the install's: product name (no protected name), logo (a PNG data URL, null removes it, left out keeps it), color, support email (Reply-To of workspace emails), terms and privacy links (https). The partner's owner only.",
  input: partnerBrandInput,
  permission: 'partner',
  // Not a secret, but up to half a megabyte: the command log notes that a logo was sent, not the image.
  sensitive: ['logo'],
})

const protectedName = z.string().trim().min(1).max(60)

export const partnerBrandProtectedNames = defineAction({
  name: 'partnerBrand.protectedNames',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The names a partner's brand may not use or contain on this install, and whether that is the built-in list. Instance admins only.",
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})

export const partnerBrandSetProtectedNames = defineAction({
  name: 'partnerBrand.setProtectedNames',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Set the names a partner's brand may not use or contain (null: back to the built-in list). Brands already saved stay; the next change is checked. Instance admins only.",
  input: z.object({ names: z.array(protectedName).max(300).nullable() }),
  permission: 'instance:admin',
})

/** `partnerBrand.protectedNames`. */
export type ProtectedNamesData = { names: string[]; builtIn: boolean }

// i18n-ignore: the API's validation message for API clients; the admin dialog checks first (admin.bills.reason.missing)
const REASON_MISSING = 'Say why, in a few words.'
/** Why an admin approved or reset a brand: kept in the audit log with the action. */
const reason = z.string().trim().min(3, REASON_MISSING).max(500)

export const partnerBrandReviews = defineAction({
  name: 'partnerBrand.reviews',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Every partner's brand: its draft, the version approved for clients and emails, and whether a change waits for review. Instance admins only.",
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})

export const partnerBrandApprove = defineAction({
  name: 'partnerBrand.approve',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Approve a partner's brand: its clients and their emails get this revision (name, logo, support email, links) from now on. Names the `revision` and `contentHash` from partnerBrand.reviews; refused when the draft is not exactly that version any more (brand_changed), or when its name is protected now (name_protected). Instance admins only, with a reason for the audit log.",
  input: z.object({
    partnerId,
    revision: z.number().int().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    reason,
  }),
  permission: 'instance:admin',
})

export const partnerBrandReset = defineAction({
  name: 'partnerBrand.reset',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Remove a partner's brand, draft and approved version: its clients and their emails get the install's brand again at once. The partner may set a new one, which waits for review. Instance admins only, with a reason for the audit log.",
  input: z.object({ partnerId, reason }),
  permission: 'instance:admin',
})
