// Provider keys: the value stored in the admin area wins, the environment variable is the fallback.
// Read on every use, so a change in the admin area applies without a restart.
import {
  categoryEnv,
  categoryNames,
  providerNames,
  providerSpec,
  providersIn,
  type ProviderCategory,
  type ProviderName,
} from '@callfront/actions'
import { instance_settings, provider_settings, type Tx, user } from '@callfront/db'
import { telephonyProviderFromEnv, type TelephonyProvider } from '@callfront/telephony'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { decryptSecret, encryptSecret, hasSecretsKey } from './secrets.ts'

type Env = Record<string, string | undefined>
export type Source = 'app' | 'env'
export type ProviderConfig = Record<string, { value: string; source: Source } | undefined>

const slot = (provider: string, field: string) => `${provider}.${field}`
const newId = () => `ps_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
/** Shown next to a stored secret. Short values show nothing: four characters would be most of them. */
const lastFour = (value: string) => (value.length >= 12 ? value.slice(-4) : null)

/** The rows of the whole install (workspace_id is null). */
const instanceRows = (tx: Tx, provider?: ProviderName) =>
  tx
    .select()
    .from(provider_settings)
    .where(and(isNull(provider_settings.workspace_id), provider ? eq(provider_settings.provider, provider) : undefined))

/** The config in effect for a provider. Throws SecretsKeyError when a stored value cannot be decrypted. */
export async function resolveProvider(tx: Tx, provider: ProviderName, env: Env = process.env): Promise<ProviderConfig> {
  const stored = new Map((await instanceRows(tx, provider)).map(row => [row.field, row]))
  return Object.fromEntries(
    Object.entries(providerSpec(provider).fields).map(([field, spec]) => {
      const row = stored.get(field)
      if (row)
        return [field, { value: decryptSecret(row.value_encrypted, slot(provider, field)), source: 'app' as const }]
      const fromEnv = env[spec.env]
      return [field, fromEnv ? { value: fromEnv, source: 'env' as const } : undefined]
    }),
  )
}

const activeKey = (category: ProviderCategory) => `active_provider.${category}`
const isProvider = (name: string | undefined): name is ProviderName =>
  !!name && (providerNames as string[]).includes(name)
const isOptional = (provider: ProviderName, field: string) => !!providerSpec(provider).fields[field]?.optional

/** The provider an instance admin chose for a category, or null. */
async function chosenProvider(tx: Tx, category: ProviderCategory): Promise<ProviderName | null> {
  const [row] = await tx
    .select()
    .from(instance_settings)
    .where(eq(instance_settings.key, activeKey(category)))
  return isProvider(row?.value) && providerSpec(row.value).category === category ? row.value : null
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
  const name = env[categoryEnv[category]]
  return isProvider(name) && providerSpec(name).category === category ? name : null
}

/**
 * The provider a category uses and its config: the one picked in the admin area,
 * else the one its variable names, else the first in the registry with every needed field. null
 * when there is none, or when the picked or named one is not set up yet (no silent switch).
 */
export async function activeProvider(tx: Tx, category: ProviderCategory, env: Env = process.env) {
  const named = (await chosenProvider(tx, category)) ?? providerFromEnv(category, env)
  for (const provider of named ? [named] : providersIn(category)) {
    const config = await resolveProvider(tx, provider, env)
    if (Object.keys(providerSpec(provider).fields).every(field => config[field] || isOptional(provider, field))) {
      return { provider, config }
    }
  }
  return null
}

/**
 * The telephony provider in effect: the one picked in the admin area, else TELEPHONY_PROVIDER
 * (`dev` means no carrier), else the first one in the registry that is set up (Telnyx before
 * Twilio), else dev. Keys come from the app first, then env; `packages/telephony` gets them as variables.
 */
export async function telephonyProvider(tx: Tx, env: Env = process.env): Promise<TelephonyProvider> {
  const named = (await chosenProvider(tx, 'telephony')) ?? (env.TELEPHONY_PROVIDER || null)
  // `dev` or a name the registry does not know: the telephony package decides (dev, or a clear error).
  if (named && !isProvider(named)) return telephonyProviderFromEnv({ TELEPHONY_PROVIDER: named })
  const provider = named && isProvider(named) ? named : null
  const active = provider
    ? { provider, config: await resolveProvider(tx, provider, env) }
    : await activeProvider(tx, 'telephony', env)
  if (!active) return telephonyProviderFromEnv({ TELEPHONY_PROVIDER: 'dev' })
  const asEnv = Object.entries(providerSpec(active.provider).fields).map(([field, spec]) => [
    spec.env,
    active.config[field]?.value,
  ])
  return telephonyProviderFromEnv({ TELEPHONY_PROVIDER: active.provider, ...Object.fromEntries(asEnv) })
}

const voiceCategories = ['stt', 'llm', 'tts'] as const satisfies readonly ProviderCategory[]
type VoiceEntry = { provider: ProviderName } & Record<string, string | null>
export type VoiceProviderConfig = Record<(typeof voiceCategories)[number], VoiceEntry | null>

/**
 * What the voice agent needs for a call: per category the active provider with its values in
 * clear, or null when none is set up. Only ever sent to the agent token.
 */
export async function voiceProviderConfig(tx: Tx): Promise<VoiceProviderConfig> {
  const config = {} as VoiceProviderConfig
  for (const category of voiceCategories) {
    const active = await activeProvider(tx, category)
    config[category] = active && {
      provider: active.provider,
      ...Object.fromEntries(
        Object.keys(providerSpec(active.provider).fields).map(field => [field, active.config[field]?.value ?? null]),
      ),
    }
  }
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
export async function providerStatus(tx: Tx, env: Env = process.env) {
  const rows = await instanceRows(tx)
  const editorIds = [...new Set(rows.map(row => row.updated_by).filter(id => id !== null))]
  const editors = editorIds.length
    ? await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, editorIds))
    : []
  const status = (provider: ProviderName): ProviderStatus => ({
    provider,
    label: providerSpec(provider).label,
    category: providerSpec(provider).category,
    fields: Object.entries(providerSpec(provider).fields).map(([field, spec]) => {
      const row = rows.find(r => r.provider === provider && r.field === field)
      const fromEnv = env[spec.env]
      const base = { field, label: spec.label, secret: spec.secret }
      if (row) {
        return {
          ...base,
          source: 'app',
          last4: spec.secret ? row.last4 : null,
          value: spec.secret ? null : decryptForDisplay(row.value_encrypted, slot(provider, field)),
          updated_at: new Date(row.updated_at).toISOString(),
          updated_by: editors.find(editor => editor.id === row.updated_by) ?? null,
        }
      }
      return {
        ...base,
        source: fromEnv ? 'env' : null,
        last4: null,
        value: !spec.secret && fromEnv ? fromEnv : null,
        updated_at: null,
        updated_by: null,
      }
    }),
  })
  const providers = providerNames.map(status)
  // Works without decrypting, so a wrong SECRETS_KEY does not break the page that explains it.
  const isSetUp = (p: ProviderStatus) => p.fields.every(f => f.source || isOptional(p.provider, f.field))
  const active = {} as ActiveStatus
  for (const category of categoryNames) {
    const chosen = await chosenProvider(tx, category)
    // TELEPHONY_PROVIDER=dev means no carrier, even when a carrier is set up.
    const noCarrier = category === 'telephony' && env.TELEPHONY_PROVIDER === 'dev'
    const firstSetUp = providers.find(p => p.category === category && isSetUp(p))?.provider ?? null
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

export const clearProviderKeys = (tx: Tx, provider: ProviderName) =>
  tx
    .delete(provider_settings)
    .where(and(isNull(provider_settings.workspace_id), eq(provider_settings.provider, provider)))
