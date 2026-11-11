// Voices for Settings › Assistant: which voices an assistant may use (curated ones and the
// workspace's own clones), cloning one (voice.clone: off until an instance admin turns it on), and
// GET /v1/voices/preview/<voiceId>, a short sample in that voice. A sample is generated once per
// provider, model, voice and text and kept on disk, so opening the page costs nothing.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLONE_AUDIO_MAX_BYTES,
  CLONE_CONSENT_TEXT,
  cloningProviders,
  curatedVoices,
  isCuratedVoice,
  type ProviderName,
  type VoiceCloneData,
  type VoiceCloningData,
  type VoiceOptionsData,
  voiceId as voiceIdSchema,
} from '@linedesk/actions'
import { assistants, instance_settings, type Tx, voice_clones } from '@linedesk/db'
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm'
import { assistantIn } from './assistants.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { type Handler, type Preparer, Reject } from './handler-context.ts'
import { queueVoiceDeletion } from './jobs.ts'
import { activeProvider, resolveProvider } from './provider-settings.ts'
import { createVoiceProvider, type VoiceProvider, VoiceProviderError } from './voice-provider.ts'

/** What every preview says. Changing it makes new samples (the text is part of the cache key). */
export const PREVIEW_TEXT = 'Hi, thanks for calling. This is how I sound on the phone. How can I help you today?'
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

/** The provider a clone was made at, with its key (it may not be the one in effect any more). */
async function voiceProviderNamed(tx: Tx, name: string, doFetch: typeof fetch = fetch): Promise<VoiceProvider | null> {
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
 * or a voice this workspace cloned. Anything else (another workspace's clone, a random id) is refused.
 */
export async function checkAssistantVoice(tx: Tx, workspaceId: string, voice: { provider: string; voice_id: string }) {
  if (!voice.voice_id || isCuratedVoice(voice.provider, voice.voice_id)) return
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
  if (!own) throw new Reject("that voice is not one of the curated voices or this workspace's cloned voices")
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
    if (!(await cloningOn(db))) throw new Reject('voice cloning is turned off for this install (Admin, System)')
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

export const voiceHandlers: Record<string, Handler> = {
  'voice.options': async ({ tx, actor }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const active = await activeProvider(tx, 'tts').catch(() => null)
    const provider = active?.provider ?? null
    const clones = provider ? await clonesOf(tx, actor.workspaceId, provider) : []
    const data: VoiceOptionsData = {
      provider,
      voices: provider ? (curatedVoices[provider] ?? []) : [],
      clones: clones.map(c => ({ id: c.voice_id, name: c.name })),
      canClone: !!provider && cloningProviders.includes(provider) && (await cloningOn(tx)),
    }
    return { rows: {}, data }
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

export const previewKey = (provider: VoiceProvider, voiceId: string, text = PREVIEW_TEXT) =>
  createHash('sha256')
    .update(JSON.stringify([provider.name, provider.model, voiceId, text]))
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
}

/**
 * The preview of a voice the workspace may use: a curated voice, or one of its own clones. A sample
 * not in the cache counts against the workspace's PREVIEWS_PER_HOUR.
 */
export async function servePreview(actor: Actor, rawVoiceId: string, options: PreviewOptions = {}): Promise<Response> {
  if (!actor.workspaceId || !actor.permissions.includes('call:read')) return error(403, 'missing permission call:read')
  const parsed = voiceIdSchema.safeParse(rawVoiceId)
  if (!parsed.success) return error(400, 'not a voice id')
  const voiceId = parsed.data
  const provider = options.provider === undefined ? await voiceProviderInUse(db) : options.provider
  if (!provider) return error(409, 'no voice provider is set up (Admin, Providers)')
  const allowed =
    isCuratedVoice(provider.name, voiceId) ||
    (options.ownClone ?? (await clonesOf(db, actor.workspaceId, provider.name)).some(c => c.voice_id === voiceId))
  if (!allowed) return error(404, "not one of the curated voices or this workspace's cloned voices")
  const cache = options.cache ?? previewCache()
  const key = previewKey(provider, voiceId)
  const stored = await cache.get(key)
  if (stored) return audioResponse(stored)
  try {
    let pending = making.get(key)
    if (!pending) {
      if (!(options.budget ?? defaultBudget).take(actor.workspaceId))
        return error(429, `at most ${PREVIEWS_PER_HOUR} new voice samples an hour`)
      pending = provider.synthesize(voiceId, PREVIEW_TEXT).then(async audio => {
        await cache
          .put(key, audio.bytes)
          .catch(e => console.warn(`could not store a voice preview: ${e instanceof Error ? e.message : e}`))
        return audio.bytes
      })
      making.set(key, pending)
      void pending.catch(() => {}).finally(() => making.delete(key))
    }
    return audioResponse(await pending)
  } catch (e) {
    if (e instanceof VoiceProviderError) {
      const unknown = e.status === 400 || e.status === 404 || e.status === 422
      return error(unknown ? 404 : 502, unknown ? 'the voice provider does not know this voice' : e.message)
    }
    throw e
  }
}
