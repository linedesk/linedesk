// Outbound calls through Telnyx for LiveKit SIP: a credential connection LiveKit registers against,
// with an outbound voice profile. Used by the phone-to-phone call test (named "linedesk-test-caller",
// with its caller-ID number attached) and by warm transfers ("linedesk-outbound", no number attached:
// each transfer shows the business's own Linedesk number, which stays on its inbound connection).
// Only objects with the given name are created or changed; other connections in the account (for
// example one that serves another product) are never touched.
import { randomBytes } from 'node:crypto'
import { TelephonyError } from './provider.ts'
import { telnyxRequest } from './telnyx.ts'

/** What a LiveKit SIP outbound trunk needs to send calls through Telnyx. */
export interface OutboundSip {
  address: string
  username: string
  password: string
  /** Telnyx matches the INVITE to this connection by this header, not by source IP. */
  headers: Record<string, string>
}

export interface TelnyxOutboundOptions {
  apiKey: string
  /** Name of the connection and the voice profile; also the base of the SIP user name. */
  name?: string
  fetch?: typeof fetch
}

// biome-ignore lint/suspicious/noExplicitAny: Telnyx's JSON is read field by field
type Json = Record<string, any>

const DEFAULT_NAME = 'linedesk-test-caller'
/**
 * Outbound calls go to US numbers only: the US is the only allowed destination. Telnyx creates new voice
 * profiles only on the global plan now ("conversational, global, rate-deck"; the US plan is refused), so the
 * destination list is what keeps them to the US.
 */
const US_ONLY = { whitelisted_destinations: ['US'] }
const NEW_PROFILE_PLAN = { traffic_type: 'conversational', service_plan: 'global', usage_payment_method: 'rate-deck' }
/** Linedesk only ever creates or changes Telnyx objects whose name starts with this. */
export const OWN_PREFIX = 'linedesk-'
/** The connection warm transfers go out through. */
export const TRANSFER_OUTBOUND_NAME = 'linedesk-outbound'
const fail = (message: string) => new TelephonyError('telnyx', message)

/** Telnyx user names: 4 to 32 letters and digits, a letter among the first five. */
export const sipUserName = (name: string) => `cf${name.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 32)

export function createTelnyxOutbound({ apiKey, name = DEFAULT_NAME, fetch: doFetch = fetch }: TelnyxOutboundOptions) {
  if (!name.startsWith(OWN_PREFIX)) throw fail(`refusing to manage "${name}": only objects named ${OWN_PREFIX}* are Linedesk's`)
  const request = telnyxRequest(apiKey, doFetch)
  const byExactName = (items: Json[] | undefined, field: string) => items?.find(item => item[field] === name)

  /** Created, or put back to US-only on every run: a profile changed by hand cannot open other destinations. */
  async function ensureVoiceProfile(): Promise<string> {
    const { data } = await request('GET', `/outbound_voice_profiles?filter[name][contains]=${encodeURIComponent(name)}`)
    const existing = byExactName(data, 'name')
    const saved = existing
      ? await request('PATCH', `/outbound_voice_profiles/${existing.id}`, US_ONLY)
      : await request('POST', '/outbound_voice_profiles', { name, ...NEW_PROFILE_PLAN, ...US_ONLY })
    // Fail closed: a profile that could call anywhere but the US is never used.
    const destinations = saved.data?.whitelisted_destinations
    if (!Array.isArray(destinations) || destinations.join() !== 'US')
      throw fail(`voice profile "${name}" is not limited to US destinations (${JSON.stringify(destinations)})`)
    return existing?.id ?? saved.data.id
  }

  /** Creates the connection, or sets a fresh password on it: Telnyx does not return a stored password. */
  async function ensureConnection(profileId: string, username: string, password: string): Promise<string> {
    const { data } = await request('GET', `/credential_connections?filter[connection_name][contains]=${encodeURIComponent(name)}`)
    const existing = byExactName(data, 'connection_name')
    const body = { active: true, connection_name: name, user_name: username, password, outbound: { outbound_voice_profile_id: profileId } }
    if (existing) {
      await request('PATCH', `/credential_connections/${existing.id}`, body)
      return existing.id
    }
    return (await request('POST', '/credential_connections', { ...body, anchorsite_override: 'Latency' })).data.id
  }

  async function attachCallerNumber(connectionId: string, callerE164: string) {
    const { data } = await request('GET', `/phone_numbers?filter[phone_number]=${encodeURIComponent(callerE164)}`)
    const number = (data as Json[] | undefined)?.find(n => n.phone_number === callerE164)
    if (!number) throw fail(`${callerE164} is not in the Telnyx account`)
    if (number.connection_id === connectionId) return
    if (number.connection_id) throw fail(`${callerE164} is attached to another connection; it must be a number used only for the call test`)
    await request('PATCH', `/phone_numbers/${number.id}`, { connection_id: connectionId })
  }

  return {
    /**
     * Sets up (or repairs) outbound calling; returns the trunk settings with a new password. With
     * `callerE164` that number is attached to the connection as its caller ID (a number used only for this).
     */
    async ensureOutboundSip(callerE164?: string): Promise<OutboundSip> {
      const username = sipUserName(name)
      const password = randomBytes(18).toString('base64url')
      const profileId = await ensureVoiceProfile()
      const connectionId = await ensureConnection(profileId, username, password)
      if (callerE164) await attachCallerNumber(connectionId, callerE164)
      return { address: 'sip.telnyx.com', username, password, headers: { 'X-Telnyx-Username': username } }
    },
  }
}
