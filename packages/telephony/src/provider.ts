// What the core needs from a phone carrier. Vendor APIs live only in their adapter.

export type ProviderName = 'twilio' | 'telnyx' | 'dev'

export interface NumberSearch {
  /** ISO 3166-1 alpha-2, e.g. "US". */
  country: string
  /** Area code (national destination code), e.g. "503". */
  areaCode?: string
  limit?: number
  /**
   * The caller submits the country's requirements itself (a requirement group, `RegulatoryNumbers`): a country whose
   * local numbers need an address or documents is searched instead of refused (`country_requirements`).
   */
  withRequirements?: boolean
}

export interface AvailableNumber {
  e164: string
  locality?: string
  region?: string
  monthlyCost?: string
  currency?: string
}

export interface OwnedNumber {
  e164: string
  /** The provider's id for the number; stored as `phone_numbers.provider_ref`. */
  providerRef: string
}

export type CallStatus = 'initiated' | 'answered' | 'hangup'

/** A provider status webhook in one shape. `status` is null for events the core does not use. */
export interface CallStatusEvent {
  id: string
  status: CallStatus | null
  providerEventType: string
  from?: string
  to?: string
  occurredAt?: string
}

/** What kind of line a number is, as far as the carrier lookup tells. */
export type LineType = 'mobile' | 'landline' | 'voip' | 'toll_free' | 'unknown'

/** A carrier lookup of a number: its line type and the carrier it belongs to (null when the lookup does not say). */
export interface NumberLookup {
  e164: string
  lineType: LineType
  carrier: string | null
}

export interface WebhookRequest {
  /** Lower-case header names. */
  headers: Record<string, string | undefined>
  /** The body exactly as received; signatures cover the raw bytes. */
  rawBody: string
  /** The full URL the provider called, as it called it. Some providers sign it (Twilio). */
  url?: string
}

/**
 * The name of an install-wide object at the carrier (Telnyx connection, Twilio trunk). Two installs that share one
 * carrier account (staging and production) set LINEDESK_CARRIER_SUFFIX on one of them, so neither repoints or
 * re-keys the other's objects: "linedesk-livekit" becomes "linedesk-livekit-prod". Unset: the name as before.
 */
export function installCarrierName(base: string, suffix = process.env.LINEDESK_CARRIER_SUFFIX ?? ''): string {
  if (!suffix) return base
  if (!/^[a-z0-9]{1,12}$/.test(suffix)) throw new Error(`LINEDESK_CARRIER_SUFFIX must be 1 to 12 lowercase letters or digits, not "${suffix}"`)
  return `${base}-${suffix}`
}

/**
 * A carrier failure the app explains in its own words instead of the carrier's (which can name orders and requirements
 * of the operator's account): `country_requirements`, local numbers in that country need an address or documents
 * Linedesk cannot submit; `not_activated`, a number order did not complete and was cancelled.
 */
export type TelephonyErrorCode = 'country_requirements' | 'not_activated'

export class TelephonyError extends Error {
  readonly provider: ProviderName
  readonly status?: number
  readonly code?: TelephonyErrorCode

  constructor(provider: ProviderName, message: string, status?: number, code?: TelephonyErrorCode) {
    super(`${provider}: ${message}`)
    this.provider = provider
    this.status = status
    this.code = code
  }
}

/** The kinds of number a regulated country sells; Linedesk asks for `local` only so far. */
export type RegulatedNumberType = 'local' | 'national' | 'mobile' | 'toll_free'

/** What one requirement asks for: a text, an address (the carrier's own address object) or a document. */
export type RequirementKind = 'textual' | 'address' | 'document' | 'action'

/** One requirement the carrier has for numbers of a country and type, in the carrier's words (never shown as such). */
export interface NumberRequirement {
  /** The carrier's id; the value for it goes into the requirement group under this id. */
  id: string
  name: string
  kind: RequirementKind
  description?: string
}

/** A postal address as the carrier keeps it (Telnyx: POST /addresses). */
export interface RegulatoryAddress {
  businessName: string
  firstName: string
  lastName: string
  street: string
  extendedAddress?: string
  locality: string
  administrativeArea?: string
  postalCode: string
  /** ISO 3166-1 alpha-2. */
  countryCode: string
  phoneNumber?: string
  customerReference?: string
}

/** A file to hand to the carrier for a requirement. */
export interface RegulatoryFile {
  filename: string
  contentType: string
  content: Uint8Array
  customerReference?: string
}

/** Where the carrier's review of a requirement group stands. */
export type RequirementGroupStatus = 'unapproved' | 'pending_approval' | 'approved' | 'declined' | 'expired' | 'no_longer_eligible'

export interface RequirementGroup {
  ref: string
  status: RequirementGroupStatus
  /** Why it was declined, in the carrier's words (for the operator's log and the request's reason). */
  reason?: string
}

