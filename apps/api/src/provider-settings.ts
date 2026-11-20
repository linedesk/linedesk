// Provider keys: the value stored in the admin area wins, the environment variable is the fallback (never for
// billing keys: moneyCategories).
// Read on every use, so a change in the admin area applies without a restart.
import {
  categoryEnv,
  anyModeLanguages,
  heardLanguages,
  type HearingModel,
  pickableLanguages,
  categoryNames,
  moneyCategories,
  type Language,
  levelSttModel,
  levelVoiceModel,
  providerFieldLabel,
  providerNames,
  providerSpec,
  providersIn,
  type PipelinesSetUp,
  type ProviderCategory,
  type ProviderName,
  spokenLanguages,
} from '@linedesk/actions'
import { instance_settings, provider_settings, type Tx, user } from '@linedesk/db'
import { telephonyProviderFromEnv, type TelephonyProvider } from '@linedesk/telephony'
import { and, eq, inArray, isNull, like } from 'drizzle-orm'
import { callQualitySettings } from './call-quality.ts'
import { serverEnv } from './instance-env.ts'
import { decryptSecret, encryptSecret, hasSecretsKey } from './secrets.ts'

type Env = Record<string, string | undefined>
export type Source = 'app' | 'env'
export type ProviderConfig = Record<string, { value: string; source: Source } | undefined>

