// What the number request screens show (docs/numbers-kyc.md), without React: where a request stands, which requests
// still need a line under the numbers, the requested number as people write it, the carrier's reason, and the
// business profile as a form (a draft of plain strings) and back, and the area picked against the business address
// (the server suggests it: numberRequest.areas). The one model of a request: Settings › Phone numbers
// (NumberRequests.tsx) and the onboarding phone step (NumberRequestFlow.tsx) both use it. What is only the app's per
// country (how an address is written) is here as data, so the UK and Ireland add rows, not code.
import {
  type KycCountry,
  NUMBER_COUNTRIES,
  type NumberArea,
  type NumberRequestStatus,
  type NumberRequestSummary,
  OPEN_NUMBER_REQUEST_STATUSES,
  REGULATORY_DOCUMENT_MAX_BYTES,
  type RegulatoryDocumentKind,
  type RegulatoryDocumentSummary,
  type RegulatoryEntityType,
  type RegulatoryField,
  type RegulatoryProfileInput,
  regulatoryDocumentTypes,
} from '@linedesk/actions'

/** A request's status; `needs_operator`: the carrier approved, the number could not be set up yet. */
export type RequestStatus = NumberRequestStatus
export type RequestRow = NumberRequestSummary

/**
 * How the app tells a request's status: the carrier reviews it, it is being set up, it is on hold (approved, but the
 * number could not be set up yet: `needs_operator`), it was not approved, done.
 */
export type RequestStage = 'review' | 'settingUp' | 'onHold' | 'rejected' | 'active' | 'cancelled'

export function requestStage(status: RequestStatus): RequestStage {
  if (status === 'approved') return 'settingUp'
  if (status === 'needs_operator') return 'onHold'
  if (status === 'rejected' || status === 'active' || status === 'cancelled') return status
  return 'review'
}

/**
 * Where the workspace's newest request of the country stands, for the onboarding phone step: `none` (nothing asked
 * yet, or cancelled), `review` (the carrier still decides, or approved and being set up), `rejected`, `active`.
 */
export type RequestView =
  | { kind: 'none' }
  | { kind: 'review'; request: RequestRow }
  | { kind: 'rejected'; request: RequestRow }
  | { kind: 'active'; request: RequestRow }

export function requestView(country: KycCountry, requests: readonly RequestRow[]): RequestView {
  const latest = requests.find(r => r.country === country)
  if (!latest || latest.status === 'cancelled') return { kind: 'none' }
  if (
    OPEN_NUMBER_REQUEST_STATUSES.includes(latest.status) ||
    latest.status === 'approved' ||
    latest.status === 'needs_operator'
  )
    return { kind: 'review', request: latest }
  if (latest.status === 'rejected') return { kind: 'rejected', request: latest }
  return { kind: 'active', request: latest }
}

/**
 * Why an approved number is on hold, as a key under `settings.phone.request.hold`: the plan is not active (the owner
 * can fix that), anything else is for the server admin (told by email).
 */
export const holdReason = (reason: string | null): 'bill' | 'admin' => (reason === 'bill_inactive' ? 'bill' : 'admin')

/** The owner can still withdraw it: the carrier has not decided (approved means the number is on the account). */
export const canCancel = (status: RequestStatus) =>
  status === 'requested' || status === 'submitted' || status === 'pending_review'

/** Asking the carrier again can change something: it is still being decided, set up or on hold. */
export const canCheck = (status: RequestStatus) =>
  canCancel(status) || status === 'approved' || status === 'needs_operator'

/**
 * The requests that get a line under the numbers: not an active one (its number is in the list like any other), not a
 * cancelled one, and a rejected one only until a newer request for the same city was sent (it was sent again).
 */
export function shownRequests<R extends Pick<RequestRow, 'status' | 'country' | 'prefix' | 'createdAt'>>(
  requests: readonly R[],
): R[] {
  return requests.filter(r => {
    if (r.status === 'active' || r.status === 'cancelled') return false
    if (r.status !== 'rejected') return true
    return !requests.some(o => o !== r && o.country === r.country && o.prefix === r.prefix && o.createdAt > r.createdAt)
  })
}

/**
 * +49 30 12345678: the calling code, the area code and the rest, as people write a number in these countries. Without
 * the number (none reserved yet), the area code as dialled at home: 030.
 */
export function requestedNumber(country: KycCountry, prefix: string, e164: string | null): string {
  const code = NUMBER_COUNTRIES[country].callingCode
  if (!e164) return `0${prefix}`
  const national = e164.startsWith(`+${code}`) ? e164.slice(code.length + 1) : null
  if (!national?.startsWith(prefix)) return e164
  return `+${code} ${prefix} ${national.slice(prefix.length)}`.trim()
}

/** The area code as dialled at home (Berlin: 030), for the city picker. */
export const nationalPrefix = (prefix: string) => `0${prefix}`

