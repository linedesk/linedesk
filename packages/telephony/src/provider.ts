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

/** The carrier's state of a requirement group (Telnyx's words). */
export type RequirementGroupStatus = 'approved' | 'unapproved' | 'pending-approval' | 'declined' | 'expired'

/** The address a requirement group was approved for (the seat the numbers are held at). */
export interface RequirementGroupAddress {
  street: string
  postalCode: string
  city: string
  country: string
}

/** A requirement group at the carrier, as read for Server admin (never changed by Linedesk). */
export interface RequirementGroup {
  id: string
  /** ISO 3166-1 alpha-2 the group is for. */
  country: string
  /** "local", "national", … as the carrier names them. */
  numberType: string
  /** "ordering" for a group numbers are bought with. */
  action: string
  /** The carrier's status; a value it adds later passes through as it is. */
  status: RequirementGroupStatus | (string & {})
  /** Its address requirement, read from the carrier's address book; null when it has none or it cannot be read. */
  address: RequirementGroupAddress | null
  /** The group's page in the carrier's portal. */
  portalUrl: string
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

/**
 * LIVEKIT_SIP_TLS=on: carriers reach LiveKit SIP over TLS (5061) with SRTP audio (docker-compose.sip-tls.yml holds the
 * certificate and the listener); the API sets each carrier account so when a number is set up (routeToSip), and the
 * inbound trunk takes SRTP and still plain RTP (setup-sip): an account not switched yet keeps working. `require`: the
 * same, and the trunk refuses plain RTP, once every carrier account with numbers on this install is switched.
 */
export const sipTlsFromEnv = (env: Record<string, string | undefined> = process.env): boolean =>
  ['on', 'require'].includes(env.LIVEKIT_SIP_TLS?.trim() ?? '')
/** LIVEKIT_SIP_TLS=require: the inbound trunk refuses calls without SRTP (sipTlsFromEnv). */
export const srtpRequiredFromEnv = (env: Record<string, string | undefined> = process.env): boolean => env.LIVEKIT_SIP_TLS?.trim() === 'require'

/** How the carrier reaches LiveKit SIP (routeToSip). */
export interface SipRouteOptions {
  /** TLS signalling (5061) and SRTP audio instead of TCP (5060) and plain RTP. */
  secure?: boolean
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
  /**
   * Sends the number's inbound calls to a SIP endpoint (host of LiveKit SIP). Safe to repeat; a changed endpoint replaces
   * the old one. `secure`: signalling over TLS to port 5061 and the audio as SRTP (LIVEKIT_SIP_TLS, docker-compose.sip-tls.yml);
   * else TCP to 5060 and plain RTP. The setting is the carrier's for the whole connection or trunk, so every number on it follows.
   */
  routeToSip(number: OwnedNumber, sipEndpoint: string, options?: SipRouteOptions): Promise<void>
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
  /**
   * Reads a requirement group, null when the carrier has none with this id. Only reads. Only carriers that order with
   * requirement groups (Telnyx; `dev` for development).
   */
  requirementGroup?(id: string): Promise<RequirementGroup | null>
  /**
   * The area code (national destination code, without the trunk 0) of the local numbers the carrier has in stock in
   * `locality`, or null when it has none there or cannot tell it for sure. Only reads (a number search).
   */
  localAreaCode?(country: string, locality: string): Promise<string | null>
}