/** The slot (secrets.ts) of an install-wide provider value. */
export const providerSlot = (provider: string, field: string) => `${provider}.${field}`
const slot = providerSlot
const newId = () => `ps_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
/** Shown next to a stored secret. Short values show nothing: four characters would be most of them. */
const lastFour = (value: string) => (value.length >= 12 ? value.slice(-4) : null)

/** The rows of the whole install (workspace_id is null). */
const instanceRows = (tx: Tx, provider?: ProviderName) =>
  tx
    .select()
    .from(provider_settings)
    .where(and(isNull(provider_settings.workspace_id), provider ? eq(provider_settings.provider, provider) : undefined))

/**
 * A provider can use another provider's stored API key instead of its own (one-key mode: OpenAI transcription and
 * language model use the realtime model's key). A reference, not a copy: the key lives once, so removing it
 * (Disconnect) ends every use of it. Kept in instance_settings as `key_from.<provider>` = the provider it reads.
 */
const KEY_FIELD = 'api_key'
const keyFromSetting = (provider: ProviderName) => `key_from.${provider}`

/** `from` when `provider` may use its stored API key, else null. */
const validSource = (provider: ProviderName, from: string | undefined): ProviderName | null =>
  isProvider(from) && from !== provider && KEY_FIELD in providerSpec(from).fields ? from : null

/** The provider whose stored API key this one uses, or null. */
export async function keySource(tx: Tx, provider: ProviderName): Promise<ProviderName | null> {
  const [row] = await tx
    .select()
    .from(instance_settings)
    .where(eq(instance_settings.key, keyFromSetting(provider)))
  return validSource(provider, row?.value)
}

/** keySource of every provider, in one query: the providers that use another one's stored API key. */
export async function keySources(tx: Tx): Promise<Map<ProviderName, ProviderName>> {
  const rows = await tx.select().from(instance_settings).where(like(instance_settings.key, 'key_from.%'))
  const links = new Map<ProviderName, ProviderName>()
  for (const name of providerNames) {
    const from = validSource(name, rows.find(row => row.key === keyFromSetting(name))?.value)
    if (from) links.set(name, from)
  }
  return links
}

/** `provider` uses `from`'s stored API key from now on (its own stored key is removed). */
export async function linkProviderKey(
  tx: Tx,
  provider: ProviderName,
  from: ProviderName,
  actorId: string,
  now: string,
) {
  await tx
    .delete(provider_settings)
    .where(
      and(
        isNull(provider_settings.workspace_id),
        eq(provider_settings.provider, provider),
        eq(provider_settings.field, KEY_FIELD),
      ),
    )
  await tx.delete(instance_settings).where(eq(instance_settings.key, keyFromSetting(provider)))
  await tx
    .insert(instance_settings)
    .values({ key: keyFromSetting(provider), value: from, updated_at: now, updated_by: actorId })
}

/** The providers that use `provider`'s stored API key. */
export async function keyUsers(tx: Tx, provider: ProviderName): Promise<ProviderName[]> {
  const rows = await tx.select().from(instance_settings).where(eq(instance_settings.value, provider))
  return rows.flatMap(row => {
    const name = row.key.startsWith('key_from.') ? row.key.slice('key_from.'.length) : ''
    return isProvider(name) ? [name] : []
  })
}

/** The config in effect for a provider. Throws SecretsKeyError when a stored value cannot be decrypted. */
export async function resolveProvider(tx: Tx, provider: ProviderName, env: Env = serverEnv()): Promise<ProviderConfig> {
  const own = await instanceRows(tx, provider)
  const from = await keySource(tx, provider)
  return configOf(provider, from ? [...own, ...(await instanceRows(tx, from))] : own, from, env)
}

/** Every stored install-wide value and every key link, in two queries: for resolving many providers (configOf). */
export async function storedProviderValues(tx: Tx) {
  const [rows, links] = await Promise.all([instanceRows(tx), keySources(tx)])
  return { rows, links }
}

type StoredRow = Awaited<ReturnType<typeof instanceRows>>[number]

/**
 * The config in effect for a provider from its stored rows (and those of the provider whose API key it uses, `from`).
 * Throws SecretsKeyError when a stored value cannot be decrypted.
 */
export function configOf(
  provider: ProviderName,
  rows: readonly StoredRow[],
  from: ProviderName | null,
  env: Env = serverEnv(),
): ProviderConfig {
  const stored = new Map(rows.filter(row => row.provider === provider).map(row => [row.field, row]))
  const shared = from && rows.find(row => row.provider === from && row.field === KEY_FIELD)
  return Object.fromEntries(
    Object.entries(providerSpec(provider).fields).map(([field, spec]) => {
      const row = stored.get(field)
      if (row)
        return [field, { value: decryptSecret(row.value_encrypted, slot(provider, field)), source: 'app' as const }]
      if (field === KEY_FIELD && shared)
        return [field, { value: decryptSecret(shared.value_encrypted, slot(from, KEY_FIELD)), source: 'app' as const }]
      // Billing keys only from the store (security review of #850): an `.env` key would skip the live-key refusal,
      // the step-up and the change alert, and could not be removed in the app.
      const fromEnv = moneyCategories.includes(providerSpec(provider).category) ? undefined : env[spec.env]
      return [field, fromEnv ? { value: fromEnv, source: 'env' as const } : undefined]
    }),
  )
}

const activeKey = (category: ProviderCategory) => `active_provider.${category}`
const isProvider = (name: string | undefined): name is ProviderName =>
  !!name && (providerNames as string[]).includes(name)
const isOptional = (provider: ProviderName, field: string) => !!providerSpec(provider).fields[field]?.optional

const chosenFor = (category: ProviderCategory, value: string | undefined): ProviderName | null =>
  isProvider(value) && providerSpec(value).category === category ? value : null

/** The provider an instance admin chose for a category, or null. */
async function chosenProvider(tx: Tx, category: ProviderCategory): Promise<ProviderName | null> {
  const [row] = await tx
    .select()
    .from(instance_settings)
    .where(eq(instance_settings.key, activeKey(category)))
  return chosenFor(category, row?.value)
}

export async function setActiveProvider(
  tx: Tx,
  category: ProviderCategory,
  provider: ProviderName | null,
  actorId: string,
  now: string,
) {
  await tx.delete(instance_settings).where(eq(instance_settings.key, activeKey(category)))
  if (provider) {
    await tx
      .insert(instance_settings)
      .values({ key: activeKey(category), value: provider, updated_at: now, updated_by: actorId })
  }
}

/** The provider a category falls back to without a pick: the one its variable names (STT_PROVIDER, ...). */
function providerFromEnv(category: ProviderCategory, env: Env): ProviderName | null {
  const variable = categoryEnv[category]
  const name = variable && env[variable]
  return isProvider(name) && providerSpec(name).category === category ? name : null
}

/**
 * Whether a category without a pick uses the first provider that is set up. Not recording storage:
 * the local disk needs no settings, so it would always be "set up" and every install would record
 * calls without being asked to. Recording is on once a store is picked or RECORDING_STORE names one.
 * After-call transcription uploads recordings to the provider: on only once an instance admin picked one.
 */
const autoPicks = (category: ProviderCategory) => category !== 'recording' && category !== 'transcript'

/**
 * The provider a category uses and its config: the one picked in the admin area,
 * else the one its variable names, else the first in the registry with every needed field. null
 * when there is none, or when the picked or named one is not set up yet (no silent switch).
 */
export async function activeProvider(tx: Tx, category: ProviderCategory, env: Env = serverEnv()) {
  const named = (await chosenProvider(tx, category)) ?? providerFromEnv(category, env)
  for (const provider of named ? [named] : autoPicks(category) ? providersIn(category) : []) {
    const config = await resolveProvider(tx, provider, env)
    if (Object.keys(providerSpec(provider).fields).every(field => config[field] || isOptional(provider, field))) {
      return { provider, config }
    }
  }
  return null
}

/** Every provider of a category that has all its needed fields, with its config, in registry order. */
export async function setUpProviders(tx: Tx, category: ProviderCategory, env: Env = serverEnv()) {
  const ready: { provider: ProviderName; config: ProviderConfig }[] = []
  for (const provider of providersIn(category)) {
    const config = await resolveProvider(tx, provider, env)
    if (Object.keys(providerSpec(provider).fields).every(field => config[field] || isOptional(provider, field)))
      ready.push({ provider, config })
  }
  return ready
}

/**
 * The install's telephony provider and its config, chosen as telephonyProvider says; `named` is `dev` (or a name the
 * registry does not know) when no registry provider is in effect.
 */
export async function installTelephony(
  tx: Tx,
  env: Env = serverEnv(),
): Promise<{ named: string } | { provider: ProviderName; config: ProviderConfig }> {
  const named = (await chosenProvider(tx, 'telephony')) ?? (env.TELEPHONY_PROVIDER || null)
  if (named && !isProvider(named)) return { named }
  const provider = named && isProvider(named) ? named : null
  const active = provider
    ? { provider, config: await resolveProvider(tx, provider, env) }
    : await activeProvider(tx, 'telephony', env)
  return active ?? { named: 'dev' }
}

/**
 * The telephony provider in effect: the one picked in the admin area, else TELEPHONY_PROVIDER
 * (`dev` means no carrier), else the first one in the registry that is set up (Telnyx before
 * Twilio), else dev. Keys come from the app first, then env; `packages/telephony` gets them as variables.
 */
export async function telephonyProvider(tx: Tx, env: Env = serverEnv()): Promise<TelephonyProvider> {
  const active = await installTelephony(tx, env)
  // `dev` or a name the registry does not know: the telephony package decides (dev, or a clear error).
  if ('named' in active) return telephonyProviderFromEnv({ TELEPHONY_PROVIDER: active.named })
  const asEnv = Object.entries(providerSpec(active.provider).fields).map(([field, spec]) => [
    spec.env,
    active.config[field]?.value,
  ])
  return telephonyProviderFromEnv({ TELEPHONY_PROVIDER: active.provider, ...Object.fromEntries(asEnv) })
}

const voiceCategories = ['stt', 'llm', 'tts'] as const satisfies readonly ProviderCategory[]
/** What the agent gets: the voice stages, the realtime model when one answers calls, and where to record calls. */
const agentCategories = [...voiceCategories, 'realtime', 'recording'] as const satisfies readonly ProviderCategory[]
type VoiceEntry = { provider: ProviderName } & Record<string, string | null>
export type VoiceProviderConfig = Record<(typeof agentCategories)[number], VoiceEntry | null> & {
  /** Every voice provider with a key: an assistant may use a voice of another one than `tts`. */
  tts_providers: VoiceEntry[]
}

/** A provider's values for the agent; without its secret fields when `withSecrets` is false. */
const entryOf = (provider: ProviderName, config: ProviderConfig, withSecrets = true): VoiceEntry => ({
  provider,
  ...Object.fromEntries(
    Object.entries(providerSpec(provider).fields)
      .filter(([, spec]) => withSecrets || !spec.secret)
      .map(([field]) => [field, config[field]?.value ?? null]),
  ),
})

/**
 * The languages calls can be answered in on this install: those a voice provider set up speaks with the server's
 * Standard voice model for it (Server admin › Providers › Call quality; spokenLanguages; none set up: Flux's
 * languages). An assistant on another level or with its own voice model is checked against that (assistantVoiceOf).
 * Never throws.
 */
export async function installLanguages(tx: Tx, env: Env = serverEnv()): Promise<Language[]> {
  const voices = await setUpProviders(tx, 'tts', env).catch(() => [])
  const standard = (await callQualitySettings(tx).catch(() => null))?.models.standard.voice
  return spokenLanguages(
    voices.map(v => ({ provider: v.provider, model: levelVoiceModel(v.provider, 'standard', standard?.[v.provider]) })),
  )
}

/**
 * The speech recognition calls are answered with: the install's provider and its Standard model (Server admin ›
 * Providers › Call quality), as for the voices. None set up: null. Never throws.
 */
export async function installHearing(tx: Tx, env: Env = serverEnv()): Promise<HearingModel | null> {
  const stt = await activeProvider(tx, 'stt', env).catch(() => null)
  if (!stt) return null
  const standard = (await callQualitySettings(tx).catch(() => null))?.models.standard.stt
  return { provider: stt.provider, model: levelSttModel(stt.provider, standard) }
}

/**
 * voice.options' languages: those calls can be answered in that may be picked (not HIDDEN_LANGUAGES) and the speech
 * recognition hears (heardLanguages), what "any language" covers (anyModeLanguages), and the ones left out only because
 * the speech recognition does not hear them, with its name (LIN-656: AssemblyAI does not hear Polish and five more).
 */
export async function installLanguageOptions(tx: Tx, env: Env = serverEnv()) {
  const spoken = pickableLanguages(await installLanguages(tx, env))
  const hearing = await installHearing(tx, env)
  const languages = heardLanguages(spoken, hearing)
  const unheard = spoken.filter(code => !languages.includes(code))
  return {
    languages,
    anyLanguages: anyModeLanguages(languages, hearing),
    ...(unheard.length && hearing ? { unheardLanguages: unheard, sttLabel: providerSpec(hearing.provider as ProviderName).label } : {}),
  }
}

/** Whether a realtime model is connected: the install default for assistants that chose no pipeline. Never throws. */
export async function realtimeInUse(tx: Tx, env: Env = serverEnv()): Promise<boolean> {
  return (await activeProvider(tx, 'realtime', env).catch(() => null)) !== null
}

/** Which pipelines can answer calls: a realtime model, and speech, language model and voice. Never throws. */
export async function pipelinesSetUp(tx: Tx, env: Env = serverEnv()): Promise<PipelinesSetUp> {
  const set = async (category: ProviderCategory) => (await activeProvider(tx, category, env).catch(() => null)) !== null
  // One after the other: the queries share the transaction.
  let three_stage = true
  for (const category of voiceCategories) three_stage &&= await set(category)
  return { realtime: await set('realtime'), three_stage }
}

/**
 * Whether the server has what the voice agent needs to answer a call: LiveKit in env, and a realtime model or a
 * speech, language model and voice provider (an assistant whose choice is not set up uses the other). Says nothing
 * about whether the worker runs. Never throws.
 */
export async function voiceReady(tx: Tx, env: Env = serverEnv()): Promise<boolean> {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return false
  const setUp = await pipelinesSetUp(tx, env)
  return setUp.realtime || setUp.three_stage
}

/**
 * What the voice agent needs for a call: per category the active provider with its values in
 * clear, or null when none is set up (`recording`: null means not recorded, unless the agent's own
 * RECORDING_STORE says otherwise). Holds the speech and model keys: only ever sent to the agent
 * token. The recording store's secret fields (the S3 secret access key) are left out: the API
 * starts S3 recordings itself (`call.startRecording`, recording-egress.ts).
 */
export async function voiceProviderConfig(tx: Tx): Promise<VoiceProviderConfig> {
  const config = {} as VoiceProviderConfig
  for (const category of agentCategories) {
    const active = await activeProvider(tx, category)
    // The agent needs the speech and model keys; the S3 secret stays here (recording-egress.ts).
    config[category] = active && entryOf(active.provider, active.config, category !== 'recording')
  }
  config.tts_providers = (await setUpProviders(tx, 'tts')).map(p => entryOf(p.provider, p.config))
  return config
}

export type FieldStatus = {
  field: string
  label: string
  secret: boolean
  /** Where the value in effect comes from; null when it is not set anywhere. */
  source: Source | null
  /** Last four characters of a stored secret. Never set for values from the environment. */
  last4: string | null
  /** The value itself, only for fields that are not secret. */
  value: string | null
  updated_at: string | null
  updated_by: { id: string; name: string } | null
  /** The stored key in effect is another provider's (one-key mode); null for the provider's own or none. */
  key_from: ProviderName | null
}
export type ProviderStatus = {
  provider: ProviderName
  label: string
  category: ProviderCategory
  fields: FieldStatus[]
}
/** Per category: the provider in use (null: none set up) and whether an admin chose it. */
export type ActiveStatus = Record<ProviderCategory, { provider: ProviderName | null; chosen: boolean }>

function decryptForDisplay(stored: string, slotName: string): string | null {
  try {
    return decryptSecret(stored, slotName)
  } catch {
    return null // the row still shows as set; using it reports the key problem
  }
}

/** What the admin area shows: which source is in effect, never a secret. */
export async function providerStatus(tx: Tx, env: Env = serverEnv()) {
  const [rows, links, choices] = await Promise.all([
    instanceRows(tx),
    keySources(tx),
    tx.select().from(instance_settings).where(like(instance_settings.key, 'active_provider.%')),
  ])
  const editorIds = [...new Set(rows.map(row => row.updated_by).filter(id => id !== null))]
  const editors = editorIds.length
    ? await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, editorIds))
    : []
  const status = (provider: ProviderName): ProviderStatus => ({
    provider,
    label: providerSpec(provider).label,
    category: providerSpec(provider).category,
    fields: Object.entries(providerSpec(provider).fields).map(([field, spec]) => {
      const own = rows.find(r => r.provider === provider && r.field === field)
      const linkedFrom = !own && field === KEY_FIELD ? (links.get(provider) ?? null) : null
      const shared = linkedFrom ? rows.find(r => r.provider === linkedFrom && r.field === KEY_FIELD) : undefined
      const row = own ?? shared
      const fromEnv = env[spec.env]
      const base = {
        field,
        label: providerFieldLabel(provider, field),
        secret: spec.secret,
        hint: ('hint' in spec ? spec.hint : undefined) ?? null,
      }
      if (row) {
        return {
          ...base,
          source: 'app',
          last4: spec.secret ? row.last4 : null,
          value: spec.secret ? null : decryptForDisplay(row.value_encrypted, slot(row.provider as ProviderName, field)),
          updated_at: new Date(row.updated_at).toISOString(),
          updated_by: editors.find(editor => editor.id === row.updated_by) ?? null,
          key_from: shared ? linkedFrom : null,
        }
      }
      return {
        ...base,
        source: fromEnv ? 'env' : null,
        last4: null,
        value: !spec.secret && fromEnv ? fromEnv : null,
        updated_at: null,
        updated_by: null,
        key_from: null,
      }
    }),
  })
  const providers = providerNames.map(status)
  // Works without decrypting, so a wrong SECRETS_KEY does not break the page that explains it.
  const isSetUp = (p: ProviderStatus) => p.fields.every(f => f.source || isOptional(p.provider, f.field))
  const active = {} as ActiveStatus
  for (const category of categoryNames) {
    const chosen = chosenFor(category, choices.find(row => row.key === activeKey(category))?.value)
    // TELEPHONY_PROVIDER=dev means no carrier, even when a carrier is set up.
    const noCarrier = category === 'telephony' && env.TELEPHONY_PROVIDER === 'dev'
    const firstSetUp = autoPicks(category)
      ? (providers.find(p => p.category === category && isSetUp(p))?.provider ?? null)
      : null
    const fallback = noCarrier ? null : (providerFromEnv(category, env) ?? firstSetUp)
    active[category] = { provider: chosen ?? fallback, chosen: !!chosen }
  }
  return { can_store: hasSecretsKey(), active, providers }
}

/** Store the given fields of a provider; the others keep their value. Throws SecretsKeyError without SECRETS_KEY. */
export async function setProviderKeys(
  tx: Tx,
  provider: ProviderName,
  values: Record<string, string>,
  actorId: string,
  now: string,
) {
  // Its own key from now on: no longer the shared one.
  if (KEY_FIELD in values) await tx.delete(instance_settings).where(eq(instance_settings.key, keyFromSetting(provider)))
  for (const [field, value] of Object.entries(values)) {
    const secret = providerSpec(provider).fields[field]!.secret
    const row = {
      value_encrypted: encryptSecret(value, slot(provider, field)),
      last4: secret ? lastFour(value) : null,
      updated_at: now,
      updated_by: actorId,
    }
    await tx
      .delete(provider_settings)
      .where(
        and(
          isNull(provider_settings.workspace_id),
          eq(provider_settings.provider, provider),
          eq(provider_settings.field, field),
        ),
      )
    await tx.insert(provider_settings).values({ id: newId(), workspace_id: null, provider, field, ...row })
  }
}

/**
 * Removes a provider's stored keys and its use of another's key. The providers that used its key lose it too
 * (their reference is removed), so Disconnect leaves no copy working. Returns those providers.
 */
export async function clearProviderKeys(tx: Tx, provider: ProviderName): Promise<ProviderName[]> {
  const users = await keyUsers(tx, provider)
  await tx
    .delete(provider_settings)
    .where(and(isNull(provider_settings.workspace_id), eq(provider_settings.provider, provider)))
  await tx.delete(instance_settings).where(
    inArray(
      instance_settings.key,
      [provider, ...users].map(name => keyFromSetting(name)),
    ),
  )
  return users
}
