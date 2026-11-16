// The assistant's voice: a short list of curated voices per text-to-speech provider (English, US),
// and voices the workspace cloned, where the provider clones over its API and an instance admin
// turned cloning on. Previews are served by GET /v1/voices/preview/<voiceId> and generated once per voice.
import { z } from 'zod'
import { defineAction } from './define.ts'
import type { PipelinesSetUp } from './settings.ts'
import type { UsageLevelOptions } from './usage-level.ts'

/**
 * A language a voice speaks, as its provider describes it. `code`: the language without region (`de`). `native`: the
 * voice can perform it (ElevenLabs: verified for it; Cartesia: the accent it was recorded in); the picker's voice
 * follows these for the assistant's languages. `accent`: the accent it
 * speaks this language with, in words (`american`, `latin american`), null when the provider does not say. Every voice
 * speaks every language the assistant supports; a language it is not native in it speaks with its own accent.
 */
export type VoiceLanguage = { code: string; accent: string | null; native: boolean }

export type CuratedVoice = {
  id: string
  name: string
  description: string
  /** Missing from an API of an older version. */
  languages?: readonly VoiceLanguage[]
}

const AMERICAN_ENGLISH: readonly VoiceLanguage[] = [{ code: 'en', accent: 'american', native: true }]

/**
 * Picked for a phone line: clear, natural, American English. ElevenLabs default voices, available on
 * every account. Cartesia has none listed yet: there the assistant keeps the default voice.
 */
