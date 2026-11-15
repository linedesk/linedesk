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
  /**
   * The countries the voice profile may call (ISO codes; default: the US only). Linedesk's destination policy
   * (packages/actions/src/outbound.ts) decides them; never empty, which Telnyx could take as "anywhere".
   */
  destinations?: readonly string[]
  /** The voice profile's cost ceilings (default: DEFAULT_SPEND_LIMITS; `telnyxSpendLimits(env)` reads them from the env). */
  spendLimits?: TelnyxSpendLimits
  /**
   * Told whether the voice profile now has the spend limits: null once Telnyx saved them, else the problem (the set-up
   * then fails). The API records it for Server admin (telnyx-spend-caps.ts).
   */
  onSpendCaps?: (problem: string | null) => void | Promise<void>
  fetch?: typeof fetch
}

/**
 * Telnyx's own cost ceilings on a voice profile, beside Linedesk's minute limits: a destination whose rate is above
 * `maxDestinationRate` (USD per minute) is refused by Telnyx, and once the profile's charges of the day reach
 * `dailySpendLimit` (USD) Telnyx refuses new calls on it until the next day.
 */
export interface TelnyxSpendLimits {
  maxDestinationRate: number
  dailySpendLimit: number
}

/**
 * $0.10 a minute lets normal landline and mobile calls through (the US and Canada cost about a cent, mobile in most of
 * Europe and Latin America a few cents) and stops premium, satellite and expensive mobile ranges. $50 a day is the
 * install's 2000 transfer minutes (OUTBOUND_MINUTES_INSTALL_DAY) at 2.5 cents, a few times what they cost to US
 * numbers; at the highest allowed rate it stops a day at $50 instead of $200.
 */
export const DEFAULT_SPEND_LIMITS: TelnyxSpendLimits = { maxDestinationRate: 0.1, dailySpendLimit: 50 }
/** Above these a limit is still applied, but the API warns at start: likely a typo (cents for dollars, an extra 0). */
export const SPEND_LIMIT_WARN_ABOVE: TelnyxSpendLimits = { maxDestinationRate: 1, dailySpendLimit: 500 }

/** Warnings for limits so high they barely limit anything (applied anyway; the operator decides). */
export function spendLimitWarnings(limits: TelnyxSpendLimits): string[] {
  const warnings: string[] = []
  if (limits.maxDestinationRate > SPEND_LIMIT_WARN_ABOVE.maxDestinationRate)
    warnings.push(
      `TELNYX_MAX_DESTINATION_RATE is $${limits.maxDestinationRate}/min, above $${SPEND_LIMIT_WARN_ABOVE.maxDestinationRate}/min: premium and toll-fraud ranges are not stopped`,
    )
  if (limits.dailySpendLimit > SPEND_LIMIT_WARN_ABOVE.dailySpendLimit)
    warnings.push(
      `TELNYX_DAILY_SPEND_LIMIT is $${limits.dailySpendLimit} a day per voice profile, above $${SPEND_LIMIT_WARN_ABOVE.dailySpendLimit}`,
    )
  return warnings
}

// biome-ignore lint/suspicious/noExplicitAny: Telnyx's JSON is read field by field
type Json = Record<string, any>

const DEFAULT_NAME = 'linedesk-test-caller'
/**
 * Outbound calls go only to the allowed countries (default: the US). Telnyx creates new voice profiles only on the
 * global plan now ("conversational, global, rate-deck"; the US plan is refused), so the destination list is what keeps
 * them to those countries.
 */
const DEFAULT_DESTINATIONS = ['US']
const NEW_PROFILE_PLAN = { traffic_type: 'conversational', service_plan: 'global', usage_payment_method: 'rate-deck' }
/** Linedesk only ever creates or changes Telnyx objects whose name starts with this. */
export const OWN_PREFIX = 'linedesk-'
/** The connection warm transfers go out through. */
export const TRANSFER_OUTBOUND_NAME = 'linedesk-outbound'
const fail = (message: string) => new TelephonyError('telnyx', message)

/**
 * The spend limits from `TELNYX_MAX_DESTINATION_RATE` (USD per minute) and `TELNYX_DAILY_SPEND_LIMIT` (USD per voice
 * profile and day); unset or empty: the default. Anything that is not a positive amount is refused (never quietly the
 * default, never no limit): the set-up fails until it is fixed.
 */
export function telnyxSpendLimits(env: Record<string, string | undefined>): TelnyxSpendLimits {
  const amount = (name: string, fallback: number) => {
    const value = env[name]?.trim()
    if (!value) return fallback
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) throw fail(`${name}=${value} is not a positive amount in USD`)
    return n
  }
  return {
    maxDestinationRate: amount('TELNYX_MAX_DESTINATION_RATE', DEFAULT_SPEND_LIMITS.maxDestinationRate),
    dailySpendLimit: amount('TELNYX_DAILY_SPEND_LIMIT', DEFAULT_SPEND_LIMITS.dailySpendLimit),
  }
}

/** What a voice profile gets besides its countries: both ceilings, the daily one switched on (Telnyx's default is off). */
function spendFields(limits: TelnyxSpendLimits) {
  if (!(limits.maxDestinationRate > 0) || !(limits.dailySpendLimit > 0))
    throw fail(`refusing the spend limits ${JSON.stringify(limits)}`)
  return {
    max_destination_rate: limits.maxDestinationRate,
    daily_spend_limit: limits.dailySpendLimit.toFixed(2),
    daily_spend_limit_enabled: true,
  }
}

