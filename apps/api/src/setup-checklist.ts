// The instance setup checklist (docs/architecture.md §12): per part a first answered call needs (email, phone
// carrier, speech, model, voice, LiveKit and SIP) whether it is set up and whether the last test of exactly these
// keys passed. GET /v1/admin/setup-checklist and `scripts/setup.sh --check` (setup-check.ts) read it.
//
// Test results are kept in memory per API process, keyed by a hash of the keys in effect: a changed key is untested
// again, and nothing about a key is stored. After a restart items show "set up" until tested again (the admin page
// tests them when it opens, through provider.test). Reading the checklist never calls a provider.
import { createHmac, randomBytes } from 'node:crypto'
import {
  checklistSummary,
  type ProviderName,
  type ProviderTestData,
  providerSpec,
  type SetupChecklist,
  type SetupChecklistItem,
  type SetupItemSpec,
  setupItems,
  setupItemState,
} from '@linedesk/actions'
import type { Tx } from '@linedesk/db'
import { emailDelivery } from './auth-methods.ts'
import { serverEnv } from './instance-env.ts'
import { type LivekitStatus, livekitStatus } from './livekit-status.ts'
import { type ProviderConfig, providerStatus, resolveProvider } from './provider-settings.ts'
import { SecretsKeyError } from './secrets.ts'

type Env = Record<string, string | undefined>
type TestResult = ProviderTestData & { at: string }

const results = new Map<ProviderName, TestResult & { keys: string }>()
/** A random key per process, so the fingerprint of the keys in memory cannot be checked against a guessed key. */
const hashKey = randomBytes(32)
/** Changes with any value in effect; kept only in memory, never sent or stored. */
const keysHash = (config: ProviderConfig) =>
  createHmac('sha256', hashKey)
    .update(JSON.stringify(Object.entries(config).map(([field, entry]) => [field, entry?.value ?? null])))
    .digest('hex')

/** Called with every provider test (provider.test), so the checklist knows what passed. */
export function rememberTest(
  provider: ProviderName,
  config: ProviderConfig,
  result: ProviderTestData,
  now = new Date(),
) {
  results.set(provider, { ...result, at: now.toISOString(), keys: keysHash(config) })
}

/** The last test of exactly these keys, or null. */
export function lastTest(provider: ProviderName, config: ProviderConfig): TestResult | null {
  const result = results.get(provider)
  if (!result || result.keys !== keysHash(config)) return null
  return { ok: result.ok, message: result.message, at: result.at }
}

/** provider.test asks a provider at most once in this window for the same keys; inside it, the last result is returned. */
export const TEST_COOLDOWN_MS = 10_000

/** The last test of exactly these keys when it is younger than the cooldown, else null. */
export function recentTest(provider: ProviderName, config: ProviderConfig, now = new Date()): ProviderTestData | null {
  const test = lastTest(provider, config)
  if (!test || now.getTime() - new Date(test.at).getTime() >= TEST_COOLDOWN_MS) return null
  return { ok: test.ok, message: test.message }
}

export const forgetTests = () => results.clear()

export const isSetUp = (provider: ProviderName, config: ProviderConfig) =>
  Object.entries(providerSpec(provider).fields).every(([field, spec]) => config[field] || spec.optional)

type Options = {
  env?: Env
  livekit?: () => Promise<LivekitStatus>
}

// The OpenAI test lists the models with the key: it proves the key, not a call round trip.
const keyOnlyChecks = new Set<ProviderName>(['openai_realtime', 'openai_stt', 'openai'])
const testMessage = (provider: ProviderName, message: string) =>
  keyOnlyChecks.has(provider) && message === 'Connected' ? 'Key accepted' : message

type ProviderItem = { spec: SetupItemSpec; provider: ProviderName | null; coveredBy: ProviderName | null }

