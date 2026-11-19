// Telnyx adapter, REST API v2 with plain fetch. https://developers.telnyx.com/api
import { createPublicKey, verify } from 'node:crypto'
import { installCarrierName, TelephonyError, type TelephonyErrorCode, type AvailableNumber, type CallStatus, type CallStatusEvent, type LineType, type NumberLookup, type OwnedNumber, type RequirementGroup, type RequirementGroupAddress, type TelephonyProvider } from './provider.ts'

const API = 'https://api.telnyx.com/v2'
/** A requirement group's page in the Telnyx portal. */
export const telnyxRequirementGroupUrl = (id: string) =>
  `https://portal.telnyx.com/#/numbers/requirements/requirement-groups/edit/${encodeURIComponent(id)}`
/** The lengths a German geographic area code (without the trunk 0) can have: 30 (Berlin) to 33203. */
const AREA_CODE_LENGTHS = [2, 3, 4, 5]
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

const fail = (message: string, status?: number, code?: TelephonyErrorCode) => new TelephonyError('telnyx', message, status, code)

/** A Telnyx answer that was not 2xx, with Telnyx's own error codes (`errors[].code`), so a caller can tell known answers apart. */
export class TelnyxApiError extends TelephonyError {
  readonly errors: { code: string; detail: string }[]

  constructor(message: string, status: number, errors: { code: string; detail: string }[]) {
    super('telnyx', message, status)
    this.errors = errors
  }
}

/**
 * Telnyx's answer to a number search that matches nothing: HTTP 400 with one of these codes and details, not an empty
 * list. 10031 when a filter (an area code without free numbers, such as Toronto's 416) matches no number; 10015 when
 * the account has no coverage in the country. Both codes are also used for other bad requests, so the detail counts too.
 */
