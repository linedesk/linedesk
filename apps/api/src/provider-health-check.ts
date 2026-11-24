// The background health check (LIN-158): every few hours (PROVIDER_HEALTH_CHECK_HOURS, default 6) the free key check
// of every provider that is set up (testProvider in its free mode: balance, account, key and model lists; never the
// few tokens or the one character of speech a manual test may spend, never a paid round trip like provider.tryOut), so a key that stopped working shows on the admin overview before a caller
// finds out. Each result is stored like a test from the admin pages (provider_tests); a pass clears the provider's
// failure, a failure is recorded (provider_failures). The instance admins get one email when a provider that calls
// need and that is in use starts failing: provider_failures.alerted_at keeps it to one email until the provider works
// again. A passing problem (not reachable, no answer in time) emails only when the check before failed too.
import {
  isMultiCategory,
  isNeededProvider,
  type ProviderName,
  type ProviderTestData,
  passingProviderFailure,
  providerNames,
  providerSpec,
} from '@linedesk/actions'
import { provider_failures, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { db } from './db.ts'
import { clearProviderFailures, recordProviderFailure } from './provider-failures.ts'
import { providerStatus, resolveProvider } from './provider-settings.ts'
import { missingFields, testProvider } from './provider-test.ts'
import { SecretsKeyError } from './secrets.ts'
import { rememberTest } from './setup-checklist.ts'

type Env = Record<string, string | undefined>

export const PROVIDER_HEALTH_CHECK = 'providers.healthCheck'
export const DEFAULT_HEALTH_CHECK_HOURS = 6

/**
 * How often the check runs, in hours (1 to 24); null when it is off (PROVIDER_HEALTH_CHECK_HOURS=0 or off). Anything
 * else that is not a whole number of hours falls back to the default.
 */
export function healthCheckHours(env: Env = process.env): number | null {
  const raw = env.PROVIDER_HEALTH_CHECK_HOURS?.trim().toLowerCase()
  if (!raw) return DEFAULT_HEALTH_CHECK_HOURS
  if (raw === 'off' || raw === '0') return null
  const hours = Number(raw)
  return Number.isInteger(hours) && hours >= 1 && hours <= 24 ? hours : DEFAULT_HEALTH_CHECK_HOURS
}

/** The schedule: at minute 23 every `hours` hours (quiet minutes, next to the other jobs). */
export const healthCheckCron = (hours: number) => `23 */${hours} * * *`

/** The free key check; replaced in tests. Must never be a paid round trip. */
export type KeyCheck = (
  provider: ProviderName,
  config: Awaited<ReturnType<typeof resolveProvider>>,
) => Promise<ProviderTestData>
/** testProvider in its free mode: no tokens, no speech, no transcription. */
export const freeKeyCheck: KeyCheck = (provider, config) =>
  testProvider(provider, config, fetch, process.env, { free: true })

export type HealthCheckResult = { tested: ProviderName[]; failing: ProviderName[]; alerted: ProviderName[] }

/** Runs the check once: every provider that is set up, one after the other. */
export async function runProviderHealthCheck(
  tx: Tx = db,
  { check = freeKeyCheck, now = new Date(), env }: { check?: KeyCheck; now?: Date; env?: Env } = {},
): Promise<HealthCheckResult> {
  const result: HealthCheckResult = { tested: [], failing: [], alerted: [] }
  const { active } = await providerStatus(tx, env)
  for (const provider of providerNames) {
    const { category } = providerSpec(provider)
    const inUse = isMultiCategory(category) || active[category].provider === provider
    // The local disk needs no keys, so it is always "set up": a store is checked only while calls are recorded there.
    if (category === 'recording' && !inUse) continue
    let config: Awaited<ReturnType<typeof resolveProvider>>
    try {
      config = await resolveProvider(tx, provider, env)
    } catch (e) {
      // Keys that cannot be read (SECRETS_KEY missing or changed) already show on every admin page.
      if (e instanceof SecretsKeyError) continue
      throw e
    }
    if (missingFields(provider, config).length) continue
    const tested: ProviderTestData = await check(provider, config).catch(e => ({
      ok: false,
      status: 'error' as const,
      reason: 'unknown' as const,
      message: e instanceof Error ? e.message : String(e),
    }))
    result.tested.push(provider)
    await rememberTest(tx, provider, config, tested, now)
    if (tested.ok) {
      await clearProviderFailures(tx, [provider])
      continue
    }
    result.failing.push(provider)
    const reason = tested.reason ?? 'unknown'
    const [before] = await tx
      .select({ provider: provider_failures.provider })
      .from(provider_failures)
      .where(eq(provider_failures.provider, provider))
    // Only what calls need and use is worth an email; a passing problem only when it failed the time before too.
    const warn = isNeededProvider(provider) && inUse && (!passingProviderFailure(reason) || !!before)
    const recorded = await recordProviderFailure(
      tx,
      provider,
      { reason, message: tested.message },
      warn ? 'health' : 'test',
      // The check is the diagnosis: never a second request.
      { now, diagnose: async () => tested },
    )
    if (recorded.alerted) result.alerted.push(provider)
  }
  return result
}
