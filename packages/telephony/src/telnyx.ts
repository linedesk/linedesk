// Telnyx adapter, REST API v2 with plain fetch. https://developers.telnyx.com/api
import { createPublicKey, verify } from 'node:crypto'
import { installCarrierName, TelephonyError, type AvailableNumber, type CallStatus, type CallStatusEvent, type LineType, type NumberLookup, type OwnedNumber, type TelephonyProvider } from './provider.ts'

const API = 'https://api.telnyx.com/v2'
const CONNECTION_NAME = 'linedesk-livekit'
const WEBHOOK_TOLERANCE_SEC = 300
const ORDER_LOOKUPS = 10
/**
 * Longest one Telnyx request may take, answer included. A purchase holds the install-wide purchase lock and a
 * database connection while it waits for Telnyx: a hung request must not hold them for long.
 */
export const TELNYX_TIMEOUT_MS = 15_000
// DER prefix that turns a raw 32-byte Ed25519 public key into SPKI.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export interface TelnyxOptions {
  apiKey: string
  /** Base64 public key from the Telnyx portal; only needed to verify webhooks. */
  publicKey?: string
  fetch?: typeof fetch
  /** Wait between look-ups while a number order completes. */
  wait?: (ms: number) => Promise<unknown>
  now?: () => number
  /** Longest one request may take (default TELNYX_TIMEOUT_MS). */
  timeoutMs?: number
}

type Json = Record<string, any>

const statusByEvent: Record<string, CallStatus> = {
  'call.initiated': 'initiated',
  'call.answered': 'answered',
  'call.hangup': 'hangup',
}

const fail = (message: string, status?: number) => new TelephonyError('telnyx', message, status)

/** Telnyx's carrier type ("mobile", "fixed line", "voip", "toll free") or portability line type ("wireless", "landline"). */
export function telnyxLineType(type: unknown): LineType {
  const text = typeof type === 'string' ? type.toLowerCase() : ''
  // "fixed line or mobile" (numbering plans that share ranges) says nothing about this line.
  if (/fixed|landline|wireline/.test(text) && /mobile|wireless|cellular/.test(text)) return 'unknown'
  if (/mobile|wireless|cellular/.test(text)) return 'mobile'
  if (/toll/.test(text)) return 'toll_free'
  if (/voip/.test(text)) return 'voip'
  if (/fixed|landline|wireline/.test(text)) return 'landline'
  return 'unknown'
}

/**
 * One authenticated Telnyx API call; errors carry the status and Telnyx's own reason, never the key. Gives up after
 * `timeoutMs` with a TelephonyError that says so.
 */
export function telnyxRequest(apiKey: string, doFetch: typeof fetch = fetch, timeoutMs = TELNYX_TIMEOUT_MS) {
  return async function request(method: string, path: string, body?: Json): Promise<Json> {
    const where = `${method} ${path.split('?')[0]}`
    const signal = AbortSignal.timeout(timeoutMs)
    let res: Response
    let json: Json
    try {
      res = await doFetch(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      })
      json = (await res.json().catch(e => {
        if (signal.aborted) throw e
        return {}
      })) as Json
    } catch (e) {
      if (signal.aborted) throw fail(`${where}: Telnyx did not answer within ${timeoutMs / 1000} s`)
      throw e
    }
    if (!res.ok) throw fail(`${where}: ${json.errors?.[0]?.detail ?? json.errors?.[0]?.title ?? res.statusText}`, res.status)
    return json
  }
}

/**
 * Telnyx sends some ids as JSON numbers above 2^53 (fqdns' connection_id), which JSON.parse rounds; the
 * same id as a string from another endpoint then no longer compares equal. A number is compared after the
 * same rounding.
 */
const sameTelnyxId = (value: unknown, id: string) =>
  String(value) === id || (typeof value === 'number' && value === Number(id))