const NO_INVENTORY: Record<string, string> = {
  '10031': 'No numbers found',
  '10015': 'No coverage found',
}
const isNoInventory = (e: unknown) =>
  e instanceof TelnyxApiError && e.status === 400 && e.errors.length > 0 &&
  e.errors.every(({ code, detail }) => NO_INVENTORY[code] !== undefined && detail.startsWith(NO_INVENTORY[code]!))

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
    if (!res.ok) {
      const errors = (Array.isArray(json.errors) ? (json.errors as Json[]) : []).map(e => ({ code: String(e?.code ?? ''), detail: String(e?.detail ?? e?.title ?? '') }))
      throw new TelnyxApiError(`${where}: ${json.errors?.[0]?.detail ?? json.errors?.[0]?.title ?? res.statusText}`, res.status, errors)
    }
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
    // A timestamp that is not a number would pass the tolerance check below (NaN compares false).
    if (!/^\d{1,12}$/.test(timestamp)) throw fail('webhook timestamp is not a number')
    if (Math.abs(now() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SEC) throw fail('webhook timestamp is outside the tolerance')
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' })
    const valid = verify(null, Buffer.from(`${timestamp}|${rawBody}`), key, Buffer.from(signature, 'base64'))
    if (!valid) throw fail('webhook signature is not valid')
  }

  /** What Telnyx needs before it activates a local number in `country` (an address, documents), by name; none: []. */
  async function orderingRequirements(country: string): Promise<string[]> {
    const query = new URLSearchParams({ 'filter[country_code]': country, 'filter[phone_number_type]': 'local', 'filter[action]': 'ordering' })
    const { data } = await request('GET', `/regulatory_requirements?${query}`)
    // Only the row for exactly this country, local numbers and ordering: porting rules (Canada asks for an LOA) are not
    // asked for a purchase.
    const rows = ((data ?? []) as Json[]).filter(r =>
      (r.country_code ?? country) === country && (r.phone_number_type ?? 'local') === 'local' && (r.action ?? 'ordering') === 'ordering')
    return rows.flatMap(r => ((r.regulatory_requirements ?? []) as Json[]).map(q => String(q.name ?? q.field_type)))
  }

  /**
   * A number order that did not complete: its sub-orders are cancelled, so no number lands on the account later
   * without a row in Linedesk, and the operator gets an ALERT with the order (the user gets none of it: the error is
   * `not_activated`). Cancelling is best effort; the ALERT says when it failed.
   */
  async function notActivated(order: Json, e164: string, why: string): Promise<TelephonyError> {
    const ids = ((order.sub_number_orders_ids ?? []) as unknown[]).map(String)
    const results = await Promise.allSettled(ids.map(id => request('PATCH', `/sub_number_orders/${id}/cancel`)))
    const failed = results.flatMap(r => (r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []))
    const outcome = !ids.length
      ? 'it has no sub-order to cancel: cancel it in the Telnyx portal'
      : failed.length
        ? `cancelling it failed (${failed.join('; ')}): cancel it in the Telnyx portal, or release ${e164} once it is on the account`
        : 'it was cancelled'
    console.error(`ALERT number order ${order.id} for ${e164} ${why} at Telnyx; ${outcome}`)
    return fail(`number order ${order.id} for ${e164} ${why}`, undefined, 'not_activated')
  }

  /** The address behind a requirement group's address requirement; null when it has none or it cannot be read. */
  async function groupAddress(requirements: Json[]): Promise<RequirementGroupAddress | null> {
    const id = requirements.find(r => r.field_type === 'address' && r.field_value)?.field_value
    if (!id) return null
    try {
      const { data } = await request('GET', `/addresses/${encodeURIComponent(String(id))}`)
      if (!data) return null
      const street = [data.street_address, data.extended_address].filter(Boolean).join(', ')
      return { street, postalCode: String(data.postal_code ?? ''), city: String(data.locality ?? ''), country: String(data.country_code ?? '') }
    } catch (e) {
      console.warn(`telnyx: the address of a requirement group could not be read: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  /** Local numbers in stock (e164), by locality or area code; none in stock: []. */
  async function localStock(country: string, filter: { locality?: string; areaCode?: string }, limit: number): Promise<string[]> {
    const query = new URLSearchParams({ 'filter[country_code]': country, 'filter[phone_number_type]': 'local', 'filter[features][]': 'voice', 'filter[limit]': String(limit) })
    if (filter.locality) query.set('filter[locality]', filter.locality)
    if (filter.areaCode) query.set('filter[national_destination_code]', filter.areaCode)
    // A prefix that is no area code may be refused as a bad filter rather than found empty: none there either.
    const answer = await request('GET', `/available_phone_numbers?${query}`).catch((e: unknown) => {
      if (isNoInventory(e) || (e instanceof TelnyxApiError && (e.status === 400 || e.status === 422))) return null
      throw e
    })
    return ((answer?.data ?? []) as Json[]).filter(n => n.best_effort !== true).map(n => String(n.phone_number ?? ''))
  }

  return {
    name: 'telnyx',

    async searchNumbers({ country, areaCode, limit = 10, withRequirements = false, numberType }) {
      // Outside the US, a country can need an address or documents before Telnyx activates a local number (a
      // requirement group). A plain purchase submits none, so such a number would stay pending: refused before
      // buying. A purchase with the install's requirement group (withRequirements) passes them with the order.
      if (country !== 'US' && !withRequirements) {
        const needs = await orderingRequirements(country)
        if (needs.length)
          throw fail(`local numbers in ${country} need ${needs.join(', ')} at Telnyx, which Linedesk cannot submit yet`, undefined, 'country_requirements')
      }
      // No best-effort results (US and Canada): those are numbers near the area code, not in it.
      const query = new URLSearchParams({ 'filter[country_code]': country, 'filter[features][]': 'voice', 'filter[limit]': String(limit), 'filter[best_effort]': 'false' })
      if (areaCode) query.set('filter[national_destination_code]', areaCode)
      if (numberType) query.set('filter[phone_number_type]', numberType)
      const answer = await request('GET', `/available_phone_numbers?${query}`).catch((e: unknown) => {
        if (!isNoInventory(e)) throw e
        // No free number there: an empty search, which the app tells as such. Telnyx's words stay in the log.
        const why = (e as TelnyxApiError).errors.map(x => `${x.detail} (${x.code})`).join('; ')
        console.warn(`telnyx: no number found for ${country}${areaCode ? ` area code ${areaCode}` : ''}: ${why}`)
        return null
      })
      if (!answer) return []
      return ((answer.data ?? []) as Json[]).filter(n => n.best_effort !== true).map((n): AvailableNumber => {
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

    async buyNumber(e164, options): Promise<OwnedNumber> {
      const group = options?.requirementGroupRef
      const { data } = await request('POST', '/number_orders', {
        phone_numbers: [{ phone_number: e164, ...(group ? { requirement_group_id: group } : {}) }],
      })
      if (data.status === 'failure') throw fail(`number order ${data.id} for ${e164} failed`)
      // An order whose regulatory requirements are not met stays pending until they are, at Telnyx: cancelled.
      if (data.requirements_met === false) throw await notActivated(data, e164, 'waits for regulatory requirements (address or documents)')
      // The order completes asynchronously; the number has an id once it is on the account.
      for (let attempt = 0; attempt < ORDER_LOOKUPS; attempt++) {
        await wait(1000)
        const id = await findNumberId(e164)
        if (id) return { e164, providerRef: id }
      }
      const error = await notActivated(data, e164, 'is still pending')
      // Completed while it was being cancelled: bought after all (the caller releases it if the setup fails).
      const late = await findNumberId(e164)
      if (late) return { e164, providerRef: late }
      throw error
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

    async requirementGroup(id): Promise<RequirementGroup | null> {
      let data: Json
      try {
        ;({ data } = await request('GET', `/requirement_groups/${encodeURIComponent(id)}`))
      } catch (e) {
        if (e instanceof TelephonyError && e.status === 404) return null
        throw e
      }
      if (!data) return null
      return {
        id: String(data.id ?? id),
        country: String(data.country_code ?? ''),
        numberType: String(data.phone_number_type ?? ''),
        action: String(data.action ?? ''),
        status: String(data.status ?? ''),
        address: await groupAddress((data.regulatory_requirements ?? []) as Json[]),
        portalUrl: telnyxRequirementGroupUrl(String(data.id ?? id)),
      }
    },

    // Telnyx's search answers no area code: it is the one prefix of a number in the locality that, searched as an
    // area code, finds numbers. German area codes are prefix-free (no code starts another), so exactly one of a
    // number's 2- to 5-digit prefixes does; more than one (a search that matched loosely) is not sure: null.
    async localAreaCode(country, locality) {
      const callingCode = country === 'DE' ? '49' : null
      if (!callingCode || !locality.trim()) return null
      const found = await localStock(country, { locality: locality.trim() }, 5)
      const national = found[0]?.startsWith(`+${callingCode}`) ? found[0].slice(callingCode.length + 1) : null
      if (!national) return null
      const candidates = AREA_CODE_LENGTHS.map(n => national.slice(0, n)).filter(c => c.length < national.length)
      const hits: string[] = []
      for (const code of candidates) {
        const stock = await localStock(country, { areaCode: code }, 1)
        if (stock.some(e164 => e164.startsWith(`+${callingCode}${code}`))) hits.push(code)
      }
      const [code] = hits
      if (hits.length !== 1 || !code) return null
      // Numbers of the locality in another area code: it spans more than one, not sure either.
      return found.every(e164 => e164.startsWith(`+${callingCode}${code}`)) ? code : null
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
