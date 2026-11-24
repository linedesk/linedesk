// The assistant's voice: a short list of curated voices per text-to-speech provider (English, US),
// and voices the workspace cloned, where the provider clones over its API and an instance admin
// turned cloning on. Previews are served by GET /v1/voices/preview/<voiceId> and generated once per voice.
import { type MessageKey, msg } from '@linedesk/i18n'
import { z } from 'zod'
import { defineAction } from './define.ts'
import type { Language } from './languages.ts'
import type { ProviderFailureReason } from './provider-health.ts'
import type { PipelinesSetUp } from './settings.ts'
import type { CallQualityOptions } from './usage-level.ts'
import { english, type Words } from './words.ts'

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

/** A curated voice as written here: its description is a key, read in the reader's language (curatedVoicesIn). */
type CuratedVoiceEntry = Omit<CuratedVoice, 'description'> & { description: MessageKey }

const AMERICAN_ENGLISH: readonly VoiceLanguage[] = [{ code: 'en', accent: 'american', native: true }]

/**
 * Picked for a phone line: clear, natural, American English. ElevenLabs default voices, available on
 * every account. Cartesia has none listed yet: there the assistant keeps the default voice.
 */
export const curatedVoices: Record<string, readonly CuratedVoiceEntry[]> = {
  elevenlabs: [
    {
      id: 'cgSgspJ2msm6clMCkdW9',
      name: 'Jessica',
      description: msg('settings.voice.curated.warmBright'),
      languages: AMERICAN_ENGLISH,
    },
    {
      id: 'EXAVITQu4vr4xnSDxMaL',
      name: 'Sarah',
      description: msg('settings.voice.curated.calmReassuring'),
      languages: AMERICAN_ENGLISH,
    },
    {
      id: 'XrExE9yKIg1WjnnlVkGX',
      name: 'Matilda',
      description: msg('settings.voice.curated.professional'),
      languages: AMERICAN_ENGLISH,
    },
    {
      id: 'cjVigY5qzO86Huf0OWal',
      name: 'Eric',
      description: msg('settings.voice.curated.smoothTrustworthy'),
      languages: AMERICAN_ENGLISH,
    },
    {
      id: 'iP95p4xoKVk53GoZ742B',
      name: 'Chris',
      description: msg('settings.voice.curated.downToEarth'),
      languages: AMERICAN_ENGLISH,
    },
    {
      id: 'SAz9YHcvj6GT2YYXdXww',
      name: 'River',
      description: msg('settings.voice.curated.relaxedNeutral'),
      languages: AMERICAN_ENGLISH,
    },
  ],
  cartesia: [],
}

/** The curated voices of a provider as people read them: each description in `words` (the reader's language). */
export const curatedVoicesIn = (provider: string, words: Words = english): CuratedVoice[] =>
  (curatedVoices[provider] ?? []).map(voice => ({ ...voice, description: words.t(voice.description) }))

/**
 * The voice each provider speaks with when the assistant sets none (no install default voice):
 * Jessica on ElevenLabs; on Cartesia the LiveKit plugin's own default (`TTSDefaultVoiceId`, keep in sync).
 */
export const providerDefaultVoices: Record<string, string> = {
  elevenlabs: 'cgSgspJ2msm6clMCkdW9',
  cartesia: 'f786b574-daa5-4673-aa0c-cbe3e8534c02',
}

/**
 * The voice settings every ElevenLabs request sends (calls and previews), with the talking speed as `speed`: ElevenLabs'
 * own defaults. Without them ElevenLabs uses the settings the voice's owner saved, and many Voice Library voices are
 * saved slower (Ela "Cheerful and Happy" took 43 % longer for the same sentence; LIN-712). Premade voices such as
 * Jessica have these settings already, so they sound the same.
 */
export const ELEVENLABS_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 } as const
/** Bumped when ELEVENLABS_VOICE_SETTINGS change: it is part of the keys of cached ElevenLabs audio (greetings, lines, previews). */
export const ELEVENLABS_SETTINGS_VERSION = 'settings-1'

export const isCuratedVoice = (provider: string, voiceId: string) =>
  (curatedVoices[provider] ?? []).some(v => v.id === voiceId)

/** A voice recorded in one language: the default for an assistant that speaks it and picked no voice. */
export type LanguageDefaultVoice = {
  id: string
  /** The voice's first name at the provider (a name, not English text to translate). */
  name: string
  /** None of its own: the picker describes it by its gender and language, or by the provider's list. */
  description: null
  language: string
  gender: string
  languages: readonly VoiceLanguage[]
}

const native = (code: string, id: string, name: string, gender = 'female'): LanguageDefaultVoice => ({
  id,
  name,
  description: null,
  language: code,
  gender,
  languages: [{ code, accent: null, native: true }],
})

/**
 * The voice an assistant speaks with when it picked none and its main language is not English (a
 * German workspace speaks with a German voice, in onboarding's test call and on real calls). One voice per language,
 * recorded in it (its own language, not an English voice verified in it): from ElevenLabs' Voice Library list as the
 * voice catalog reads it (conversational, by use over a year, standard rate, no live moderation; voice-provider.ts),
 * the first female voice made for calls (a support, assistant or conversational voice), else the first female one, else
 * the first; read on 2026-11-19. Vietnamese: the next one, Thanh Ngọc; Huyen speaks at about 70 % of the pace of the
 * other Vietnamese voices (LIN-714). Fixed here so the default is the same on every call and every install, and the agent
 * needs no list. Library voices need a paid ElevenLabs plan: the agent keeps the provider's default voice as the
 * backup (pipeline.ts). Cartesia: none yet (no key to read its list); its default voice speaks the language.
 * English, and a language without an entry: providerDefaultVoices.
 */
