import { devProvider } from './dev.ts'
import type { TelephonyProvider } from './provider.ts'
import { createTelnyxProvider } from './telnyx.ts'
import { createTwilioProvider } from './twilio.ts'

export * from './provider.ts'
export { devProvider } from './dev.ts'
export { createTelnyxProvider, type TelnyxOptions } from './telnyx.ts'
export { createTwilioProvider, type TwilioOptions } from './twilio.ts'

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
  throw new Error(`unknown TELEPHONY_PROVIDER "${name}" (use twilio, telnyx or dev)`)
}