async function providerItem(
  tx: Tx,
  { spec, provider, coveredBy }: ProviderItem,
  env: Env,
): Promise<SetupChecklistItem> {
  const base = { id: spec.id, label: spec.label, coveredBy, testedAt: null }
  if (!provider) return { ...base, state: 'missing', provider: null, providerLabel: null, message: null }
  const providerLabel = providerSpec(provider).label
  let config: ProviderConfig
  try {
    config = await resolveProvider(tx, provider, env)
  } catch (e) {
    if (!(e instanceof SecretsKeyError)) throw e
    return { ...base, state: 'failing', provider, providerLabel, message: e.message }
  }
  const setUp = isSetUp(provider, config)
  const test = setUp ? lastTest(provider, config) : null
  const state = setupItemState(setUp, test)
  const tested = test ? testMessage(provider, test.message) : null
  const message = coveredBy
    ? `Covered by ${providerLabel}${tested ? `: ${tested}` : ''}. Separate providers again: Disconnect in the ${providerLabel} dialog`
    : state === 'missing'
      ? `${providerLabel} is picked but not all its keys are set`
      : (tested ?? 'Keys set, not tested yet')
  return { ...base, state, provider, providerLabel, message, testedAt: test?.at ?? null }
}

/** LiveKit is part of the install: reachable server, and an inbound SIP trunk so carriers' calls arrive. */
function livekitItem(spec: SetupItemSpec, status: LivekitStatus): SetupChecklistItem {
  const base = { id: spec.id, label: spec.label, provider: null, providerLabel: null, coveredBy: null }
  const testedAt = new Date().toISOString()
  if (!status.url) return { ...base, state: 'missing', message: status.server.message, testedAt: null }
  if (!status.server.ok) return { ...base, state: 'failing', message: status.server.message, testedAt }
  // The server answers: browser test calls work. Phone calls need the trunk, made once a number exists.
  if (!status.sip.ok) return { ...base, state: 'set_up', message: status.sip.message, testedAt }
  return { ...base, state: 'ok', message: `${status.server.message}; ${status.sip.message}`, testedAt }
}

type StatusRows = Awaited<ReturnType<typeof providerStatus>>['providers']
/** The label of a carrier with all its needed keys set, in the app or in env. */
const carrierWithKeys = (providers: StatusRows) =>
  providers.find(
    p =>
      p.category === 'telephony' && p.fields.every(f => f.source || providerSpec(p.provider).fields[f.field]?.optional),
  )?.label

/** The dev carrier's line; a carrier whose keys are set (in the app or in env) waits for TELEPHONY_PROVIDER to change. */
function devCarrierMessage(withKeys: string | undefined) {
  const base = 'Development carrier (TELEPHONY_PROVIDER=dev): numbers and calls are simulated'
  return withKeys ? `${base}. ${withKeys} keys are set: remove TELEPHONY_PROVIDER=dev to use them` : base
}

export async function setupChecklist(tx: Tx, options: Options = {}): Promise<SetupChecklist> {
  const env = options.env ?? serverEnv()
  const { active, providers } = await providerStatus(tx, env)
  // A realtime model that is connected answers calls instead of speech, model and voice.
  const realtime = active.realtime.provider
  let realtimeReady = false
  if (realtime) {
    try {
      realtimeReady = isSetUp(realtime, await resolveProvider(tx, realtime, env))
    } catch (e) {
      if (!(e instanceof SecretsKeyError)) throw e
      realtimeReady = false
    }
  }
  const livekit = (options.livekit ?? (() => livekitStatus()))()
  const items = await Promise.all(
    setupItems.map(async spec => {
      if (!spec.category) return livekitItem(spec, await livekit)
      const covered = realtimeReady && (spec.id === 'stt' || spec.id === 'llm' || spec.id === 'tts')
      const provider = covered ? realtime : active[spec.category].provider
      const item = await providerItem(tx, { spec, provider, coveredBy: covered ? realtime : null }, env)
      if (spec.id === 'email' && item.state === 'missing' && emailDelivery(env) === 'log')
        return { ...item, message: 'Sign-in codes go to the API log (EMAIL_TO_LOG): for development only' }
      // TELEPHONY_PROVIDER=dev is a working carrier for development: numbers and calls are simulated. Not missing.
      if (spec.id === 'telephony' && !provider && env.TELEPHONY_PROVIDER === 'dev')
        return { ...item, state: 'ok' as const, message: devCarrierMessage(carrierWithKeys(providers)) }
      return item
    }),
  )
  return { items, ...checklistSummary(items) }
}
