// The assistant's voice: a short list of curated voices per text-to-speech provider (English, US),
// and voices the workspace cloned, where the provider clones over its API and an instance admin
// turned cloning on. Previews are served by GET /v1/voices/preview/<voiceId> and generated once per voice.
import { z } from 'zod'
import { defineAction } from './define.ts'
import type { PipelinesSetUp } from './settings.ts'

export type CuratedVoice = { id: string; name: string; description: string }

/**
 * Picked for a phone line: clear, natural, American English. ElevenLabs default voices, available on
 * every account. Cartesia has none listed yet: there the assistant keeps the default voice.
 */
export const curatedVoices: Record<string, readonly CuratedVoice[]> = {
  elevenlabs: [
    { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', description: 'Warm and bright, female' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'Calm and reassuring, female' },
    { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', description: 'Professional, female' },
    { id: 'cjVigY5qzO86Huf0OWal', name: 'Eric', description: 'Smooth and trustworthy, male' },
    { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', description: 'Down-to-earth, male' },
    { id: 'SAz9YHcvj6GT2YYXdXww', name: 'River', description: 'Relaxed and neutral' },
  ],
  cartesia: [],
}

/**
 * The voice each provider speaks with when neither the assistant nor the install (TTS_VOICE_ID) sets one:
 * Jessica on ElevenLabs; on Cartesia the LiveKit plugin's own default (`TTSDefaultVoiceId`, keep in sync).
 */
export const providerDefaultVoices: Record<string, string> = {
  elevenlabs: 'cgSgspJ2msm6clMCkdW9',
  cartesia: 'f786b574-daa5-4673-aa0c-cbe3e8534c02',
}

export const isCuratedVoice = (provider: string, voiceId: string) =>
  (curatedVoices[provider] ?? []).some(v => v.id === voiceId)

/** Providers whose API can clone a voice from a recording (behind the API's voice provider interface). */
export const cloningProviders: readonly string[] = ['elevenlabs']

/** What the person cloning confirms; stored word for word with the clone. */
export const CLONE_CONSENT_TEXT =
  'The speaker in this recording agreed to their voice being cloned and used for this business’s phone assistant.'

/** A voice the workspace cloned. */
export type ClonedVoice = { id: string; name: string }

/**
 * What the voice picker shows. `provider` null: no voice provider is set up (Admin, Providers).
 * `canClone`: the provider clones and an instance admin turned cloning on.
 */
export type VoiceOptionsData = {
  provider: string | null
  /**
   * A realtime model is connected (Admin, Providers): the install default for an assistant that chose no pipeline.
   * Missing from an API of an older version: false.
   */
  realtime?: boolean
  /**
   * Which pipelines this workspace's calls can be answered with: those set up, narrowed to the one the instance admin
   * picked for every workspace (pipelinesAllowed). With both, the assistant picks one (`voice_pipeline`). Missing
   * from an older API.
   */
  pipelines?: PipelinesSetUp
  voices: readonly CuratedVoice[]
  clones: readonly ClonedVoice[]
  canClone: boolean
  /**
   * The voice "Default voice" stands for: the install's default voice id (Admin › Providers), else the
   * provider's own. `name` when it is a curated voice. null when it cannot be told.
   */
  defaultVoice: { id: string; name: string | null } | null
}

export const voiceOptions = defineAction({
  name: 'voice.options',
  description:
    "The voices an assistant can use with the text-to-speech provider in effect: curated voices, the workspace's cloned voices, and whether it can clone one.",
  input: z.object({}),
  permission: 'call:read',
  readOnly: true,
})

/**
 * A voice of a provider's own list (Settings › Assistant › Voice › More voices): the provider's voices
 * that the install's key can use, without other workspaces' clones. Fields the provider does not give are null.
 */
export type CatalogVoice = {
  provider: string
  id: string
  name: string
  description: string | null
  /** Language code as the provider gives it, e.g. `en`. */
  language: string | null
  gender: string | null
  accent: string | null
}

/**
 * A text-to-speech provider Linedesk supports: `configured` when it has a key (its voices are listed),
 * `active` when it is the install's provider in effect, `error` when its list could not be read.
 */
export type CatalogProvider = {
  provider: string
  label: string
  active: boolean
  configured: boolean
  error: string | null
}

/** `data` of `voice.catalog`: every supported provider, and the voices of those with a key. */
export type VoiceCatalogData = { providers: readonly CatalogProvider[]; voices: readonly CatalogVoice[] }

export const voiceCatalog = defineAction({
  name: 'voice.catalog',
  description:
    "Every voice an assistant can use from the text-to-speech providers that have a key: each provider's own list (fetched with the install's key, cached a few minutes), without other workspaces' cloned voices.",
  input: z.object({}),
  permission: 'call:read',
  readOnly: true,
})

/** A provider voice id: letters, digits, dashes and underscores (ElevenLabs ids, Cartesia UUIDs). */
export const voiceId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'a voice id of the provider, like 21m00Tcm4TlvDq8ikWAM')

/** Longest recording a clone takes, in bytes (base64 adds a third on top). */
export const CLONE_AUDIO_MAX_BYTES = 10 * 1024 * 1024
/** The largest request body voice.clone accepts: the recording in base64 and a little JSON around it. */
export const CLONE_BODY_MAX_BYTES = Math.ceil((CLONE_AUDIO_MAX_BYTES * 4) / 3) + 64 * 1024
export const cloneAudioTypes = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm',
  'audio/ogg',
] as const

export const voiceClone = defineAction({
  name: 'voice.clone',
  description:
    "Clone a voice from a recording at the text-to-speech provider and make it the assistant's voice. Only when an instance admin turned cloning on and the provider clones over its API. `consent` must be true: the speaker agreed (CLONE_CONSENT_TEXT); who confirmed it and when is stored with the clone. The recording is passed on to the provider and not stored by Linedesk.",
  input: z.object({
    assistantId: z.string().min(1),
    name: z.string().trim().min(1).max(60),
    consent: z.literal(true, { message: 'the speaker has to agree to their voice being cloned' }),
    /** The recording, base64. */
    audio: z
      .string()
      .min(1)
      .max(Math.ceil((CLONE_AUDIO_MAX_BYTES * 4) / 3) + 4, 'the recording is larger than 10 MB'),
    mimeType: z.enum(cloneAudioTypes),
  }),
  permission: 'settings:write',
  // Kept out of the command log: a recording of a person's voice, and megabytes long.
  sensitive: ['audio'],
})
/** `data` of `voice.clone`. */
export type VoiceCloneData = { voiceId: string }

/** Whether workspaces may clone voices: off until an instance admin turns it on. */
export const voiceCloningGet = defineAction({
  name: 'voiceCloning.get',
  description: 'Whether workspaces of this install may clone voices (off by default).',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})
export const voiceCloningSet = defineAction({
  name: 'voiceCloning.set',
  description: 'Allow or stop voice cloning for every workspace of this install. Existing cloned voices keep working.',
  input: z.object({ on: z.boolean() }),
  permission: 'instance:admin',
})
/** `data` of `voiceCloning.get` and `voiceCloning.set`. */
export type VoiceCloningData = { on: boolean }
