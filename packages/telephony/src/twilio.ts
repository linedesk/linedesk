// Twilio adapter: phone numbers through the REST API, inbound calls through Elastic SIP Trunking.
// Plain fetch. https://www.twilio.com/docs/sip-trunking/api
import { createHmac, timingSafeEqual } from 'node:crypto'
import { installCarrierName, TelephonyError, type AvailableNumber, type CallStatus, type CallStatusEvent, type LineType, type NumberLookup, type OwnedNumber, type SipRouteOptions, type TelephonyProvider } from './provider.ts'

const TRUNKING = 'https://trunking.twilio.com/v1'
const LOOKUPS = 'https://lookups.twilio.com/v2'
const TRUNK_NAME = 'linedesk-livekit'

/**
 * Either the auth token, or an API key (SID + secret) of the account. With an API key the adapter
 * does everything but verify webhooks: Twilio signs those with the auth token only.
 */
export type TwilioOptions = {
  accountSid: string
  fetch?: typeof fetch
  /** How long one API call may take (default TWILIO_TIMEOUT_MS). */
  timeoutMs?: number
} & ({ authToken: string; apiKeySid?: undefined; apiKeySecret?: undefined } | { authToken?: undefined; apiKeySid: string; apiKeySecret: string })

// biome-ignore lint/suspicious/noExplicitAny: Twilio's JSON is read field by field
type Json = Record<string, any>
type Form = Record<string, string>

const statusByCallStatus: Record<string, CallStatus> = {
  initiated: 'initiated', queued: 'initiated', ringing: 'initiated',
  'in-progress': 'answered',
  completed: 'hangup', busy: 'hangup', failed: 'hangup', 'no-answer': 'hangup', canceled: 'hangup',
}