/** Reasons the API sets itself (apps/api/src/number-requests.ts), with their key under `settings.phone.request.reason`. */
const REASON_KEYS: Record<string, string> = {
  order_failure: 'orderFailure',
  order_cancelled: 'orderCancelled',
  requirements_declined: 'declined',
  requirements_expired: 'expired',
  requirements_no_longer_eligible: 'noLongerEligible',
}

/** A rejection's reason: one of ours as a key to word it, else the carrier's own words, or none given. */
export function rejectionReason(reason: string | null): { key: string } | { text: string } {
  if (!reason?.trim()) return { key: 'none' }
  const key = REASON_KEYS[reason]
  return key ? { key } : { text: reason.trim() }
}

/** The business profile as the form edits it: plain strings, '' for empty. */
export type ProfileDraft = {
  legal_name: string
  entity_type: RegulatoryEntityType
  /** The court that keeps the register (Germany: Amtsgericht Mannheim); optional. */
  register_court: string
  registration_number: string
  website: string
  use_case: string
  street: string
  extended: string
  postal_code: string
  city: string
  region: string
  country: string
  first_name: string
  last_name: string
  email: string
  /** E.164 as far as typed (PhoneInput). */
  phone: string
}
export type DraftField = keyof ProfileDraft

/**
 * The business details typed into a request that was not sent (Cancel, the step left): kept per workspace while the
 * page is open, as the uploaded documents are kept, so the form opens again on them instead of on the saved profile.
 * Only in memory: personal and company details never go into browser storage. Sending the request forgets them.
 */
const unsentDrafts = new Map<string, ProfileDraft>()
export const unsentDraft = (workspaceId: string | null): ProfileDraft | null =>
  (workspaceId && unsentDrafts.get(workspaceId)) || null
export function keepUnsentDraft(workspaceId: string | null, draft: ProfileDraft) {
  if (workspaceId) unsentDrafts.set(workspaceId, draft)
}
export function forgetUnsentDraft(workspaceId: string | null) {
  if (workspaceId) unsentDrafts.delete(workspaceId)
}

/** What the form starts with when nothing is saved yet: the workspace's name and country, the signed-in person. */
export type DraftDefaults = {
  country: string
  legalName?: string | null
  email?: string | null
  name?: string | null
  phone?: string | null
}

export function draftOf(profile: RegulatoryProfileInput | null, defaults: DraftDefaults): ProfileDraft {
  if (profile)
    return {
      legal_name: profile.legal_name,
      entity_type: profile.entity_type,
      register_court: profile.register_court ?? '',
      registration_number: profile.registration_number ?? '',
      website: profile.website ?? '',
      use_case: profile.use_case ?? '',
      street: profile.address.street,
      extended: profile.address.extended ?? '',
      postal_code: profile.address.postal_code,
      city: profile.address.city,
      region: profile.address.region ?? '',
      country: profile.address.country,
      first_name: profile.contact.first_name,
      last_name: profile.contact.last_name,
      email: profile.contact.email,
      phone: profile.contact.phone,
    }
  const [first = '', ...rest] = (defaults.name ?? '').trim().split(/\s+/)
  return {
    legal_name: defaults.legalName?.trim() ?? '',
    entity_type: 'business',
    register_court: '',
    registration_number: '',
    website: '',
    use_case: '',
    street: '',
    extended: '',
    postal_code: '',
    city: '',
    region: '',
    country: defaults.country,
    first_name: first,
    last_name: rest.join(' '),
    email: defaults.email?.trim() ?? '',
    phone: defaults.phone?.trim() ?? '',
  }
}

/** The fields every profile needs, whatever the country asks for on top. */
const ALWAYS: readonly DraftField[] = [
  'legal_name',
  'street',
  'postal_code',
  'city',
  'country',
  'first_name',
  'last_name',
  'email',
  'phone',
]

/** Which optional profile fields a country asks for (NumberRequirementsData.fields). */
const OPTIONAL: readonly (RegulatoryField & DraftField)[] = ['registration_number', 'website', 'use_case']

/** The fields the form shows for a country: the optional ones only where the country asks for them. */
export const shownFields = (fields: readonly RegulatoryField[]) =>
  new Set<DraftField>([
    ...ALWAYS,
    'entity_type',
    'extended',
    ...OPTIONAL.filter(f => fields.includes(f)),
    // The court goes with the register number wherever the country asks for it (optional).
    ...(fields.includes('registration_number') || fields.includes('register_court')
      ? (['register_court'] as const)
      : []),
  ])

export type DraftProblem = 'required' | 'email' | 'website' | 'phone' | 'postcode'

/** How a country's postcode looks, where the app checks it (Germany: five digits). */
const POSTCODE: Partial<Record<string, RegExp>> = { DE: /^\d{5}$/ }

/** "example.com" is a web address too: https:// is added; '' stays ''. */
export function websiteOf(text: string): string {
  const value = text.trim()
  if (!value) return ''
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

const isUrl = (value: string) => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.')
  } catch {
    return false
  }
}

