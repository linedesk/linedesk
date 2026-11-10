// What the core needs from a phone carrier. Vendor APIs live only in their adapter.

export type ProviderName = 'telnyx' | 'dev'

export interface NumberSearch {
  /** ISO 3166-1 alpha-2, e.g. "US". */
  country: string
  /** Area code (national destination code), e.g. "503". */
  areaCode?: string
  limit?: number
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

/** `purchased` is false when the account owned the number before, so nothing new is being paid for. */
export type BoughtNumber = OwnedNumber & { purchased: boolean }

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

export interface WebhookRequest {
  /** Lower-case header names. */
  headers: Record<string, string | undefined>
  /** The body exactly as received; signatures cover the raw bytes. */
  rawBody: string
}

export class TelephonyError extends Error {
  constructor(readonly provider: ProviderName, message: string, readonly status?: number) {
    super(`${provider}: ${message}`)
  }
}

export interface TelephonyProvider {
  readonly name: ProviderName
  searchNumbers(search: NumberSearch): Promise<AvailableNumber[]>
  /** Buys the number. Returns it without buying again if the account already owns it, so a failed setup can be repeated. */
  buyNumber(e164: string): Promise<BoughtNumber>
  /** Sends the number's inbound calls to a SIP endpoint (host of LiveKit SIP). Safe to repeat; a changed endpoint replaces the old one. */
  routeToSip(number: OwnedNumber, sipEndpoint: string): Promise<void>
  releaseNumber(number: OwnedNumber): Promise<void>
  /** Verifies and parses a status webhook. Throws TelephonyError if the signature is not valid. */
  parseWebhook(request: WebhookRequest): CallStatusEvent
}
