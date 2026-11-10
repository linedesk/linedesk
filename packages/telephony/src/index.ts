import { devProvider } from './dev.ts'
import type { TelephonyProvider } from './provider.ts'
import { createTelnyxProvider } from './telnyx.ts'

export * from './provider.ts'
export { devProvider } from './dev.ts'
export { createTelnyxProvider, type TelnyxOptions } from './telnyx.ts'

type Env = Record<string, string | undefined>

/** The provider selected by TELEPHONY_PROVIDER (default: dev). Throws naming a missing variable. */
export function telephonyProviderFromEnv(env: Env): TelephonyProvider {
  const name = env.TELEPHONY_PROVIDER ?? 'dev'
  if (name === 'dev') return devProvider
  if (name === 'telnyx') {
    if (!env.TELNYX_API_KEY) throw new Error('TELNYX_API_KEY is not set')
    return createTelnyxProvider({ apiKey: env.TELNYX_API_KEY, publicKey: env.TELNYX_PUBLIC_KEY })
  }
  throw new Error(`unknown TELEPHONY_PROVIDER "${name}" (use telnyx or dev)`)
}