/**
 * The profile to save from the draft, or what is wrong per field. `fields`: what the country asks for (the optional
 * fields it lists are required then). The same rules as the server's input (regulatoryProfileInput).
 */
export function profileFromDraft(
  draft: ProfileDraft,
  fields: readonly RegulatoryField[],
): { input: RegulatoryProfileInput } | { problems: Partial<Record<DraftField, DraftProblem>> } {
  const problems: Partial<Record<DraftField, DraftProblem>> = {}
  const value = (field: DraftField) => draft[field].trim()
  for (const field of [...ALWAYS, ...OPTIONAL.filter(f => fields.includes(f))])
    if (!value(field)) problems[field] = 'required'
  if (value('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value('email'))) problems.email = 'email'
  if (value('phone') && !/^\+[1-9]\d{6,14}$/.test(value('phone'))) problems.phone = 'phone'
  const postcode = POSTCODE[value('country').toUpperCase()]
  if (postcode && value('postal_code') && !postcode.test(value('postal_code'))) problems.postal_code = 'postcode'
  const website = websiteOf(draft.website)
  if (website && !isUrl(website)) problems.website = 'website'
  if (Object.keys(problems).length) return { problems }
  const optional = (field: DraftField, text = value(field)) => (text ? { [field]: text } : {})
  return {
    input: {
      legal_name: value('legal_name'),
      entity_type: draft.entity_type,
      ...optional('registration_number'),
      ...optional('register_court'),
      ...optional('website', website),
      ...optional('use_case'),
      address: {
        street: value('street'),
        ...optional('extended'),
        city: value('city'),
        postal_code: value('postal_code'),
        ...optional('region'),
        country: value('country').toUpperCase(),
      },
      contact: {
        first_name: value('first_name'),
        last_name: value('last_name'),
        email: value('email'),
        phone: value('phone'),
      },
    },
  }
}

/** Whether two profiles say the same: then the saved one is not written again. */
export const sameProfile = (a: RegulatoryProfileInput | null, b: RegulatoryProfileInput) =>
  !!a && JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))

function sortKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([k, v]) => [k, sortKeys(v)]),
  )
}

/** Why a picked file can't be a document, or null: the carrier takes PDF, PNG and JPEG of at most 2.5 MB. */
export function documentProblem(file: { type: string; size: number }): 'type' | 'size' | 'empty' | null {
  if (!(regulatoryDocumentTypes as readonly string[]).includes(file.type)) return 'type'
  if (file.size === 0) return 'empty'
  if (file.size > REGULATORY_DOCUMENT_MAX_BYTES) return 'size'
  return null
}

/** The documents of each kind the country needs, newest first (the newest is the one sent). */
export function documentsByKind(
  kinds: readonly RegulatoryDocumentKind[],
  documents: readonly RegulatoryDocumentSummary[],
): { kind: RegulatoryDocumentKind; documents: RegulatoryDocumentSummary[] }[] {
  return kinds.map(kind => ({
    kind,
    documents: documents.filter(d => d.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }))
}

/** The kinds the country needs that have no document yet. */
export const missingDocuments = (
  kinds: readonly RegulatoryDocumentKind[],
  documents: readonly Pick<RegulatoryDocumentSummary, 'kind'>[],
) => kinds.filter(kind => !documents.some(d => d.kind === kind))

/** How the country writes an address: the postcode before the city (Germany, "69221 Dossenheim") or after it. */
export const ADDRESS_ORDER: Record<KycCountry, 'postcode_first' | 'city_first'> = {
  DE: 'postcode_first',
  GB: 'city_first',
  IE: 'city_first',
}

/**
 * Whether the picked area is not one the business address is in (numberRequest.areas `suggested`): then the proof of
 * address has to show a site of the business in that area. Only said, never a lock; unknown (no suggestion) says nothing.
 */
export const areaAwayFromAddress = (prefix: string, suggested: readonly Pick<NumberArea, 'prefix'>[]) =>
  suggested.length > 0 && !suggested.some(a => a.prefix === prefix)

/** The areas to list: the picked one and the address's first, then what the search found, each once. */
export function listedAreas(
  found: readonly NumberArea[],
  suggested: readonly NumberArea[],
  picked: NumberArea | null,
  query: string,
): NumberArea[] {
  const head = [...(picked ? [picked] : []), ...(query.trim() ? [] : suggested)]
  const seen = new Set<string>()
  return [...head, ...found].filter(a => !seen.has(a.prefix) && !!seen.add(a.prefix))
}

/** The file's bytes as base64, for numberRequest.uploadDocument. */
export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

/** "1.2 MB", "340 KB": a document's size in the list. */
export function fileSize(bytes: number, number: (value: number, options?: Intl.NumberFormatOptions) => string) {
  if (bytes >= 1_000_000) return { unit: 'mb' as const, value: number(bytes / 1_000_000, { maximumFractionDigits: 1 }) }
  return { unit: 'kb' as const, value: number(Math.max(1, Math.round(bytes / 1000))) }
}