/** The destination list as Telnyx gets it: upper-case ISO codes, each once, sorted; refuses an empty or malformed one. */
function destinationList(destinations: readonly string[]): string[] {
  const list = [...new Set(destinations.map(c => c.toUpperCase()))].sort()
  if (!list.length || list.some(c => !/^[A-Z]{2}$/.test(c)))
    throw fail(`refusing the destination list ${JSON.stringify(destinations)}`)
  return list
}

/** An amount Telnyx returned (a number, or a string such as "50.00"); NaN when it is missing or not one. */
const amountOf = (value: unknown) =>
  value === null || value === undefined || value === '' ? Number.NaN : Number(value)

/**
 * Fail closed: a profile Telnyx did not keep to exactly these countries (`wanted`; null: its countries were left as
 * they are), or without both spend limits at or below the configured ones (the daily one switched on), is never used.
 */
function checkSaved(name: string, saved: Json, wanted: string[] | null, limits: TelnyxSpendLimits) {
  const profile = saved.data ?? {}
  const destinations = profile.whitelisted_destinations
  if (wanted && (!Array.isArray(destinations) || [...destinations].sort().join() !== wanted.join()))
    throw fail(`voice profile "${name}" is not limited to ${wanted.join(', ')} (${JSON.stringify(destinations)})`)
  const rate = amountOf(profile.max_destination_rate)
  if (!(rate > 0 && rate <= limits.maxDestinationRate))
    throw fail(
      `voice profile "${name}" has no max destination rate of at most $${limits.maxDestinationRate}/min (${JSON.stringify(profile.max_destination_rate)})`,
    )
  const daily = amountOf(profile.daily_spend_limit)
  if (profile.daily_spend_limit_enabled !== true || !(daily > 0 && daily <= limits.dailySpendLimit))
    throw fail(
      `voice profile "${name}" has no daily spend limit of at most $${limits.dailySpendLimit} (${JSON.stringify({ daily_spend_limit: profile.daily_spend_limit, daily_spend_limit_enabled: profile.daily_spend_limit_enabled })})`,
    )
}

/**
 * Sets the allowed countries and the spend limits of the existing voice profile of that name (a `linedesk-*` one),
 * without touching its connection or password: when the countries a workspace or the install may call change, and at
 * the API's start (so an update brings older profiles to the limits). `destinations` null: only the spend limits, the
 * countries stay as they are (an install or workspace without numbers: no list to give, and never an empty one).
 * Returns false when there is no such profile (nothing to change: the next set-up creates it with both).
 */
export async function setTelnyxDestinations({
  apiKey,
  name,
  destinations,
  spendLimits = DEFAULT_SPEND_LIMITS,
  fetch: doFetch = fetch,
}: {
  apiKey: string
  name: string
  destinations: readonly string[] | null
  spendLimits?: TelnyxSpendLimits
  fetch?: typeof fetch
}): Promise<boolean> {
  if (!name.startsWith(OWN_PREFIX))
    throw fail(`refusing to manage "${name}": only objects named ${OWN_PREFIX}* are Linedesk's`)
  const wanted = destinations ? destinationList(destinations) : null
  const spend = spendFields(spendLimits)
  const request = telnyxRequest(apiKey, doFetch)
  const { data } = await request('GET', `/outbound_voice_profiles?filter[name][contains]=${encodeURIComponent(name)}`)
  const existing = (data as Json[] | undefined)?.find(item => item.name === name)
  if (!existing) return false
  checkSaved(
    name,
    // Telnyx requires the name on every PATCH of a voice profile.
    await request('PATCH', `/outbound_voice_profiles/${existing.id}`, {
      name,
      ...(wanted ? { whitelisted_destinations: wanted } : {}),
      ...spend,
    }),
    wanted,
    spendLimits,
  )
  return true
}

/** Telnyx user names: 4 to 32 letters and digits, a letter among the first five. */
export const sipUserName = (name: string) => `cf${name.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 32)

export function createTelnyxOutbound({
  apiKey,
  name = DEFAULT_NAME,
  destinations = DEFAULT_DESTINATIONS,
  spendLimits = DEFAULT_SPEND_LIMITS,
  onSpendCaps,
  fetch: doFetch = fetch,
}: TelnyxOutboundOptions) {
  if (!name.startsWith(OWN_PREFIX))
    throw fail(`refusing to manage "${name}": only objects named ${OWN_PREFIX}* are Linedesk's`)
  const allowed = { whitelisted_destinations: destinationList(destinations), ...spendFields(spendLimits) }
  const request = telnyxRequest(apiKey, doFetch)
  const byExactName = (items: Json[] | undefined, field: string) => items?.find(item => item[field] === name)

  /**
   * Created, or put back to the allowed countries and the spend limits on every run: a profile changed by hand cannot
   * open other countries or a higher spend.
   */
  async function ensureVoiceProfile(): Promise<string> {
    let id: string
    try {
      const { data } = await request('GET', `/outbound_voice_profiles?filter[name][contains]=${encodeURIComponent(name)}`)
      const existing = byExactName(data, 'name')
      // Telnyx requires the name on every PATCH of a voice profile.
      const saved = existing
        ? await request('PATCH', `/outbound_voice_profiles/${existing.id}`, { name, ...allowed })
        : await request('POST', '/outbound_voice_profiles', { name, ...NEW_PROFILE_PLAN, ...allowed })
      checkSaved(name, saved, allowed.whitelisted_destinations, spendLimits)
      id = existing?.id ?? saved.data.id
    } catch (e) {
      await onSpendCaps?.(e instanceof Error ? e.message : String(e))
      throw e
    }
    await onSpendCaps?.(null)
    return id
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
