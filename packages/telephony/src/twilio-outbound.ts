// Outbound calls through Twilio for LiveKit SIP, in a business's own Twilio account: an Elastic SIP
// trunk with a termination domain (`<name>-<random>.pstn.twilio.com`) and a credential list LiveKit
// authenticates with. The counterpart of telnyx-outbound.ts, for warm transfers from a workspace that
// brings its own Twilio account. Only objects with the given `linedesk-*` name are created or changed.
// Which destinations the account may call is Twilio's Voice Geographic Permissions (account-wide, in the
// console); Linedesk checks the number before it dials (US only).
import { randomBytes } from 'node:crypto'
import { TelephonyError } from './provider.ts'
import type { OutboundSip } from './telnyx-outbound.ts'
import { sipUserName } from './telnyx-outbound.ts'
import { TWILIO_TRUNKING, type TwilioOptions, twilioAccountUrl, twilioRequest } from './twilio.ts'

// biome-ignore lint/suspicious/noExplicitAny: Twilio's JSON is read field by field
type Json = Record<string, any>

const OWN_PREFIX = 'linedesk-'
export const TWILIO_OUTBOUND_NAME = 'linedesk-outbound'

/** Twilio SIP passwords: at least 12 characters with an upper-case letter, a lower-case letter and a digit. */
const newPassword = () => `Ld7${randomBytes(18).toString('base64url')}`
/** Termination domains are global at Twilio, so each gets a random part. */
/** A DNS label holds 63 characters: the name is cut to its first 17 ("linedesk-outbound"), the random part keeps it apart. */
const newDomain = (name: string) =>
  `${name.slice(0, 17).toLowerCase()}-${randomBytes(6).toString('hex')}.pstn.twilio.com`

export type TwilioOutboundOptions = TwilioOptions & { name?: string }

export function createTwilioOutbound({ name = TWILIO_OUTBOUND_NAME, ...options }: TwilioOutboundOptions) {
  if (!name.startsWith(OWN_PREFIX)) {
    throw new TelephonyError('twilio', `refusing to manage "${name}": only objects named ${OWN_PREFIX}* are Linedesk's`)
  }
  const request = twilioRequest(options)
  const account = twilioAccountUrl(options.accountSid)
  const named = (items: Json[] | undefined) => items?.find(item => item.friendly_name === name)

  /** The trunk with its termination domain; created if missing, given a domain if it has none. */
  async function ensureTrunk(): Promise<{ sid: string; domain: string }> {
    const existing = named((await request('list trunks', 'GET', `${TWILIO_TRUNKING}/Trunks?PageSize=1000`)).trunks)
    if (existing?.domain_name) return { sid: existing.sid, domain: existing.domain_name }
    const domain = newDomain(name)
    if (existing) {
      await request('set termination domain', 'POST', `${TWILIO_TRUNKING}/Trunks/${existing.sid}`, {
        DomainName: domain,
      })
      return { sid: existing.sid, domain }
    }
    const created = await request('create trunk', 'POST', `${TWILIO_TRUNKING}/Trunks`, {
      FriendlyName: name,
      DomainName: domain,
    })
    return { sid: created.sid, domain: created.domain_name ?? domain }
  }

  async function ensureCredentialList(): Promise<string> {
    const lists = `${account}/SIP/CredentialLists.json`
    const existing = named((await request('list credential lists', 'GET', `${lists}?PageSize=1000`)).credential_lists)
    return existing?.sid ?? (await request('create credential list', 'POST', lists, { FriendlyName: name })).sid
  }

  /** The user with a new password: Twilio never returns a stored one. */
  async function setCredential(listSid: string, username: string, password: string) {
    const credentials = `${account}/SIP/CredentialLists/${listSid}/Credentials`
    const all = (await request('list credentials', 'GET', `${credentials}.json?PageSize=1000`)).credentials as
      | Json[]
      | undefined
    const existing = all?.find(c => c.username === username)
    if (existing)
      await request('set credential password', 'POST', `${credentials}/${existing.sid}.json`, { Password: password })
    else await request('create credential', 'POST', `${credentials}.json`, { Username: username, Password: password })
  }

  async function attachCredentialList(trunkSid: string, listSid: string) {
    const url = `${TWILIO_TRUNKING}/Trunks/${trunkSid}/CredentialLists`
    const attached = ((await request('list trunk credential lists', 'GET', `${url}?PageSize=1000`)).credential_lists ??
      []) as Json[]
    if (!attached.some(l => l.sid === listSid))
      await request('attach credential list', 'POST', url, { CredentialListSid: listSid })
  }

  return {
    /** Sets up (or repairs) outbound calling; returns the trunk settings with a new password. Safe to repeat. */
    async ensureOutboundSip(): Promise<OutboundSip> {
      const username = sipUserName(name)
      const password = newPassword()
      const trunk = await ensureTrunk()
      const listSid = await ensureCredentialList()
      await setCredential(listSid, username, password)
      await attachCredentialList(trunk.sid, listSid)
      return { address: trunk.domain, username, password, headers: {} }
    },
  }
}
