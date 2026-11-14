// Providers in one place (docs/architecture.md §12, LIN-158): what the server knows about each provider (set up, in
// use, the last test of exactly these keys, recorded failures) turned into one status per group by statusGroups
// (packages/actions/src/provider-status.ts). GET /v1/admin/setup-checklist, the setup MCP's setup_status and
// `scripts/setup.sh --check` (setup-check.ts) read it; the web app computes the same from the admin data, so "Works"
// means the same everywhere.
//
// Test results are stored per provider (provider_tests, LIN-141) with a fingerprint of the keys in effect, an HMAC keyed
// with SECRETS_KEY: a changed key is untested again, a restart or update forgets nothing, and nothing about a key is
// stored. Any test counts, whoever ran it (an admin, the setup agent, the check a setup page runs when it opens).
// Reading the checklist never calls a provider.
import { createHmac, randomBytes } from 'node:crypto'
import {
  isMultiCategory,
  type ProviderFact,
  type ProviderName,
  type ProviderTestData,
  providerNames,
  providerSpec,
  type StatusGroups,
  type StoredTest,
  statusGroups,
  type VoicePipeline,
} from '@linedesk/actions'
import { assistants, provider_settings, provider_tests, type Tx } from '@linedesk/db'
import { eq, isNull, max } from 'drizzle-orm'
import { emailDelivery } from './auth-methods.ts'
import { serverEnv } from './instance-env.ts'
import { type LivekitStatus, livekitStatus } from './livekit-status.ts'
import { listProviderFailures } from './provider-failures.ts'
import { type ProviderConfig, providerStatus, resolveProvider } from './provider-settings.ts'
import { hasSecretsKey, SecretsKeyError, signWithSecretsKey } from './secrets.ts'

type Env = Record<string, string | undefined>

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
export async function lastTest(tx: Tx, provider: ProviderName, config: ProviderConfig): Promise<StoredTest | null> {
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

/**
 * Every provider as the status function needs it: set up (all needed keys in the app or the server's env), in use,
 * and the last test of exactly these keys. Stored keys that cannot be read (SECRETS_KEY missing or changed) count as
 * set up and failing, with the reason. Never calls a provider.
 */
export async function providerFacts(tx: Tx, env: Env = serverEnv()): Promise<ProviderFact[]> {
  const { active } = await providerStatus(tx, env)
  const saved = await tx
    .select({ provider: provider_settings.provider, at: max(provider_settings.updated_at) })
    .from(provider_settings)
    .where(isNull(provider_settings.workspace_id))
    .groupBy(provider_settings.provider)
  const keysAt = (p: ProviderName) => {
    const at = saved.find(r => r.provider === p)?.at
    return at ? new Date(at).toISOString() : null
  }
  const facts: ProviderFact[] = []
  for (const provider of providerNames) {
    const { category } = providerSpec(provider)
    let config: ProviderConfig
    try {
      config = await resolveProvider(tx, provider, env)
    } catch (e) {
      if (!(e instanceof SecretsKeyError)) throw e
      facts.push({
        provider,
        configured: true,
        active: active[category].provider === provider,
        test: { ok: false, message: e.message, at: new Date().toISOString() },
      })
      continue
    }
    const configured = isSetUp(provider, config)
    facts.push({
      provider,
      configured,
      active: isMultiCategory(category) ? configured : active[category].provider === provider,
      test: configured ? await lastTest(tx, provider, config) : null,
      keysAt: keysAt(provider),
    })
  }
  return facts
}

/** The last test of every provider that is set up (GET /v1/admin/providers `tests`), so every screen starts from it. */
export async function storedTests(tx: Tx, env: Env = serverEnv()) {
  const tests: Partial<Record<ProviderName, StoredTest>> = {}
  for (const fact of await providerFacts(tx, env))
    if (fact.test && fact.test !== 'running') tests[fact.provider] = fact.test
  return tests
}

/** The dev carrier's line; a carrier whose keys are set (in the app or in env) waits for TELEPHONY_PROVIDER to change. */
function devCarrierMessage(facts: readonly ProviderFact[]) {
  const base = 'Development carrier (TELEPHONY_PROVIDER=dev): numbers and calls are simulated'
  const withKeys = facts.find(f => f.configured && providerSpec(f.provider).category === 'telephony')
  return withKeys
    ? `${base}. ${providerSpec(withKeys.provider).label} keys are set: remove TELEPHONY_PROVIDER=dev to use them`
    : base
}

/** Each assistant's choice of how its calls are answered (null: the install default), across the install. */
async function assistantPipelines(tx: Tx): Promise<(VoicePipeline | null)[]> {
  const rows = await tx.selectDistinct({ pipeline: assistants.voice_pipeline }).from(assistants)
  return rows.map(r => r.pipeline)
}

/**
 * What else the status needs besides the providers (GET /v1/admin/providers `status`, so the web app computes the same):
 * how each assistant answers, whether email codes go to the log, and the development carrier's line.
 */
export async function statusContext(tx: Tx, env: Env = serverEnv(), facts?: readonly ProviderFact[]) {
  const providers = facts ?? (await providerFacts(tx, env))
  const telephonyInUse = providers.some(
    f => f.active && f.configured && providerSpec(f.provider).category === 'telephony',
  )
  return {
    assistantPipelines: await assistantPipelines(tx),
    emailToLog: emailDelivery(env) === 'log',
    devCarrier: !telephonyInUse && env.TELEPHONY_PROVIDER === 'dev' ? devCarrierMessage(providers) : null,
  }
}

/** Every group's status, as Admin › Providers shows it. Asks LiveKit (cheap), never a paid provider. */
export async function setupChecklist(tx: Tx, options: Options = {}): Promise<StatusGroups> {
  const env = options.env ?? serverEnv()
  const livekit = (options.livekit ?? (() => livekitStatus()))()
  const providers = await providerFacts(tx, env)
  const audio = await livekit
  return statusGroups({
    providers,
    failures: await listProviderFailures(tx),
    callAudio: { configured: !!audio.url, server: audio.server, sip: audio.sip },
    ...(await statusContext(tx, env, providers)),
  })
}
