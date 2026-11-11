// Outbound calls through Telnyx for LiveKit SIP: a credential connection LiveKit registers against,
// with an outbound voice profile, and the caller-ID number attached to it. Used by the phone-to-phone
// call test. Only objects with this file's names are created or changed; other connections in the
// account (for example one that serves another product) are never touched.
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
const fail = (message: string) => new TelephonyError('telnyx', message)

/** Telnyx user names: 4 to 32 letters and digits, a letter among the first five. */
export const sipUserName = (name: string) => `cf${name.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 32)

export function createTelnyxOutbound({ apiKey, name = DEFAULT_NAME, fetch: doFetch = fetch }: TelnyxOutboundOptions) {
  const request = telnyxRequest(apiKey, doFetch)
  const byExactName = (items: Json[] | undefined, field: string) => items?.find(item => item[field] === name)

  async function ensureVoiceProfile(): Promise<string> {
    const { data } = await request('GET', `/outbound_voice_profiles?filter[name][contains]=${encodeURIComponent(name)}`)
    const existing = byExactName(data, 'name')
    if (existing) return existing.id
    const created = await request('POST', '/outbound_voice_profiles', {
      name, traffic_type: 'conversational', service_plan: 'global', whitelisted_destinations: ['US'],
    })
    return created.data.id
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
    /** Sets up (or repairs) outbound calling with `callerE164` as caller ID; returns the trunk settings with a new password. */
    async ensureOutboundSip(callerE164: string): Promise<OutboundSip> {
      const username = sipUserName(name)
      const password = randomBytes(18).toString('base64url')
      const profileId = await ensureVoiceProfile()
      const connectionId = await ensureConnection(profileId, username, password)
      await attachCallerNumber(connectionId, callerE164)
      return { address: 'sip.telnyx.com', username, password, headers: { 'X-Telnyx-Username': username } }
    },
  }
}
