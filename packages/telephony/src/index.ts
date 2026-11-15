import { devProvider } from './dev.ts'
import { installCarrierName, type TelephonyProvider } from './provider.ts'
import { createTelnyxProvider } from './telnyx.ts'
import { createTelnyxOutbound, type OutboundSip, TRANSFER_OUTBOUND_NAME, telnyxSpendLimits } from './telnyx-outbound.ts'
import { createTwilioProvider } from './twilio.ts'

export * from './provider.ts'
export { DEV_LOOKUP, devForwardingOutcome, devProvider, type DevForwardingOutcome } from './dev.ts'
export { createTelnyxProvider, telnyxLineType, type TelnyxOptions } from './telnyx.ts'
export {
  createTelnyxOutbound,
  DEFAULT_SPEND_LIMITS,
  SPEND_LIMIT_WARN_ABOVE,
  setTelnyxDestinations,
  sipUserName,
  spendLimitWarnings,
  telnyxSpendLimits,
  TRANSFER_OUTBOUND_NAME,
  type OutboundSip,
  type TelnyxOutboundOptions,
  type TelnyxSpendLimits,
} from './telnyx-outbound.ts'
export { createTwilioProvider, twilioLineType, type TwilioOptions } from './twilio.ts'
export {
  createTwilioOutbound,
  TWILIO_OUTBOUND_NAME,
  twilioBlockedCountries,
  type TwilioOutboundOptions,
} from './twilio-outbound.ts'
export {
  CARRIER_SIGNALING_ADDRESSES,
  type CarrierSignalingAddresses,
  type SignalingCarrier,
} from './signaling-addresses.ts'

type Env = Record<string, string | undefined>

/**
 * The provider selected by TELEPHONY_PROVIDER. Without it the provider is `dev`, which never
 * reaches a carrier: buying numbers always takes an explicit choice. Throws naming a missing variable.
 */
export function telephonyProviderFromEnv(env: Env): TelephonyProvider {
  const name = env.TELEPHONY_PROVIDER || 'dev'
  if (name === 'dev') return devProvider
  if (name === 'twilio') {
    const missing = (['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] as const).filter(key => !env[key])
    if (missing.length) throw new Error(`${missing.join(', ')} not set (needed for TELEPHONY_PROVIDER=twilio)`)
    return createTwilioProvider({ accountSid: env.TWILIO_ACCOUNT_SID!, authToken: env.TWILIO_AUTH_TOKEN! })
  }
  if (name === 'telnyx') {
    if (!env.TELNYX_API_KEY) throw new Error('TELNYX_API_KEY is not set')
    return createTelnyxProvider({ apiKey: env.TELNYX_API_KEY, publicKey: env.TELNYX_PUBLIC_KEY })
  }
  throw new Error(`unknown TELEPHONY_PROVIDER "${name}" (use telnyx, twilio or dev)`)
}

/**
 * The SIP credentials warm transfers dial out with, at the carrier TELEPHONY_PROVIDER names. Telnyx
 * only for now; Twilio (Elastic SIP Trunking) comes later. Creates or repairs the carrier side and
 * sets a new password each time.
 */
export async function transferOutboundSipFromEnv(
  env: Env,
  doFetch?: typeof fetch,
  destinations?: readonly string[],
): Promise<OutboundSip> {
  const name = env.TELEPHONY_PROVIDER || 'dev'
  if (name !== 'telnyx') throw new Error(`warm transfer dials out through Telnyx only for now (TELEPHONY_PROVIDER is ${name})`)
  if (!env.TELNYX_API_KEY) throw new Error('TELNYX_API_KEY is not set')
  return createTelnyxOutbound({
    apiKey: env.TELNYX_API_KEY,
    name: installCarrierName(TRANSFER_OUTBOUND_NAME),
    destinations,
    spendLimits: telnyxSpendLimits(env),
    fetch: doFetch,
  }).ensureOutboundSip()
}
