// What the core needs from a phone carrier. Vendor APIs live only in their adapter.

export type ProviderName = 'twilio' | 'telnyx' | 'dev'

export interface NumberSearch {
  /** ISO 3166-1 alpha-2, e.g. "US". */
  country: string
  /** Area code (national destination code), e.g. "503". */
  areaCode?: string
  limit?: number
  /**
   * The caller orders with a requirement group of its own (`BuyOptions`): a country whose numbers need an address or
   * documents is searched instead of refused (`country_requirements`).
   */
  withRequirements?: boolean
  /** Local numbers (the default) or national ones (Germany 032: no area code). */
  numberType?: 'local' | 'national'
}

/** How a number is bought: with the install's approved requirement group when the country needs one (Germany 032). */
export interface BuyOptions {
  requirementGroupRef?: string
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

export interface TelephonyProvider {
  readonly name: ProviderName
  searchNumbers(search: NumberSearch): Promise<AvailableNumber[]>
  /** Numbers the account owns, at most `limit`. Only reads: "Test connection" for a workspace's own carrier. */
  listNumbers(limit: number): Promise<OwnedNumber[]>
  /** The number if the account already owns it, else null. Never buys anything. */
  findNumber(e164: string): Promise<OwnedNumber | null>
  /**
   * Buys the number: this costs money. Only for a number `findNumber` did not find. With a requirement group the order
   * carries it (the carrier's review was done once for the group); an order that still waits for a review is
   * cancelled and refused (`not_activated`), never left pending.
   */
  buyNumber(e164: string, options?: BuyOptions): Promise<OwnedNumber>
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