export const curatedVoices: Record<string, readonly CuratedVoice[]> = {
  elevenlabs: [
    {
      id: 'cgSgspJ2msm6clMCkdW9',
      name: 'Jessica',
      description: 'Warm and bright, female',
      languages: AMERICAN_ENGLISH,
    },
    {
      id: 'EXAVITQu4vr4xnSDxMaL',
      name: 'Sarah',
      description: 'Calm and reassuring, female',
      languages: AMERICAN_ENGLISH,
    },
    { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', description: 'Professional, female', languages: AMERICAN_ENGLISH },
    {
      id: 'cjVigY5qzO86Huf0OWal',
      name: 'Eric',
      description: 'Smooth and trustworthy, male',
      languages: AMERICAN_ENGLISH,
    },
    { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', description: 'Down-to-earth, male', languages: AMERICAN_ENGLISH },
    { id: 'SAz9YHcvj6GT2YYXdXww', name: 'River', description: 'Relaxed and neutral', languages: AMERICAN_ENGLISH },
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

/** The realtime model's provider, as the voice picker and the preview route name it. */
export const REALTIME_VOICE_PROVIDER = 'openai_realtime'

/**
 * The voices of OpenAI's Realtime API (gpt-realtime family), as OpenAI's realtime conversations guide lists them
 * (checked 2026-11-15); OpenAI recommends marin and cedar "for best quality", so they come first. OpenAI gives no
 * gender or style per voice, so neither is claimed here. The text-to-speech guide says its voices "are currently
 * optimized for English": native English, every other language spoken with the voice's own accent. The same names
 * work with gpt-4o-mini-tts, which says a realtime call's fixed lines and makes the previews.
 */
export const REALTIME_VOICE_IDS = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
] as const
export type RealtimeVoiceId = (typeof REALTIME_VOICE_IDS)[number]
/** OpenAI's recommended voices ("For best quality, we recommend using marin or cedar"). */
export const RECOMMENDED_REALTIME_VOICES: readonly RealtimeVoiceId[] = ['marin', 'cedar']
/** The voice when neither the assistant nor the server (Server admin › Providers › OpenAI Realtime) picks one. */
export const REALTIME_DEFAULT_VOICE: RealtimeVoiceId = 'marin'
const REALTIME_VOICE_LANGUAGES: readonly VoiceLanguage[] = [{ code: 'en', accent: null, native: true }]

/** One realtime voice: its id (also its name, capitalized), whether OpenAI recommends it, its languages. */
export type RealtimeVoice = { id: RealtimeVoiceId; recommended: boolean; languages: readonly VoiceLanguage[] }
export const realtimeVoices: readonly RealtimeVoice[] = REALTIME_VOICE_IDS.map(id => ({
  id,
  recommended: RECOMMENDED_REALTIME_VOICES.includes(id),
  languages: REALTIME_VOICE_LANGUAGES,
}))

export const isRealtimeVoice = (value: unknown): value is RealtimeVoiceId =>
  typeof value === 'string' && (REALTIME_VOICE_IDS as readonly string[]).includes(value)

/** An assistant's realtime voice: one of REALTIME_VOICE_IDS, or '' for the server's default voice. */
export const realtimeVoiceChoice = z.union([z.literal(''), z.enum(REALTIME_VOICE_IDS)])

/**
 * The voice a realtime call speaks with: the assistant's own when it is one of the realtime voices, else the server's
 * default (when that is one), else REALTIME_DEFAULT_VOICE.
 */
export function realtimeVoiceFor(assistantVoice: string | null | undefined, serverVoice: string | null | undefined) {
  if (isRealtimeVoice(assistantVoice)) return assistantVoice
  const server = serverVoice?.trim()
  return server || REALTIME_DEFAULT_VOICE
}

/** Providers whose API can clone a voice from a recording (behind the API's voice provider interface). */
export const cloningProviders: readonly string[] = ['elevenlabs']

/** What the person cloning confirms; stored word for word with the clone. */
export const CLONE_CONSENT_TEXT =
  'The speaker in this recording agreed to their voice being cloned and used for this business’s phone assistant.'

/** A voice the workspace cloned. */
export type ClonedVoice = { id: string; name: string }

/**
 * What the voice picker shows. `provider` null: no voice provider is set up (Server admin › Providers).
 * `canClone`: the provider clones and an instance admin turned cloning on.
 */
export type VoiceOptionsData = {
  provider: string | null
  /**
   * A realtime model is connected (Server admin › Providers): the install default for an assistant that chose no
   * pipeline. Missing from an API of an older version: false.
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
   * The voice "Default voice" stands for: the install's default voice id (Server admin › Providers), else the
   * provider's own. `name` when it is a curated voice. null when it cannot be told.
   */
  defaultVoice: { id: string; name: string | null } | null
  /**
   * The realtime voice an assistant speaks with when it picks none (`assistants.realtime_voice` ''): the server's
   * default voice (Server admin › Providers › OpenAI Realtime), else REALTIME_DEFAULT_VOICE. Missing from an older API,
   * and while no realtime model is set up.
   */
  realtimeDefaultVoice?: string
  /**
   * The languages calls can be answered in on this install: those a voice provider set up speaks (spokenLanguages);
   * an assistant may pick only these. Missing from an older API: every one of LANGUAGES.
   */
  languages?: string[]
  /**
   * What "any language" covers on this install (anyModeLanguages): with a Deepgram Flux model Flux's 10 of `languages`,
   * else all of them. Missing from an older API: `languages`.
   */
  anyLanguages?: string[]
  /** The voice models and language models an assistant can pick, with their level on Linedesk Cloud (usage-level.ts). */
  levels: UsageLevelOptions
}

export const voiceOptions = defineAction({
  name: 'voice.options',
  description:
    "The voices an assistant can use with the text-to-speech provider in effect: curated voices, the workspace's cloned voices, and whether it can clone one. `levels`: the voice models (per voice provider) and language models (of the server's provider) an assistant can pick with assistant.update (`voice.model`, `llm_model`), each with its level on Linedesk Cloud (standard 5¢, premium 10¢ a minute) and whether this workspace may pick it (`allowed`: Premium needs the owner's Allow Premium); `billed` false: no levels on this server.",
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
  /**
   * Every language the provider lists for the voice, native ones first. Missing from an API of an older version (then
   * `language` and `accent` are all there is).
   */
  languages?: readonly VoiceLanguage[]
  /**
   * The voice's own language, the one it was recorded in (one of the native ones of `languages`, else the first), e.g.
   * `de` for an Austrian German voice that is verified in Dutch too.
   */
  language: string | null
  gender: string | null
  /** The accent of that native language. */
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
  /**
   * The provider's plan offers no native voices for languages besides English (ElevenLabs' free plan cannot use
   * Voice Library voices). Missing when the plan is paid, unknown, or does not matter for the provider.
   */
  freePlan?: boolean
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

/** A provider voice id: letters, digits, dashes and underscores (ElevenLabs ids, Cartesia UUIDs). Realtime voices: realtimeVoiceChoice. */
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