/** Where a number order stands: `pending` until every requirement is approved, then `success` (the number is on the account). */
export type NumberOrderStatus = 'pending' | 'success' | 'failure' | 'cancelled'

export interface NumberOrder {
  ref: string
  status: NumberOrderStatus
  e164: string
  requirementsMet: boolean
  /** The number on the account, once the order succeeded. */
  number?: OwnedNumber
  reason?: string
}

/**
 * A carrier webhook about a number order or a requirement group, verified, in one shape. It only says which object
 * changed: the API reads the object again from the carrier (`getNumberOrder`, `getRequirementGroup`) and never takes
 * its state from the webhook body.
 */
export interface RegulatoryEvent {
  id: string
  kind: 'number_order' | 'requirement_group'
  /** The carrier's id of the order or group, when the event names it. */
  ref?: string
  /** The `customer_reference` Linedesk set (the number request's id), when the event carries it. */
  customerReference?: string
  providerEventType: string
}

/**
 * Buying numbers in a country whose carrier asks for documents first (KYC; docs/numbers-kyc.md). Every write here is
 * a request to the carrier that costs money or puts the business's documents there: only the number request flow
 * (apps/api/src/number-requests.ts) calls it, never a test with a real key.
 */
export interface RegulatoryNumbers {
  /** What the carrier needs before it activates a number of `type` in `country` (ordering); none: []. Reads only. */
  numberRequirements(country: string, type: RegulatedNumberType): Promise<NumberRequirement[]>
  /** Stores an address at the carrier; its id is the value of an address requirement. */
  createAddress(address: RegulatoryAddress): Promise<string>
  /** Uploads a document; its id is the value of a document requirement. */
  uploadDocument(file: RegulatoryFile): Promise<string>
  /** A requirement group with every value, submitted for the carrier's review. */
  submitRequirementGroup(group: {
    country: string
    type: RegulatedNumberType
    customerReference: string
    values: { requirementId: string; value: string }[]
  }): Promise<RequirementGroup>
  getRequirementGroup(ref: string): Promise<RequirementGroup>
  /** Orders `e164` with the requirement group: pending at the carrier until the group is approved. Costs money once it completes. */
  orderNumber(order: { e164: string; requirementGroupRef: string; customerReference: string }): Promise<NumberOrder>
  getNumberOrder(ref: string): Promise<NumberOrder>
  /**
   * Cancels a pending order (its sub-orders), so no number lands on the account later. Safe to repeat. Answers the
   * order as it stands: `cancelled` once cancelled, else what it was (`success`: the number is on the account already
   * and costs money until it is set up or released; the caller must not treat that as cancelled).
   */
  cancelNumberOrder(ref: string): Promise<NumberOrder>
  /** Verifies and parses a number order or requirement group webhook; null for any other event. Throws TelephonyError if the signature is not valid. */
  parseRegulatoryWebhook(request: WebhookRequest): RegulatoryEvent | null
}

export interface TelephonyProvider {
  readonly name: ProviderName
  /** Numbers in countries that need documents (KYC). Only carriers that support it; absent: such countries cannot be bought in. */
  readonly regulatory?: RegulatoryNumbers
  searchNumbers(search: NumberSearch): Promise<AvailableNumber[]>
  /** Numbers the account owns, at most `limit`. Only reads: "Test connection" for a workspace's own carrier. */
  listNumbers(limit: number): Promise<OwnedNumber[]>
  /** The number if the account already owns it, else null. Never buys anything. */
  findNumber(e164: string): Promise<OwnedNumber | null>
  /** Buys the number: this costs money. Only for a number `findNumber` did not find. */
  buyNumber(e164: string): Promise<OwnedNumber>
  /** Sends the number's inbound calls to a SIP endpoint (host of LiveKit SIP). Safe to repeat; a changed endpoint replaces the old one. */
  routeToSip(number: OwnedNumber, sipEndpoint: string): Promise<void>
  /**
   * Stops sending the number's calls to LiveKit, for a number that stays with the business (an attached
   * number). Only undoes Linedesk's own routing (its connection or trunk); a number routed elsewhere is left
   * as it is. Safe to repeat.
   */
  unrouteNumber(number: OwnedNumber): Promise<void>
  releaseNumber(number: OwnedNumber): Promise<void>
  /**
   * Looks up any number's line type and carrier (Telnyx Number Lookup, Twilio Lookup v2). Costs a fraction of a
   * cent at the carrier; reads only, changes nothing.
   */
  lookupNumber(e164: string): Promise<NumberLookup>
  /** Verifies and parses a status webhook. Throws TelephonyError if the signature is not valid. */
  parseWebhook(request: WebhookRequest): CallStatusEvent
}