export const languageDefaultVoices: Record<string, Readonly<Partial<Record<Language, LanguageDefaultVoice>>>> = {
  elevenlabs: {
    es: native('es', 'CaJslL1xziwefCeTNzHv', 'Cristina'),
    fr: native('fr', 'YxrwjAKoUKULGd0g8K9Y', 'Lucie'),
    de: native('de', 'v3V1d2rk6528UrLKRuy8', 'Susi'),
    it: native('it', '8KInRSd4DtD5L5gK7itu', 'Giusy'),
    pt: native('pt', 'GDzHdQOi6jjf8zaXhCYD', 'Raquel'),
    nl: native('nl', '94W4cf0CMSgymY1uoRiX', 'Noa'),
    ru: native('ru', '0ArNnoIAWKlT4WweaVMY', 'Elena'),
    hi: native('hi', 'diwmCoikrXSjiTKbIHz9', 'Devi'),
    ja: native('ja', '8EkOjt4xTPGMclNlh1pk', 'Morioki'),
    zh: native('zh', 'kGjJqO6wdwRN9iJsoeIC', 'Yui'),
    ko: native('ko', 'sf8Bpb1IU97NI9BHSMRf', 'Rosa'),
    pl: native('pl', '8EWWaNTDrqObI22Gvo1q', 'Aleksandra'),
    tr: native('tr', 'aEJD8mYP0nuof1XHShVY', 'Gözde'),
    // i18n-ignore: the voice's name at ElevenLabs, not text to translate
    vi: native('vi', 'Na15FlRRkMEDtEW4nVVP', 'Thanh Ngọc'),
    id: native('id', 'TrU3igk19A4aIUi2GAA2', 'Velora'),
    sv: native('sv', '4xkUqaR9MYOJHoaC1Nak', 'Sanna'),
    ar: native('ar', 'L10lEremDiJfPicq5CPh', 'Yasmine'),
    uk: native('uk', 'yMBZR4SLoc24wOJLWAB2', 'Solomiya'),
    ro: native('ro', 'neZC2DQ42NvDV1SyoMxN', 'Mirela'),
    cs: native('cs', 'mRIjyrAJVCSOEK5tjUFq', 'Michaela'),
    el: native('el', '4hx4668A4ljDTKS4m5oV', 'Chrysa'),
    da: native('da', 'gIfqD5jrnhkFu8ENVbXC', 'Isabella'),
    fi: native('fi', 'RiWFFlzYFZuu4lPMig3i', 'Soili'),
    no: native('no', 'BRY5wALXFkJsxVM6sEOH', 'Nadia'),
    hu: native('hu', 'bR5q7kmoRqfc9k9PnpVd', 'Martin', 'male'),
  },
  cartesia: {},
}

/** The language's own default voice at this provider (languageDefaultVoices), or null (English, none listed). */
export const languageDefaultOf = (provider: string, language: string | null | undefined): LanguageDefaultVoice | null =>
  (language && language !== 'en' ? languageDefaultVoices[provider]?.[language as Language] : undefined) ?? null

/** Whether the voice is one of the language defaults of this provider (an assistant may use it like a curated one). */
export const isLanguageDefaultVoice = (provider: string, voiceId: string) =>
  Object.values(languageDefaultVoices[provider] ?? {}).some(v => v?.id === voiceId)

/**
 * The voice id a call speaks with when the assistant picked none: its main language's default voice at the provider
 * (languageDefaultVoices), else the provider's default (providerDefaultVoices).
 */
export const defaultVoiceFor = (provider: string, language?: string | null): string | undefined =>
  languageDefaultOf(provider, language)?.id ?? providerDefaultVoices[provider]

/**
 * The voice after the assistant's main language changed from `from` to `to`, or null to keep it. Only an untouched
 * default moves: the default voice of the old language (languageDefaultVoices) becomes the new language's, or the
 * provider's default ('') when it has none. A voice picked by name, a clone and '' (which follows the language on its
 * own, defaultVoiceFor) stay. The voice model stays with it.
 */
export function followLanguageDefault<V extends { provider: string; voice_id: string }>(
  voice: V,
  from: string | null | undefined,
  to: string | null | undefined,
): V | null {
  if (!voice.voice_id || from === to) return null
  if (languageDefaultOf(voice.provider, from)?.id !== voice.voice_id) return null
  const next = languageDefaultOf(voice.provider, to)?.id ?? ''
  return next === voice.voice_id ? null : { ...voice, voice_id: next }
}

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
   * picked for every workspace. Missing
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
  /**
   * Call quality: the levels this server has on, with their price and models, the level new
   * assistants start on, and whether this member may raise an assistant to a paid level.
   */
  callQuality: CallQualityOptions
}

export const voiceOptions = defineAction({
  name: 'voice.options',
  description:
    "The voices an assistant can use with the text-to-speech provider in effect: curated voices, the workspace's cloned voices, and whether it can clone one. `callQuality`: the call qualities (standard, premium, ultra) this server has on, each with its price a minute in US cents (null where no prices are shown), the models that belong to it (language models, voice models per voice provider, realtime models on Ultra) and what its default stands for; `defaultLevel` (new assistants start on it), `mayChange` (whether you may change an assistant's level and models at all; false in a white-label client whose partner keeps call quality) and `mayRaise` (whether you may pick a paid level for an assistant).",
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
  /** Why the list could not be read (the web app words it per reader); null when it was read or there is no key. */
  error: ProviderFailureReason | null
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
