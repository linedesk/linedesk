// Voices for Settings › Assistant: which voices an assistant may use (curated ones and the
// workspace's own clones), cloning one (voice.clone: off until an instance admin turns it on), and
// GET /v1/voices/preview/<voiceId>, a short sample in that voice. The curated voices' samples ship with
// the app (assets/voice-previews), so they play without a provider key and cost nothing; any other
// sample is generated once per provider, model, voice, language and text and kept on disk. A sample is spoken in the
// assistant's main language (`?language=`), except where the provider hosts one of its own.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLONE_AUDIO_MAX_BYTES,
  CLONE_CONSENT_TEXT,
  cloningProviders,
  curatedVoices,
  isCuratedVoice,
  type Language,
  languageCodes,
  providerDefaultVoices,
  providerFailureText,
  pipelinesAllowed,
  providerSpec,
  type ProviderName,
  providersIn,
  type VoiceCloneData,
  type VoiceCloningData,
  type VoiceOptionsData,
  type VoicePipelinePolicy,
  type VoicePipelinePolicyData,
  voiceId as voiceIdSchema,
} from '@linedesk/actions'
import { assistants, instance_settings, type Tx, voice_clones } from '@linedesk/db'
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm'
import { assistantIn } from './assistants.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { type Handler, type Preparer, Reject } from './handler-context.ts'
import { queueVoiceDeletion } from './jobs.ts'
import { problemOfStatus } from './provider-errors.ts'
import { audienceOf, noteProviderFailure, noteProviderOk } from './provider-failures.ts'
import {
  activeProvider,
  pipelinesSetUp,
  resolveProvider,
  setVoicePipelinePolicy,
  voicePipelinePolicy,
} from './provider-settings.ts'
import { type CatalogEntry, catalogData, catalogVoice, voiceCatalog } from './voice-catalog.ts'
import {
  createVoiceProvider,
  ELEVENLABS_SAMPLE_HOST,
  type VoiceProvider,
  VoiceProviderError,
} from './voice-provider.ts'

/**
 * What a preview says, per language: the same short greeting in each. Changing one makes new samples (the text is part
 * of the cache key); the bundled English ones in assets/voice-previews say the English one and have to be made again.
 */
export const PREVIEW_TEXTS: Record<Language, string> = {
  en: 'Hi, thanks for calling. This is how I sound on the phone. How can I help you today?',
  es: 'Hola, gracias por llamar. Así sueno por teléfono. ¿En qué puedo ayudarle hoy?',
  fr: "Bonjour, merci de votre appel. Voici ma voix au téléphone. Comment puis-je vous aider aujourd'hui ?",
  de: 'Hallo, danke für Ihren Anruf. So klinge ich am Telefon. Wie kann ich Ihnen heute helfen?',
  it: 'Salve, grazie per aver chiamato. Ecco come suono al telefono. Come posso aiutarla oggi?',
  pt: 'Olá, agradecemos a sua ligação. É assim que eu soo ao telefone. Como posso ajudar hoje?',
  nl: 'Hallo, bedankt voor het bellen. Zo klink ik aan de telefoon. Waarmee kan ik u vandaag helpen?',
  ru: 'Здравствуйте, спасибо за звонок. Вот так я звучу по телефону. Чем могу помочь сегодня?',
  hi: 'नमस्ते, कॉल करने के लिए धन्यवाद। फ़ोन पर मेरी आवाज़ ऐसी सुनाई देती है। आज मैं आपकी क्या मदद करूँ?',
  ja: 'お電話ありがとうございます。電話ではこのような声でお話しします。本日はどのようなご用件でしょうか？',
}
/** The English preview: what the bundled samples say, and what the install's speech test listens for. */
export const PREVIEW_TEXT = PREVIEW_TEXTS.en
/** A `?language=` of the preview route: a supported language, else null. */
export const previewLanguage = (value: string | undefined): Language | null =>
  languageCodes.find(code => code === value) ?? null
/** New samples a workspace may have made per hour (each is a paid request); cached ones are free. */
export const PREVIEWS_PER_HOUR = 20
/** The preview cache keeps at most this many samples; the oldest go first. */
export const PREVIEW_CACHE_MAX_FILES = 300

