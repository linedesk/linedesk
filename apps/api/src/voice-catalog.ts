// Settings › Assistant › Voice › More voices: every voice of every text-to-speech provider that has a
// key, read with the install's key on the server (the key never reaches the browser) and kept a few
// minutes per provider. A workspace sees the provider's voices and its own clones, never another
// workspace's clones or a clone the account made outside Linedesk (no consent record for it).
// Voice Library and designed voices the account added are listed.
import { createHash } from 'node:crypto'
import {
  type CatalogProvider,
  type CatalogVoice,
  type ProviderName,
  providerSpec,
  providersIn,
  type VoiceCatalogData,
} from '@linedesk/actions'
import { type Tx, voice_clones } from '@linedesk/db'
import { activeProvider, setUpProviders } from './provider-settings.ts'
import { createVoiceProvider, type ProviderVoice, type VoiceProvider } from './voice-provider.ts'

/** How long a provider's list is reused; a failure is retried sooner. */
export const CATALOG_TTL_MS = 5 * 60 * 1000
const FAILURE_TTL_MS = 30 * 1000

type Listed = { at: number; voices?: ProviderVoice[]; error?: string; pending?: Promise<ProviderVoice[]> }

/** The lists per provider and key (a new key reads again). Per API process. */
export function catalogCache(now = Date.now) {
  const lists = new Map<string, Listed>()
  return {
    async voicesOf(adapter: VoiceProvider, apiKey: string): Promise<ProviderVoice[]> {
      const key = `${adapter.name}:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`
      const hit = lists.get(key)
      if (hit?.pending) return hit.pending
      if (hit?.voices && now() - hit.at < CATALOG_TTL_MS) return hit.voices
      if (hit?.error && now() - hit.at < FAILURE_TTL_MS) throw new Error(hit.error)
      const pending = adapter.listVoices()
      lists.set(key, { at: now(), pending })
      try {
        const voices = await pending
        lists.set(key, { at: now(), voices })
        return voices
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        lists.set(key, { at: now(), error })
        throw new Error(error)
      }
    },
  }
}

const defaultCache = catalogCache()

export type CatalogEntry = ProviderVoice & { provider: ProviderName }

type CatalogOptions = { cache?: ReturnType<typeof catalogCache>; doFetch?: typeof fetch }

/** Every clone ever made through Linedesk, of every workspace (released ones too). */
const allClones = (tx: Tx) =>
  tx
    .select({
      provider: voice_clones.provider,
      voice_id: voice_clones.voice_id,
      workspace_id: voice_clones.workspace_id,
      deleted_at: voice_clones.deleted_at,
    })
    .from(voice_clones)

/**
 * The voices of every provider with a key that this workspace may use, with each provider's state.
 * Without other workspaces' clones (live or released) and without custom voices of the account that
 * are clones Linedesk did not make for this workspace.
 */
export async function voiceCatalog(tx: Tx, workspaceId: string, options: CatalogOptions = {}) {
  const cache = options.cache ?? defaultCache
  const active = (await activeProvider(tx, 'tts').catch(() => null))?.provider ?? null
  const clones = await allClones(tx)
  const providers: CatalogProvider[] = []
  const voices: CatalogEntry[] = []
  const setUp = await setUpProviders(tx, 'tts').catch(() => [])
  for (const provider of providersIn('tts')) {
    const label = providerSpec(provider).label
    const config = setUp.find(p => p.provider === provider)?.config
    const apiKey = config?.api_key?.value
    const adapter =
      apiKey && createVoiceProvider(provider, { api_key: apiKey, model: config?.model?.value }, options.doFetch)
    const state = { provider, label, active: provider === active }
    if (!adapter || !apiKey) {
      providers.push({ ...state, configured: false, error: null })
      continue
    }
    try {
      const listed = await cache.voicesOf(adapter, apiKey)
      const ofProvider = clones.filter(c => c.provider === provider)
      const own = new Set(ofProvider.filter(c => c.workspace_id === workspaceId && !c.deleted_at).map(c => c.voice_id))
      const others = new Set(ofProvider.filter(c => !own.has(c.voice_id)).map(c => c.voice_id))
      for (const voice of listed) {
        if (others.has(voice.id) || (voice.clone && !own.has(voice.id))) continue
        voices.push({ ...voice, provider })
      }
      providers.push({ ...state, configured: true, error: null })
    } catch (e) {
      providers.push({
        ...state,
        configured: true,
        error: `${label}: the voice list could not be read. Try again in a minute.`,
      })
      console.warn(`voice catalog: ${provider}: ${e instanceof Error ? e.message : e}`)
    }
  }
  return { providers, voices }
}

/** The catalog as the browser gets it: no preview URLs (samples go through the API). */
export const catalogData = ({ providers, voices }: Awaited<ReturnType<typeof voiceCatalog>>): VoiceCatalogData => ({
  providers,
  voices: voices.map(
    (v): CatalogVoice => ({
      provider: v.provider,
      id: v.id,
      name: v.name,
      description: v.description,
      language: v.language,
      gender: v.gender,
      accent: v.accent,
    }),
  ),
})

/** The voice in this workspace's catalog, or null (not listed, provider without a key, list not readable). */
export async function catalogVoice(
  tx: Tx,
  workspaceId: string,
  provider: string,
  voiceId: string,
  options: CatalogOptions = {},
): Promise<CatalogEntry | null> {
  const { voices } = await voiceCatalog(tx, workspaceId, options)
  return voices.find(v => v.provider === provider && v.id === voiceId) ?? null
}