export function createTelnyxProvider(options: TelnyxOptions): TelephonyProvider {
  const { apiKey, publicKey, fetch: doFetch = fetch, now = Date.now } = options
  const wait = options.wait ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const request = telnyxRequest(apiKey, doFetch, options.timeoutMs)
  const connectionName = installCarrierName(CONNECTION_NAME)

  async function findNumberId(e164: string): Promise<string | undefined> {
    const { data } = await request('GET', `/phone_numbers?filter[phone_number]=${encodeURIComponent(e164)}`)
    // Telnyx's filter also matches partial numbers: only the exact number counts, never the first hit.
    const id = (data as Json[] | undefined)?.find(n => n.phone_number === e164)?.id
    return id === undefined ? undefined : String(id)
  }

  /** Linedesk's FQDN connection to LiveKit SIP, if the account has one. */
  async function findConnection(): Promise<string | undefined> {
    const { data } = await request('GET', `/fqdn_connections?filter[connection_name][contains]=${connectionName}`)
    return (data as Json[] | undefined)?.find(c => c.connection_name === connectionName)?.id
  }

  /** The FQDN connection that forwards to LiveKit SIP, looked up by name and created if missing. */
  async function ensureConnection(): Promise<string> {
    const existing = await findConnection()
    if (existing) return existing
    const created = await request('POST', '/fqdn_connections', {
      active: true,
      anchorsite_override: 'Latency',
      connection_name: connectionName,
      transport_protocol: 'TCP',
      inbound: { ani_number_format: '+E.164', dnis_number_format: '+e164' },
    })
    return created.data.id
  }

  /** Makes the connection forward to exactly this endpoint: adds it if missing, removes any other. */
  async function ensureFqdn(connectionId: string, sipEndpoint: string) {
    const { data } = await request('GET', `/fqdns?filter[connection_id]=${connectionId}`)
    const fqdns = ((data ?? []) as Json[]).filter(f => sameTelnyxId(f.connection_id, connectionId))
    if (!fqdns.some(f => f.fqdn === sipEndpoint)) {
      await request('POST', '/fqdns', { connection_id: connectionId, fqdn: sipEndpoint, port: 5060, dns_record_type: 'a' })
    }
    for (const stale of fqdns.filter(f => f.fqdn !== sipEndpoint)) await request('DELETE', `/fqdns/${stale.id}`)
  }

  /**
   * Inbound call screening in flag mode: Telnyx marks a call it rates as spam (number reputation, a failed STIR/SHAKEN
   * signature) with `X-Telnyx-Call-Screening: SPAM LIKELY` and never rejects one; free since March 2026. Only a number
   * with screening off is changed, so an owner's own choice (reject) stays. A failure leaves the routing done: the
   * flag is a help for the inbox, not something a call needs.
   */
  async function flagSpamCalls(numberId: string) {
    try {
      const { data } = await request('GET', `/phone_numbers/${numberId}/voice`)
      if ((data?.inbound_call_screening ?? 'disabled') === 'disabled') {
        await request('PATCH', `/phone_numbers/${numberId}/voice`, { inbound_call_screening: 'flag_calls' })
      }
    } catch (e) {
      console.warn(`telnyx: could not turn on call screening for number ${numberId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function verifySignature(headers: Record<string, string | undefined>, rawBody: string) {
    if (!publicKey) throw fail('TELNYX_PUBLIC_KEY is not set, cannot verify webhooks')
    const signature = headers['telnyx-signature-ed25519']
    const timestamp = headers['telnyx-timestamp']
    if (!signature || !timestamp) throw fail('webhook has no signature headers')
    if (Math.abs(now() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SEC) throw fail('webhook timestamp is outside the tolerance')
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' })
    const valid = verify(null, Buffer.from(`${timestamp}|${rawBody}`), key, Buffer.from(signature, 'base64'))
    if (!valid) throw fail('webhook signature is not valid')
  }

  return {
    name: 'telnyx',

    async searchNumbers({ country, areaCode, limit = 10 }) {
      const query = new URLSearchParams({ 'filter[country_code]': country, 'filter[features][]': 'voice', 'filter[limit]': String(limit) })
      if (areaCode) query.set('filter[national_destination_code]', areaCode)
      const { data } = await request('GET', `/available_phone_numbers?${query}`)
      return ((data ?? []) as Json[]).map((n): AvailableNumber => {
        const region = (type: string) => n.region_information?.find((r: Json) => r.region_type === type)?.region_name
        return {
          e164: n.phone_number, locality: region('rate_center') ?? region('location'), region: region('state'),
          monthlyCost: n.cost_information?.monthly_cost, currency: n.cost_information?.currency,
        }
      })
    },

    async listNumbers(limit) {
      const { data } = await request('GET', `/phone_numbers?page[size]=${limit}`)
      return ((data ?? []) as Json[]).map((n): OwnedNumber => ({ e164: n.phone_number, providerRef: String(n.id) }))
    },

    async findNumber(e164): Promise<OwnedNumber | null> {
      const id = await findNumberId(e164)
      return id ? { e164, providerRef: id } : null
    },

    async buyNumber(e164): Promise<OwnedNumber> {
      const { data } = await request('POST', '/number_orders', { phone_numbers: [{ phone_number: e164 }] })
      if (data.status === 'failure') throw fail(`number order ${data.id} for ${e164} failed`)
      // The order completes asynchronously; the number has an id once it is on the account.
      for (let attempt = 0; attempt < ORDER_LOOKUPS; attempt++) {
        await wait(1000)
        const id = await findNumberId(e164)
        if (id) return { e164, providerRef: id }
      }
      throw fail(`number order ${data.id} for ${e164} is still pending at the carrier; set up ${e164} again in a minute to finish`)
    },

    async routeToSip(number, sipEndpoint) {
      const connection_id = await ensureConnection()
      await ensureFqdn(connection_id, sipEndpoint)
      await request('PATCH', `/phone_numbers/${number.providerRef}`, { connection_id })
      await flagSpamCalls(number.providerRef)
    },

    async unrouteNumber(number) {
      const ours = await findConnection()
      if (!ours) return
      const { data } = await request('GET', `/phone_numbers/${number.providerRef}`)
      // Only Linedesk's own connection is taken off; a number on any other connection stays untouched.
      if (!sameTelnyxId(data?.connection_id ?? '', String(ours))) return
      await request('PATCH', `/phone_numbers/${number.providerRef}`, { connection_id: null })
    },

    async releaseNumber(number) {
      await request('DELETE', `/phone_numbers/${number.providerRef}`)
    },

    // Number Lookup with the carrier part: https://developers.telnyx.com/api/number-lookup
    async lookupNumber(e164): Promise<NumberLookup> {
      const { data } = await request('GET', `/number_lookup/${encodeURIComponent(e164)}?type=carrier`)
      const carrier = data?.carrier ?? {}
      const lineType = telnyxLineType(carrier.type) !== 'unknown' ? telnyxLineType(carrier.type) : telnyxLineType(data?.portability?.line_type)
      const name = carrier.name || data?.portability?.spid_carrier_name || null
      return { e164, lineType, carrier: typeof name === 'string' && name.trim() ? name.trim() : null }
    },

    parseWebhook({ headers, rawBody }): CallStatusEvent {
      verifySignature(headers, rawBody)
      const { data } = JSON.parse(rawBody) as Json
      if (!data?.id || !data.event_type) throw fail('webhook body has no event')
      return {
        id: data.id,
        status: statusByEvent[data.event_type] ?? null,
        providerEventType: data.event_type,
        from: data.payload?.from,
        to: data.payload?.to,
        occurredAt: data.occurred_at,
      }
    },
  }
}