const CLONING_KEY = 'voice_cloning'
const newId = () => `vc_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/** Whether workspaces may clone voices: an instance admin turned it on. Off by default. */
export async function cloningOn(tx: Tx): Promise<boolean> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, CLONING_KEY))
  return row?.value === 'on'
}

/** The text-to-speech provider in effect with its key, or null when none is set up. */
export async function voiceProviderInUse(tx: Tx, doFetch: typeof fetch = fetch): Promise<VoiceProvider | null> {
  const active = await activeProvider(tx, 'tts')
  const apiKey = active?.config.api_key?.value
  if (!active || !apiKey) return null
  return createVoiceProvider(active.provider, { api_key: apiKey, model: active.config.model?.value }, doFetch)
}

/** The voice the install's default stands for, for the provider in effect: its voice id setting, else the provider's own default. */
export async function installDefaultVoice(tx: Tx): Promise<{ provider: string; voiceId: string } | null> {
  const active = await activeProvider(tx, 'tts').catch(() => null)
  if (!active) return null
  const voiceId = active.config.voice_id?.value?.trim() || providerDefaultVoices[active.provider]
  return voiceId ? { provider: active.provider, voiceId } : null
}

/** A text-to-speech provider by name, with its key (a clone's, or a voice of another provider than the one in effect). */
async function voiceProviderNamed(tx: Tx, name: string, doFetch: typeof fetch = fetch): Promise<VoiceProvider | null> {
  if (!(providersIn('tts') as string[]).includes(name)) return null
  const config = await resolveProvider(tx, name as ProviderName).catch(() => null)
  const apiKey = config?.api_key?.value
  return apiKey
    ? createVoiceProvider(name as ProviderName, { api_key: apiKey, model: config?.model?.value }, doFetch)
    : null
}

/** The workspace's clones at this provider. */
const clonesOf = (tx: Tx, workspaceId: string, provider: string) =>
  tx
    .select()
    .from(voice_clones)
    .where(
      and(
        eq(voice_clones.workspace_id, workspaceId),
        eq(voice_clones.provider, provider),
        isNull(voice_clones.deleted_at),
      ),
    )

/**
 * Whether an assistant of this workspace may use the voice: the default (empty id), a curated voice,
 * a voice this workspace cloned, or one of a provider's list (voice-catalog.ts). Anything else
 * (another workspace's clone, a random id) is refused.
 */
export async function checkAssistantVoice(tx: Tx, workspaceId: string, voice: { provider: string; voice_id: string }) {
  if (!voice.voice_id || isCuratedVoice(voice.provider, voice.voice_id)) return
  if (await catalogVoice(tx, workspaceId, voice.provider, voice.voice_id)) return
  const [own] = await tx
    .select({ id: voice_clones.id })
    .from(voice_clones)
    .where(
      and(
        eq(voice_clones.workspace_id, workspaceId),
        eq(voice_clones.provider, voice.provider),
        eq(voice_clones.voice_id, voice.voice_id),
        isNull(voice_clones.deleted_at),
      ),
    )
  if (!own) throw new Reject("that voice is not one of the voice providers' voices or this workspace's cloned voices")
}

/**
 * Clones no assistant of the workspace uses any more: marked deleted here (the row stays as the
 * consent record), and deleted at the provider by a job queued in the same transaction (it runs once
 * the change is committed).
 */
export async function releaseUnusedClones(tx: Tx, workspaceId: string) {
  const inUse = (
    await tx.select({ voice: assistants.voice }).from(assistants).where(eq(assistants.workspace_id, workspaceId))
  )
    .map(a => a.voice.voice_id)
    .filter(Boolean)
  const unused = await tx
    .update(voice_clones)
    .set({ deleted_at: sql`now()` })
    .where(
      and(
        eq(voice_clones.workspace_id, workspaceId),
        isNull(voice_clones.deleted_at),
        inUse.length ? notInArray(voice_clones.voice_id, inUse) : undefined,
      ),
    )
    .returning()
  for (const clone of unused) await queueVoiceDeletion(tx, clone.provider, clone.voice_id)
  return unused
}

/** A workspace is deleted: all its clones go at the provider; the rows stay as consent records. */
export async function releaseWorkspaceClones(tx: Tx, workspaceId: string) {
  const gone = await tx
    .update(voice_clones)
    .set({ deleted_at: sql`now()` })
    .where(and(eq(voice_clones.workspace_id, workspaceId), isNull(voice_clones.deleted_at)))
    .returning()
  for (const clone of gone) await queueVoiceDeletion(tx, clone.provider, clone.voice_id)
  return gone
}

/** The job behind queueVoiceDeletion: deletes a cloned voice at its provider. */
export async function deleteClonedVoice(provider: string, voiceId: string, doFetch: typeof fetch = fetch) {
  const adapter = await voiceProviderNamed(db, provider, doFetch)
  if (!adapter?.deleteVoice) throw new Error(`cannot delete voice ${voiceId} at ${provider}: no key or no delete`)
  await adapter.deleteVoice(voiceId)
}

/** What kind of audio the bytes are, from their first bytes; null when it is none we take. */
export function audioKind(bytes: Buffer): 'mp3' | 'wav' | 'ogg' | 'webm' | 'mp4' | null {
  if (bytes.length < 12) return null
  if (bytes.subarray(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))
    return 'mp3'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WAVE')
    return 'wav'
  if (bytes.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg'
  if (bytes.readUInt32BE(0) === 0x1a45dfa3) return 'webm'
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4'
  return null
}

const kindOfType: Record<string, ReturnType<typeof audioKind>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'mp4',
}

type CloneInput = { assistantId: string; name: string; audio: string; mimeType: string }
type Cloned = { provider: string; voiceId: string }

export const voicePreparers: Record<string, Preparer> = {
  /**
   * Outside the transaction: the provider call takes seconds. Checks first (cloning on, the assistant
   * is the workspace's, the recording is the audio it says it is), then clones; if the command does
   * not commit, the new voice is deleted at the provider again.
   */
  'voice.clone': async ({ actor, onRollback }, input: CloneInput): Promise<Cloned> => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    if (!(await cloningOn(db))) throw new Reject('voice cloning is turned off for this install (Server admin › System)')
    await assistantIn(db, actor.workspaceId, input.assistantId)
    const provider = await voiceProviderInUse(db)
    if (!provider?.cloneVoice) throw new Reject('the voice provider in use cannot clone voices')
    const audio = Buffer.from(input.audio, 'base64')
    if (!audio.length) throw new Reject('the recording is empty')
    if (audio.length > CLONE_AUDIO_MAX_BYTES) throw new Reject('the recording is larger than 10 MB')
    const kind = audioKind(audio)
    if (!kind || kind !== kindOfType[input.mimeType])
      throw new Reject('the file is not the audio recording it says it is')
    let voiceId: string
    try {
      voiceId = await provider.cloneVoice({ name: input.name, audio, mimeType: input.mimeType })
    } catch (e) {
      if (e instanceof VoiceProviderError) throw new Reject(e.message)
      throw e
    }
    onRollback(async () => {
      await provider.deleteVoice?.(voiceId)
      return `deleted the cloned voice ${voiceId} at ${provider.name}`
    })
    return { provider: provider.name, voiceId }
  },
}

/**
 * A preview made by the provider. Its result goes into the provider failure record (provider-failures.ts): a quota
 * used up or a rejected key there is what stops the assistant's voice too. A voice it does not know is about that voice.
 */
function trackedSynthesis(provider: VoiceProvider, voiceId: string, language: Language): Promise<Buffer> {
  return provider.synthesize(voiceId, PREVIEW_TEXTS[language], language).then(
    audio => {
      void noteProviderOk(provider.name)
      return audio.bytes
    },
    e => {
      if (e instanceof VoiceProviderError) {
        const problem = problemOfStatus(provider.name, e.status, e.message, 'a voice sample')
        if (problem.reason !== 'not_found' && problem.reason !== 'config')
          void noteProviderFailure(provider.name, problem, 'voice')
      }
      throw e
    },
  )
}

export const voiceHandlers: Record<string, Handler> = {
  'voice.options': async ({ tx, actor }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const active = await activeProvider(tx, 'tts').catch(() => null)
    const provider = active?.provider ?? null
    const clones = provider ? await clonesOf(tx, actor.workspaceId, provider) : []
    const fallback = await installDefaultVoice(tx)
    // Only what this workspace may use: the one the instance admin picked for all, or both to choose from.
    const pipelines = pipelinesAllowed(await pipelinesSetUp(tx), await voicePipelinePolicy(tx))
    const data: VoiceOptionsData = {
      provider,
      realtime: pipelines.realtime,
      pipelines,
      voices: provider ? (curatedVoices[provider] ?? []) : [],
      clones: clones.map(c => ({ id: c.voice_id, name: c.name })),
      canClone: !!provider && cloningProviders.includes(provider) && (await cloningOn(tx)),
      defaultVoice: fallback && {
        id: fallback.voiceId,
        name: (curatedVoices[fallback.provider] ?? []).find(v => v.id === fallback.voiceId)?.name ?? null,
      },
    }
    return { rows: {}, data }
  },

  'voice.catalog': async ({ tx, actor }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    return { rows: {}, data: catalogData(await voiceCatalog(tx, actor.workspaceId)) }
  },

  /** The clone was made by the preparer; here the consent record is stored and the voice becomes the assistant's. */
  'voice.clone': async ({ tx, actor, now, prepared }, input: CloneInput) => {
    const workspaceId = actor.workspaceId!
    const { provider, voiceId } = prepared as Cloned
    const assistant = await assistantIn(tx, workspaceId, input.assistantId)
    await tx.insert(voice_clones).values({
      id: newId(),
      workspace_id: workspaceId,
      provider,
      voice_id: voiceId,
      name: input.name,
      consent_by: actor.actorId,
      consent_at: now,
      consent_text: CLONE_CONSENT_TEXT,
    })
    const rows = await tx
      .update(assistants)
      .set({ voice: { provider, voice_id: voiceId } })
      .where(eq(assistants.id, assistant!.id))
      .returning()
    await releaseUnusedClones(tx, workspaceId)
    const data: VoiceCloneData = { voiceId }
    return { rows: { assistants: rows }, data }
  },

  'voiceCloning.get': async ({ tx }) => ({ rows: {}, data: { on: await cloningOn(tx) } satisfies VoiceCloningData }),

  'voiceCloning.set': async ({ tx, actor, now }, input: { on: boolean }) => {
    const value = input.on ? 'on' : 'off'
    await tx
      .insert(instance_settings)
      .values({ key: CLONING_KEY, value, updated_at: now, updated_by: actor.actorId })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actor.actorId } })
    return { rows: {}, data: { on: input.on } satisfies VoiceCloningData }
  },

  'voicePipelinePolicy.get': async ({ tx }) => ({
    rows: {},
    data: { policy: await voicePipelinePolicy(tx) } satisfies VoicePipelinePolicyData,
  }),

  'voicePipelinePolicy.set': async ({ tx, actor, now }, input: { policy: VoicePipelinePolicy }) => {
    await setVoicePipelinePolicy(tx, input.policy, actor.actorId, now)
    return { rows: {}, data: { policy: input.policy } satisfies VoicePipelinePolicyData }
  },
}

// --- Previews

export function previewCache(
  dir = process.env.VOICE_PREVIEW_DIR || join(tmpdir(), 'linedesk-voice-previews'),
  maxFiles = PREVIEW_CACHE_MAX_FILES,
) {
  const file = (key: string) => join(dir, `${key}.mp3`)
  /** Keeps the newest `maxFiles` samples. */
  async function prune() {
    const names = (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.mp3'))
    if (names.length <= maxFiles) return
    const dated = await Promise.all(
      names.map(async n => ({ n, at: (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })),
    )
    dated.sort((a, b) => a.at - b.at)
    for (const { n } of dated.slice(0, dated.length - maxFiles)) await unlink(join(dir, n)).catch(() => {})
  }
  return {
    async get(key: string): Promise<Buffer | null> {
      return readFile(file(key)).catch(() => null)
    },
    /** Written to a temporary file first, so a reader never sees half a file. */
    async put(key: string, bytes: Buffer) {
      await mkdir(dir, { recursive: true })
      const temporary = `${file(key)}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, bytes)
      await rename(temporary, file(key))
      await prune()
    },
  }
}