/** Twilio sends RFC 2822 dates ("Tue, 10 Nov 2026 10:00:00 +0000"); the core uses ISO 8601. */
function toIso(timestamp: string | null): string | undefined {
  const time = timestamp ? Date.parse(timestamp) : Number.NaN
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

const fail = (message: string, status?: number) => new TelephonyError('twilio', message, status)

/** Lookup v2's line type intelligence: mobile, landline, fixedVoip, nonFixedVoip, tollFree, … */
export function twilioLineType(type: unknown): LineType {
  if (type === 'mobile') return 'mobile'
  if (type === 'landline') return 'landline'
  if (type === 'fixedVoip' || type === 'nonFixedVoip') return 'voip'
  if (type === 'tollFree') return 'toll_free'
  return 'unknown'
}

/** Twilio forwards to this URI: TCP to 5060, or with `secure` TLS to 5061 (and the trunk's Secure setting: SRTP). */
const originationUrl = (sipEndpoint: string, { secure = false }: SipRouteOptions = {}) =>
  secure ? `sip:${sipEndpoint}:5061;transport=tls` : `sip:${sipEndpoint};transport=tcp`

/** How long one Twilio API call may take before it fails (like Telnyx's). */
export const TWILIO_TIMEOUT_MS = 15_000

/**
 * One authenticated Twilio API call, with the auth token or an API key. `what` names the step in error
 * messages; URLs carry the account SID and stay out of them, and so does every credential.
 */
export function twilioRequest(options: TwilioOptions) {
  const { accountSid, authToken, fetch: doFetch = fetch, timeoutMs = TWILIO_TIMEOUT_MS } = options
  const [user, password] = options.apiKeySid ? [options.apiKeySid, options.apiKeySecret] : [accountSid, authToken]
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
  return async function request(what: string, method: string, url: string, form?: Form): Promise<Json> {
    const signal = AbortSignal.timeout(timeoutMs)
    let res: Response
    try {
      res = await doFetch(url, {
        method,
        headers: { authorization, accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal,
      })
    } catch (e) {
      if (signal.aborted) throw fail(`${what}: Twilio did not answer within ${timeoutMs / 1000} s`)
      throw e
    }
    const json = (await res.json().catch(() => ({}))) as Json
    if (!res.ok) throw fail(`${what} failed: ${json.message ?? res.statusText}`, res.status)
    return json
  }
}

/** The account's REST base URL. */
export const twilioAccountUrl = (accountSid: string) => `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`
export const TWILIO_TRUNKING = TRUNKING

export function createTwilioProvider(options: TwilioOptions): TelephonyProvider {
  const { accountSid, authToken } = options
  const account = twilioAccountUrl(accountSid)
  const request = twilioRequest(options)

  async function findNumberSid(e164: string): Promise<string | undefined> {
    const { incoming_phone_numbers } = await request('look up number', 'GET', `${account}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`)
    return (incoming_phone_numbers as Json[] | undefined)?.find(n => n.phone_number === e164)?.sid
  }

  /** Linedesk's Elastic SIP trunk to LiveKit SIP, if the account has one. */
  async function findTrunkInfo(): Promise<Json | undefined> {
    const { trunks } = await request('list trunks', 'GET', `${TRUNKING}/Trunks?PageSize=1000`)
    return (trunks as Json[] | undefined)?.find(t => t.friendly_name === installCarrierName(TRUNK_NAME))
  }
  const findTrunk = async (): Promise<string | undefined> => (await findTrunkInfo())?.sid

  /**
   * The Elastic SIP trunk that forwards to LiveKit SIP, looked up by name and created if missing. Its Secure setting
   * (TLS signalling, SRTP audio; Twilio refuses unencrypted calls on such a trunk) follows `secure`.
   */
  async function ensureTrunk({ secure = false }: SipRouteOptions = {}): Promise<string> {
    const found = await findTrunkInfo()
    const sid: string = found?.sid ?? (await request('create trunk', 'POST', `${TRUNKING}/Trunks`, { FriendlyName: installCarrierName(TRUNK_NAME) })).sid
    // A new trunk is not secure; a listed one says so in `secure`.
    if (Boolean(found?.secure) !== secure) await request('set trunk security', 'POST', `${TRUNKING}/Trunks/${sid}`, { Secure: String(secure) })
    return sid
  }

  /** Makes the trunk forward to exactly this endpoint: adds it if missing, removes any other. */
  async function ensureOrigination(trunkSid: string, sipEndpoint: string, options?: SipRouteOptions) {
    const urls = `${TRUNKING}/Trunks/${trunkSid}/OriginationUrls`
    const wanted = originationUrl(sipEndpoint, options)
    const existing = ((await request('list origination URIs', 'GET', `${urls}?PageSize=1000`)).origination_urls ?? []) as Json[]
    if (!existing.some(o => o.sip_url === wanted)) {
      await request('add origination URI', 'POST', urls, { FriendlyName: 'LiveKit SIP', SipUrl: wanted, Weight: '1', Priority: '1', Enabled: 'true' })
    }
    for (const stale of existing.filter(o => o.sip_url !== wanted)) await request('remove origination URI', 'DELETE', `${urls}/${stale.sid}`)
  }

  async function attachNumber(trunkSid: string, numberSid: string) {
    const numbers = `${TRUNKING}/Trunks/${trunkSid}/PhoneNumbers`
    const attached = ((await request('list trunk numbers', 'GET', `${numbers}?PageSize=1000`)).phone_numbers ?? []) as Json[]
    if (!attached.some(n => n.sid === numberSid)) await request('attach number to trunk', 'POST', numbers, { PhoneNumberSid: numberSid })
  }

  /** Twilio signs the full URL followed by every form field, sorted by name, as name + value. */
  function verifySignature(url: string | undefined, signature: string | undefined, params: URLSearchParams) {
    if (!authToken) throw fail('webhooks are signed with the auth token; it is not set (an API key cannot verify them)')
    if (!url) throw fail('the webhook URL is needed to verify the signature')
    if (!signature) throw fail('webhook has no signature header')
    const signed = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).reduce((text, [name, value]) => text + name + value, url)
    const expected = createHmac('sha1', authToken).update(signed).digest()
    const given = Buffer.from(signature, 'base64')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw fail('webhook signature is not valid')
  }

  return {
    name: 'twilio',

    async searchNumbers({ country, areaCode, limit = 10, numberType }) {
      // National numbers (Germany 032) are bought only with a requirement group, which Twilio has no adapter for yet.
      if (numberType === 'national') throw new TelephonyError('twilio', `national numbers in ${country} cannot be bought with Twilio here yet`, undefined, 'country_requirements')
      const query = new URLSearchParams({ VoiceEnabled: 'true', PageSize: String(limit) })
      if (areaCode) query.set('AreaCode', areaCode)
      const { available_phone_numbers } = await request('search numbers', 'GET', `${account}/AvailablePhoneNumbers/${country}/Local.json?${query}`)
      return ((available_phone_numbers ?? []) as Json[]).map((n): AvailableNumber => ({
        e164: n.phone_number, locality: n.locality ?? undefined, region: n.region ?? undefined,
      }))
    },

    async listNumbers(limit) {
      const { incoming_phone_numbers } = await request('list numbers', 'GET', `${account}/IncomingPhoneNumbers.json?PageSize=${limit}`)
      return ((incoming_phone_numbers ?? []) as Json[]).map((n): OwnedNumber => ({ e164: n.phone_number, providerRef: n.sid }))
    },

    async findNumber(e164): Promise<OwnedNumber | null> {
      const sid = await findNumberSid(e164)
      return sid ? { e164, providerRef: sid } : null
    },

    async buyNumber(e164): Promise<OwnedNumber> {
      const { sid } = await request('buy number', 'POST', `${account}/IncomingPhoneNumbers.json`, { PhoneNumber: e164 })
      return { e164, providerRef: sid }
    },

    async routeToSip(number, sipEndpoint, options) {
      const trunkSid = await ensureTrunk(options)
      await ensureOrigination(trunkSid, sipEndpoint, options)
      await attachNumber(trunkSid, number.providerRef)
    },

    async unrouteNumber(number) {
      const trunkSid = await findTrunk()
      if (!trunkSid) return
      const numbers = `${TRUNKING}/Trunks/${trunkSid}/PhoneNumbers`
      const attached = ((await request('list trunk numbers', 'GET', `${numbers}?PageSize=1000`)).phone_numbers ?? []) as Json[]
      // Only Linedesk's own trunk lets go of the number; its voice settings elsewhere stay untouched.
      if (attached.some(n => n.sid === number.providerRef)) await request('detach number from trunk', 'DELETE', `${numbers}/${number.providerRef}`)
    },

    async releaseNumber(number) {
      await request('release number', 'DELETE', `${account}/IncomingPhoneNumbers/${number.providerRef}.json`)
    },

    // Lookup v2 with line type intelligence: https://www.twilio.com/docs/lookup/v2-api/line-type-intelligence
    async lookupNumber(e164): Promise<NumberLookup> {
      const json = await request('look up line type', 'GET', `${LOOKUPS}/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`)
      const info = json.line_type_intelligence ?? {}
      const name = typeof info.carrier_name === 'string' && info.carrier_name.trim() ? info.carrier_name.trim() : null
      return { e164, lineType: twilioLineType(info.type), carrier: name }
    },

    parseWebhook({ headers, rawBody, url }): CallStatusEvent {
      const params = new URLSearchParams(rawBody)
      verifySignature(url, headers['x-twilio-signature'], params)
      const callSid = params.get('CallSid')
      const callStatus = params.get('CallStatus')
      if (!callSid || !callStatus) throw fail('webhook body has no call status')
      return {
        id: `${callSid}:${callStatus}`,
        status: statusByCallStatus[callStatus] ?? null,
        providerEventType: callStatus,
        from: params.get('From') ?? undefined,
        to: params.get('To') ?? undefined,
        occurredAt: toIso(params.get('Timestamp')),
      }
    },
  }
}
