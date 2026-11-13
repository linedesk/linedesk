// The instance setup checklist (docs/architecture.md §12): per part a first answered call needs (email, phone
// carrier, speech, model, voice, LiveKit and SIP) whether it is set up and whether the last test of exactly these
// keys passed. GET /v1/admin/setup-checklist, the install walkthrough, the setup MCP's setup_status and
// `scripts/setup.sh --check` (setup-check.ts) all read it, so "Works" means the same everywhere.
//
// Test results are stored per provider (provider_tests, LIN-141) with a fingerprint of the keys in effect, an HMAC keyed
// with SECRETS_KEY: a changed key is untested again, a restart or update forgets nothing, and nothing about a key is
// stored. Any test counts, whoever ran it (an admin, the setup agent, the check a setup page runs when it opens).
// Reading the checklist never calls a provider.
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
import { provider_tests, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { emailDelivery } from './auth-methods.ts'
import { serverEnv } from './instance-env.ts'
import { type LivekitStatus, livekitStatus } from './livekit-status.ts'
import { type ProviderConfig, providerStatus, resolveProvider } from './provider-settings.ts'
import { hasSecretsKey, SecretsKeyError, signWithSecretsKey } from './secrets.ts'

type Env = Record<string, string | undefined>
type TestResult = ProviderTestData & { at: string }

/** Without SECRETS_KEY no key can be stored in the app; env keys then get a fingerprint for this process only. */
const processKey = randomBytes(32)
/** Changes with any value in effect; never sent, and it says nothing about a key without SECRETS_KEY. */
function keysHash(config: ProviderConfig) {
  const values = JSON.stringify(Object.entries(config).map(([field, entry]) => [field, entry?.value ?? null]))
  return hasSecretsKey()
    ? signWithSecretsKey('provider-test', values)
    : createHmac('sha256', processKey).update(values).digest('hex')
}

/** Called with every provider test (provider.test, the walkthrough's round trips), so every setup screen knows what passed. */
export async function rememberTest(
  tx: Tx,
  provider: ProviderName,
  config: ProviderConfig,
  result: ProviderTestData,
  now = new Date(),
) {
  const row = { keys: keysHash(config), ok: result.ok, message: result.message, tested_at: now.toISOString() }
  await tx
    .insert(provider_tests)
    .values({ provider, ...row })
    .onConflictDoUpdate({ target: provider_tests.provider, set: row })
}

/** The last test of exactly these keys, or null. */
export async function lastTest(tx: Tx, provider: ProviderName, config: ProviderConfig): Promise<TestResult | null> {
  const [row] = await tx.select().from(provider_tests).where(eq(provider_tests.provider, provider))
  if (!row || row.keys !== keysHash(config)) return null
  return { ok: row.ok, message: row.message, at: new Date(row.tested_at).toISOString() }
}

/** provider.test asks a provider at most once in this window for the same keys; inside it, the last result is returned. */
export const TEST_COOLDOWN_MS = 10_000

/** The last test of exactly these keys when it is younger than the cooldown, else null. */
export async function recentTest(
  tx: Tx,
  provider: ProviderName,
  config: ProviderConfig,
  now = new Date(),
): Promise<ProviderTestData | null> {
  const test = await lastTest(tx, provider, config)
  if (!test || now.getTime() - new Date(test.at).getTime() >= TEST_COOLDOWN_MS) return null
  return { ok: test.ok, message: test.message }
}

/** Forgets every stored result (tests: past the cooldown, or a clean start). */
export const forgetTests = async (tx: Tx) => {
  await tx.delete(provider_tests)
}

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
  const test = setUp ? await lastTest(tx, provider, config) : null
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