/**
 * A synthesized sample's cache key: provider, model, voice, language and text. English keeps the key it had before
 * samples had a language, so the samples cached then are still used.
 */
export const previewKey = (provider: VoiceProvider, voiceId: string, language: Language = 'en') =>
  createHash('sha256')
    .update(
      JSON.stringify(
        language === 'en'
          ? [provider.name, provider.model, voiceId, PREVIEW_TEXTS.en]
          : [provider.name, provider.model, voiceId, PREVIEW_TEXTS[language], language],
      ),
    )
    .digest('hex')
    .slice(0, 32)

/** New samples per workspace in the last hour, in this API process. */
export function previewBudget(perHour = PREVIEWS_PER_HOUR, now = Date.now) {
  const made = new Map<string, number[]>()
  return {
    take(workspaceId: string): boolean {
      const since = now() - 60 * 60 * 1000
      const recent = (made.get(workspaceId) ?? []).filter(at => at > since)
      if (recent.length >= perHour) {
        made.set(workspaceId, recent)
        return false
      }
      made.set(workspaceId, [...recent, now()])
      return true
    },
  }
}

/** Where the curated voices' samples ship: `<provider>/<voiceId>.mp3`. */
export const BUNDLED_PREVIEWS_DIR = fileURLToPath(new URL('../assets/voice-previews/', import.meta.url))

