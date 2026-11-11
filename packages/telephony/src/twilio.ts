// Twilio adapter: phone numbers through the REST API, inbound calls through Elastic SIP Trunking.
// Plain fetch. https://www.twilio.com/docs/sip-trunking/api
import { createHmac, timingSafeEqual } from 'node:crypto'
import { TelephonyError, type AvailableNumber, type CallStatus, type CallStatusEvent, type OwnedNumber, type TelephonyProvider } from './provider.ts'

const TRUNKING = 'https://trunking.twilio.com/v1'
const TRUNK_NAME = 'linedesk-livekit'

export interface TwilioOptions {
  accountSid: string
  /** Also the key Twilio signs webhooks with. */
  authToken: string
  fetch?: typeof fetch
}

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

/** Twilio forwards to this URI; TCP is what LiveKit SIP expects from Twilio. */
const originationUrl = (sipEndpoint: string) => `sip:${sipEndpoint};transport=tcp`

export function createTwilioProvider({ accountSid, authToken, fetch: doFetch = fetch }: TwilioOptions): TelephonyProvider {
  const account = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`

  /** `what` names the step in error messages; URLs carry the account SID and stay out of them. */
  async function request(what: string, method: string, url: string, form?: Form): Promise<Json> {
    const res = await doFetch(url, {
      method,
      headers: { authorization, accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    })
    const json = (await res.json().catch(() => ({}))) as Json
    if (!res.ok) throw fail(`${what} failed: ${json.message ?? res.statusText}`, res.status)
    return json
  }

  async function findNumberSid(e164: string): Promise<string | undefined> {
    const { incoming_phone_numbers } = await request('look up number', 'GET', `${account}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`)
    return (incoming_phone_numbers as Json[] | undefined)?.find(n => n.phone_number === e164)?.sid
  }

  /** Linedesk's Elastic SIP trunk to LiveKit SIP, if the account has one. */
  async function findTrunk(): Promise<string | undefined> {
    const { trunks } = await request('list trunks', 'GET', `${TRUNKING}/Trunks?PageSize=1000`)
    return (trunks as Json[] | undefined)?.find(t => t.friendly_name === TRUNK_NAME)?.sid
  }

  /** The Elastic SIP trunk that forwards to LiveKit SIP, looked up by name and created if missing. */
  async function ensureTrunk(): Promise<string> {
    return (await findTrunk()) ?? (await request('create trunk', 'POST', `${TRUNKING}/Trunks`, { FriendlyName: TRUNK_NAME })).sid
  }

  /** Makes the trunk forward to exactly this endpoint: adds it if missing, removes any other. */
  async function ensureOrigination(trunkSid: string, sipEndpoint: string) {
    const urls = `${TRUNKING}/Trunks/${trunkSid}/OriginationUrls`
    const wanted = originationUrl(sipEndpoint)
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
    if (!url) throw fail('the webhook URL is needed to verify the signature')
    if (!signature) throw fail('webhook has no signature header')
    const signed = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).reduce((text, [name, value]) => text + name + value, url)
    const expected = createHmac('sha1', authToken).update(signed).digest()
    const given = Buffer.from(signature, 'base64')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw fail('webhook signature is not valid')
  }

  return {
    name: 'twilio',

    async searchNumbers({ country, areaCode, limit = 10 }) {
      const query = new URLSearchParams({ VoiceEnabled: 'true', PageSize: String(limit) })
      if (areaCode) query.set('AreaCode', areaCode)
      const { available_phone_numbers } = await request('search numbers', 'GET', `${account}/AvailablePhoneNumbers/${country}/Local.json?${query}`)
      return ((available_phone_numbers ?? []) as Json[]).map((n): AvailableNumber => ({
        e164: n.phone_number, locality: n.locality ?? undefined, region: n.region ?? undefined,
      }))
    },

    async findNumber(e164): Promise<OwnedNumber | null> {
      const sid = await findNumberSid(e164)
      return sid ? { e164, providerRef: sid } : null
    },

    async buyNumber(e164): Promise<OwnedNumber> {
      const { sid } = await request('buy number', 'POST', `${account}/IncomingPhoneNumbers.json`, { PhoneNumber: e164 })
      return { e164, providerRef: sid }
    },

    async routeToSip(number, sipEndpoint) {
      const trunkSid = await ensureTrunk()
      await ensureOrigination(trunkSid, sipEndpoint)
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