/** The shipped sample of a curated voice, or null (not curated, or no file for it). */
export async function bundledPreview(voiceId: string, dir = BUNDLED_PREVIEWS_DIR): Promise<Buffer | null> {
  const provider = Object.keys(curatedVoices).find(p => isCuratedVoice(p, voiceId))
  return provider ? readFile(join(dir, provider, `${voiceId}.mp3`)).catch(() => null) : null
}

/** Shown in Settings when there is no provider to make a sample with. */
export const NO_PROVIDER_FOR_PREVIEW = 'Add a voice provider key in Server admin › Providers to hear samples.'

const error = (status: number, message: string) => Response.json({ ok: false, error: message }, { status })
const audioResponse = (bytes: Buffer) =>
  new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'audio/mpeg',
      'content-length': String(bytes.length),
      'cache-control': 'private, max-age=604800, immutable',
    },
  })

/** Samples being made right now: two requests for the same voice share one synthesis. */
const making = new Map<string, Promise<Buffer>>()
const defaultBudget = previewBudget()

type PreviewOptions = {
  provider?: VoiceProvider | null
  cache?: ReturnType<typeof previewCache>
  budget?: ReturnType<typeof previewBudget>
  /** Whether the voice is one of the workspace's clones (default: looked up). */
  ownClone?: boolean
  /** Where the shipped samples are (tests). */
  bundledDir?: string
  /** The provider the voice is of (`?provider=`); default the one in effect. */
  providerName?: string
  /** The install's default voice (default: looked up); it always has a preview. */
  installDefault?: { provider: string; voiceId: string } | null
  /** The voice in the provider's list (default: looked up); null when it is not listed. */
  catalogEntry?: CatalogEntry | null
  /**
   * The language to speak the sample in (the assistant's main language; default English). Not for a sample the
   * provider hosts: that one is played as it is.
   */
  language?: Language
  doFetch?: typeof fetch
}

/** Longest provider-hosted sample taken. */
const SAMPLE_MAX_BYTES = 2 * 1024 * 1024

/** Where each provider hosts its voice samples; a sample URL on any other host is not fetched. */
export const SAMPLE_HOSTS: Record<string, readonly string[]> = { elevenlabs: [ELEVENLABS_SAMPLE_HOST], cartesia: [] }

/** The body, refused as soon as it is larger than `max` bytes (by content-length, and while it streams). */
async function boundedBody(res: Response, max: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length') ?? 0) > max)
    throw new VoiceProviderError('the voice sample is too large', 502)
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new VoiceProviderError('the voice sample is too large', 502)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** A sample the provider hosts at a public https URL on its own sample host (no key, no cost). */
export async function hostedSample(provider: string, url: string, doFetch: typeof fetch = fetch): Promise<Buffer> {
  const parsed = URL.canParse(url) ? new URL(url) : null
  if (parsed?.protocol !== 'https:' || !(SAMPLE_HOSTS[provider] ?? []).includes(parsed.hostname))
    throw new VoiceProviderError("the voice sample is not on the provider's sample host", 502)
  const res = await doFetch(parsed, { signal: AbortSignal.timeout(20_000), redirect: 'error' })
  if (!res.ok) throw new VoiceProviderError(`voice sample failed (${res.status})`, 502)
  const bytes = await boundedBody(res, SAMPLE_MAX_BYTES)
  if (!bytes.length || audioKind(bytes) !== 'mp3') throw new VoiceProviderError('the voice sample is not an mp3', 502)
  return bytes
}

/**
 * The preview of a voice the workspace may use: a curated voice (its shipped sample in English, no provider
 * needed), one of its own clones, or a voice of a provider's list (the sample the provider hosts, else
 * one synthesized). Synthesized samples are spoken in `language`. A synthesized sample not in the cache counts against
 * PREVIEWS_PER_HOUR.
 */
export async function servePreview(actor: Actor, rawVoiceId: string, options: PreviewOptions = {}): Promise<Response> {
  if (!actor.workspaceId || !actor.permissions.includes('call:read')) return error(403, 'missing permission call:read')
  const parsed = voiceIdSchema.safeParse(rawVoiceId)
  if (!parsed.success) return error(400, 'not a voice id')
  const voiceId = parsed.data
  const language = options.language ?? 'en'
  // The shipped samples are English; in another language the curated voices are synthesized like any other.
  const shipped = language === 'en' ? await bundledPreview(voiceId, options.bundledDir) : null
  if (shipped) return audioResponse(shipped)
  const provider =
    options.provider !== undefined
      ? options.provider
      : options.providerName
        ? await voiceProviderNamed(db, options.providerName, options.doFetch)
        : await voiceProviderInUse(db, options.doFetch)
  if (!provider) return error(409, NO_PROVIDER_FOR_PREVIEW)
  const installDefault = options.installDefault !== undefined ? options.installDefault : await installDefaultVoice(db)
  const ownOrCurated =
    isCuratedVoice(provider.name, voiceId) ||
    (installDefault?.provider === provider.name && installDefault.voiceId === voiceId) ||
    (options.ownClone ?? (await clonesOf(db, actor.workspaceId, provider.name)).some(c => c.voice_id === voiceId))
  const listed = ownOrCurated
    ? null
    : options.catalogEntry !== undefined
      ? options.catalogEntry
      : await catalogVoice(db, actor.workspaceId, provider.name, voiceId, { doFetch: options.doFetch })
  if (!ownOrCurated && !listed)
    return error(404, "not one of the voice providers' voices or this workspace's cloned voices")
  const hosted = listed?.previewUrl ?? null
  const cache = options.cache ?? previewCache()
  const key = hosted
    ? createHash('sha256').update(hosted).digest('hex').slice(0, 32)
    : previewKey(provider, voiceId, language)
  const stored = await cache.get(key)
  if (stored) return audioResponse(stored)
  try {
    let pending = making.get(key)
    if (!pending) {
      if (!hosted && !(options.budget ?? defaultBudget).take(actor.workspaceId))
        return error(429, `at most ${PREVIEWS_PER_HOUR} new voice samples an hour`)
      const made = hosted
        ? hostedSample(provider.name, hosted, options.doFetch ?? fetch)
        : trackedSynthesis(provider, voiceId, language)
      pending = made.then(async bytes => {
        await cache
          .put(key, bytes)
          .catch(e => console.warn(`could not store a voice preview: ${e instanceof Error ? e.message : e}`))
        return bytes
      })
      making.set(key, pending)
      void pending.catch(() => {}).finally(() => making.delete(key))
    }
    return audioResponse(await pending)
  } catch (e) {
    if (e instanceof VoiceProviderError) {
      const unknown = e.status === 400 || e.status === 404 || e.status === 422
      if (unknown) return error(404, 'the voice provider does not know this voice')
      // Why, in the shared words (LIN-111): a used-up quota or a rejected key is not "did not answer".
      const { reason } = problemOfStatus(provider.name, e.status, e.message, 'a voice sample')
      return Response.json(
        {
          ok: false,
          error: e.message,
          reason,
          message: providerFailureText(reason, providerSpec(provider.name).label, audienceOf(actor)),
        },
        { status: 502 },
      )
    }
    throw e
  }
}
