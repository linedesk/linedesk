import {
  AI_DISCLOSURE_MODES,
  BEHAVIOUR_IDS,
  type BehaviourId,
  COMMUNICATION_STYLES,
  REMOVED_BEHAVIOUR_IDS,
} from './assistant-prompt.ts'
import type { Closure, HolidayCalendar } from '@linedesk/db/types'
import { z } from 'zod'
import { ASSISTANT_CALL_MAX_MINUTES } from './calls.ts'
import { buyableAreaCode } from './area-codes.ts'
import { defineAction } from './define.ts'
import { emailRulesInput } from './email-routing.ts'
import { english, type Words } from './words.ts'
import { JOB_VALUE_MAX_CENTS, type JobValueCurrency, jobValueCurrencies } from './insights.ts'
import { assistantLanguages } from './languages.ts'
import { type WorkspaceCountrySource, workspaceCountrySchema } from './workspace-locale.ts'
import { transferContacts } from './transfer.ts'
import { CALL_QUALITIES, type CallQuality, type CallQualitySettings, type ModelChoice } from './usage-level.ts'
import { realtimeVoiceChoice, voiceId } from './voices.ts'
import type { ProviderName, WorkspaceDeleteData } from './admin.ts'

/** The longest voice or language model id an assistant can name. */
export const VOICE_MODEL_ID_MAX = 100

const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

export const contactUpdate = defineAction({
  name: 'contact.update',
  description: 'Update a contact.',
  input: z.object({
    contactId: z.string().min(1),
    name: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  }),
  permission: 'contact:write',
  public: true,
  // A name a member writes (or saves again as it is: confirming a caller's) is the team's (contacts.name_source).
  patch: {
    table: 'contacts',
    id: i => i.contactId,
    set: ({ contactId: _id, ...rest }) => ({
      ...defined(rest),
      ...(rest.name !== undefined && { name_source: rest.name?.trim() ? ('member' as const) : null }),
    }),
  },
})

const contactId = z.object({ contactId: z.string().min(1) })

/** Calls from a blocked number are not answered: call.start files them quietly in Spam and tells the agent to hang up. */
export const contactBlock = defineAction({
  name: 'contact.block',
  description: 'Block a caller: calls from their number are not answered and are filed in Spam.',
  input: contactId,
  permission: 'contact:write',
  public: true,
  destructive: true,
  patch: { table: 'contacts', id: i => i.contactId, set: (_i, now) => ({ blocked_at: now }) },
})

export const contactUnblock = defineAction({
  name: 'contact.unblock',
  description: 'Unblock a caller: their calls are answered again.',
  input: contactId,
  permission: 'contact:write',
  public: true,
  patch: { table: 'contacts', id: i => i.contactId, set: () => ({ blocked_at: null }) },
})

/** Longest text contact.create and contact.import keep per field; the browser cuts longer values from a file to these. */
export const CONTACT_IMPORT_LIMITS = { name: 200, company: 200, email: 254, address: 500, note: 2000 } as const

const createdText = (max: number) => z.string().trim().min(1).max(max).optional()

/**
 * Add someone by hand, with every detail a contact has. A number that belonged to a deleted contact
 * brings that contact back (with its calls).
 */
export const contactCreate = defineAction({
  name: 'contact.create',
  description:
    'Add a contact by hand: a phone number in E.164 (+15035550100), and optionally a name, company, email, address and note.',
  input: z.object({
    phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'a phone number in E.164, like +15035550100'),
    name: createdText(CONTACT_IMPORT_LIMITS.name),
    company: createdText(CONTACT_IMPORT_LIMITS.company),
    email: createdText(CONTACT_IMPORT_LIMITS.email),
    address: createdText(CONTACT_IMPORT_LIMITS.address),
    note: createdText(CONTACT_IMPORT_LIMITS.note),
  }),
  permission: 'contact:write',
  public: true,
})

/** Most rows one contact.import takes; the browser sends a longer file in parts. */
export const CONTACT_IMPORT_MAX_ROWS = 500

const importText = (max: number) => z.string().trim().max(max).optional()

/**
 * Contacts from a file (Contacts › Import). A row whose number or email is already a contact fills
 * that contact's empty fields and changes nothing else; the rest become new contacts.
 */
export const contactImport = defineAction({
  name: 'contact.import',
  description:
    'Add contacts from a list. A row with the number or email of an existing contact only fills its empty fields; numbers in E.164.',
  input: z.object({
    rows: z
      .array(
        z.object({
          phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'a phone number in E.164, like +15035550100'),
          name: importText(CONTACT_IMPORT_LIMITS.name),
          company: importText(CONTACT_IMPORT_LIMITS.company),
          email: importText(CONTACT_IMPORT_LIMITS.email),
          address: importText(CONTACT_IMPORT_LIMITS.address),
          note: importText(CONTACT_IMPORT_LIMITS.note),
        }),
      )
      .min(1)
      .max(CONTACT_IMPORT_MAX_ROWS),
  }),
  permission: 'contact:write',
  logged: 'ids',
})

const mergedField = z.string().trim().max(2000).nullable()

/**
 * Two contacts that are one person: `mergeId` goes into `keepId`. The kept contact gets the values
 * given (the ones the member picked from either), the other one's calls and bookings move to it, and
 * the other one leaves Contacts; a later call from its number lands on the kept contact.
 */
export const contactMerge = defineAction({
  name: 'contact.merge',
  description:
    "Merge two contacts that are one person: the second one's calls move to the first, which keeps the given details.",
  input: z.object({
    keepId: z.string().min(1),
    mergeId: z.string().min(1),
    name: mergedField.optional(),
    company: mergedField.optional(),
    email: mergedField.optional(),
    address: mergedField.optional(),
    note: mergedField.optional(),
  }),
  permission: 'contact:write',
  // The merged details stay on the contact; the command log keeps only the two ids.
  logged: 'ids',
})

/** `data` of contact.import. `skipped`: rows whose number belongs to a deleted contact. */
export type ContactImportData = { created: number; updated: number; unchanged: number; skipped: number }

/** Contacts leave the list but keep their calls; contact.restore undoes it. */
export const contactDelete = defineAction({
  name: 'contact.delete',
  description: 'Delete a contact. Their calls stay in the inbox, shown by number.',
  input: contactId,
  permission: 'contact:write',
  public: true,
  destructive: true,
  patch: { table: 'contacts', id: i => i.contactId, set: (_i, now) => ({ deleted_at: now }) },
})

export const contactRestore = defineAction({
  name: 'contact.restore',
  description: 'Bring back a deleted contact.',
  input: contactId,
  permission: 'contact:write',
  public: true,
  patch: { table: 'contacts', id: i => i.contactId, set: () => ({ deleted_at: null }) },
})

/** Longest free-text instructions an assistant takes (characters). */
export const INSTRUCTIONS_MAX = 20_000

/**
 * Silence on the line: after a quiet gap the assistant asks "Are you still there?", again after the same gap, for the
 * number of reminders; at the hang-up time it says the closing line and hangs up. Never during a transfer.
 * The defaults ask at 8 and 16 seconds of silence and hang up at 24 (5 s cut in on callers who were still thinking).
 */
export const SILENCE_FIRST_GAP_DEFAULT_S = 8
export const SILENCE_FIRST_GAP_MIN_S = 4
export const SILENCE_FIRST_GAP_MAX_S = 30
export const SILENCE_REMINDERS_DEFAULT = 2
export const SILENCE_REMINDERS_MAX = 4
export const SILENCE_HANG_UP_DEFAULT_S = 24
export const SILENCE_HANG_UP_MAX_S = 120
export const SILENCE_CLOSING_MAX = 200
export const DEFAULT_SILENCE_CLOSING =
  "I can't hear anyone on the line, so I'll hang up now. Please call us back anytime."
/**
 * How fast the assistant talks (Settings › Assistant › Advanced), in percent of the voice's own pace: any whole
 * number from MIN to MAX, 100 is the voice's own pace. Both voice providers take 0.8–1.2.
 */
export const TALKING_SPEED_PCT_MIN = 80
export const TALKING_SPEED_PCT_MAX = 120
export const TALKING_SPEED_PCT_DEFAULT = 100
/** The three speeds of the release before (the `talking_speed` column), still kept in step with the percentage. */
export const TALKING_SPEEDS = ['slow', 'normal', 'fast'] as const
export type TalkingSpeed = (typeof TALKING_SPEEDS)[number]
/** What slow and fast were in percent (the voice agent's 0.9 and 1.1). */
const PCT_OF_SPEED: Record<TalkingSpeed, number> = { slow: 90, normal: 100, fast: 110 }
/** The old speed nearest to a percentage, for the release before. */
export const talkingSpeedNear = (pct: number): TalkingSpeed => (pct <= 95 ? 'slow' : pct >= 105 ? 'fast' : 'normal')

type TalkingSpeedFields = { talking_speed_pct?: number | null; talking_speed?: TalkingSpeed | null }
/** An assistant's talking speed in percent; a row or version from before percentages: from its old speed. */
export const talkingSpeedPctOf = (a: TalkingSpeedFields | null | undefined): number =>
  a?.talking_speed_pct ?? PCT_OF_SPEED[a?.talking_speed ?? 'normal'] ?? TALKING_SPEED_PCT_DEFAULT
/** The talking speed in a few words: "Normal", "8% slower", "15% faster". */
export function talkingSpeedLabel(pct: number): string {
  if (pct === TALKING_SPEED_PCT_DEFAULT) return 'Normal'
  return pct < TALKING_SPEED_PCT_DEFAULT
    ? `${TALKING_SPEED_PCT_DEFAULT - pct}% slower`
    : `${pct - TALKING_SPEED_PCT_DEFAULT}% faster`
}
/** An update's speed in both columns: a percentage sets the nearest old speed; an old speed (the web app before) its percentage. */
function talkingSpeedColumns(input: TalkingSpeedFields): { talking_speed_pct?: number; talking_speed?: TalkingSpeed } {
  if (input.talking_speed_pct != null)
    return { talking_speed_pct: input.talking_speed_pct, talking_speed: talkingSpeedNear(input.talking_speed_pct) }
  if (input.talking_speed != null)
    return { talking_speed: input.talking_speed, talking_speed_pct: PCT_OF_SPEED[input.talking_speed] }
  return {}
}

/**
 * How an assistant's calls are answered: a realtime model (speech to speech), or three stages (speech to text,
 * language model, voice). Instance admins set each up under Server admin › Providers; each assistant picks one.
 */
export const VOICE_PIPELINES = ['realtime', 'three_stage'] as const
export type VoicePipeline = (typeof VOICE_PIPELINES)[number]
export const VOICE_PIPELINE_LABELS: Record<VoicePipeline, string> = {
  realtime: 'Realtime model',
  three_stage: 'Speech to text, model and voice',
}
/** What each pipeline does, in words for someone who has never heard of either. */
export const VOICE_PIPELINE_DESCRIPTIONS: Record<VoicePipeline, string> = {
  realtime:
    'One AI model hears the caller and speaks its reply itself, in the voice of the model you pick. The fastest, most natural conversation.',
  three_stage:
    "The caller's words are written out, a language model writes the reply, and the voice you pick reads it out. A moment slower, with every voice of your voice providers.",
}
/** Which pipelines the install has set up. */
export type PipelinesSetUp = Record<VoicePipeline, boolean>

/**
 * Call quality (decision of 2026-11-17, Server admin › Providers › Call quality): which levels assistants can pick
 * (Standard always; Ultra needs a realtime model), the level new assistants start on, and the models per level an
 * assistant without its own pick uses.
 */
export const callQualityGet = defineAction({
  name: 'callQuality.get',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "The install's call quality settings: whether Premium and Ultra can be picked (`premium`, `ultra`; Standard always can, Ultra only with a realtime model connected), the level new assistants start on (`default`), the stored default models per level, and per level the models that belong to it and what its default stands for.",
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})
const levelModelsInput = z.object({
  llm: z.string().trim().min(1).max(VOICE_MODEL_ID_MAX).nullable().optional(),
  voice: z.record(z.string(), z.string().trim().min(1).max(VOICE_MODEL_ID_MAX).nullable()).optional(),
  stt: z.string().trim().min(1).max(VOICE_MODEL_ID_MAX).nullable().optional(),
})
export const callQualitySet = defineAction({
  name: 'callQuality.set',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "Change the install's call quality settings. `premium` / `ultra`: whether assistants can pick the level; turning one off moves every assistant on it to Standard at once (the result lists them under `moved`). `restore`: undo of that, within 24 hours of the turn-off and once: the listed assistants, each one that turn-off moved (others are refused) and still on Standard, go back to `level`, which must be on. `default`: the level new assistants start on (one that is on; existing assistants keep theirs). `models`: the default models per level (`standard`/`premium`: `llm` at the install's language-model provider, `voice` per voice provider, `stt` speech recognition; `ultra`: `realtime`); each must belong to its level, null goes back to the built-in default. Assistants without their own pick use them from their next call on; the price stays the level's.",
  input: z.object({
    premium: z.boolean().optional(),
    ultra: z.boolean().optional(),
    default: z.enum(CALL_QUALITIES).optional(),
    models: z
      .object({
        standard: levelModelsInput.optional(),
        premium: levelModelsInput.optional(),
        ultra: z
          .object({ realtime: z.string().trim().min(1).max(VOICE_MODEL_ID_MAX).nullable().optional() })
          .optional(),
      })
      .optional(),
    restore: z
      .object({ level: z.enum(['premium', 'ultra']), assistantIds: z.array(z.string().min(1)).max(10_000) })
      .optional(),
  }),
  permission: 'instance:admin',
})
/** One level as Server admin › Providers › Call quality shows it: what belongs to it and what its default stands for. */
export type CallQualityAdminLevel = {
  level: CallQuality
  /** The server admin has it on and it can answer (Ultra: a realtime model is connected). */
  enabled: boolean
  models: ModelChoice[]
  voiceModels: Record<string, ModelChoice[]>
  realtimeModels: ModelChoice[]
  /** The speech recognition models of the install's speech recognition provider (none on Ultra: realtime hears itself). */
  sttModels: ModelChoice[]
  defaults: { llm: string | null; voice: Record<string, string>; realtime: string | null; stt: string | null }
}
/** `data` of `callQuality.get` and `callQuality.set`. `centsPerMinute`: null on an install that does not bill. */
export type CallQualityAdminData = {
  settings: CallQualitySettings
  realtimeSetUp: boolean
  centsPerMinute: Record<CallQuality, number> | null
  llmProvider: string | null
  /** The install's speech recognition provider (null: none set up). */
  sttProvider: string | null
  levels: CallQualityAdminLevel[]
  /** callQuality.set: the assistants a level turned off moved to Standard, per level (for Undo). */
  moved?: { level: 'premium' | 'ultra'; assistantIds: string[] }[]
}

/**
 * After-call transcription (apps/api/src/after-call-transcript.ts): once a call's recording is saved, it is uploaded
 * to the transcription provider an instance admin selected (Server admin › Providers › After-call transcription) and
 * the caller's lines are replaced with what it heard. Off until an admin selects one.
 */
export const transcriptProviders = [
  'openai_transcript',
  'deepgram_transcript',
  'assemblyai',
  'elevenlabs_transcript',
] as const satisfies readonly ProviderName[]
export type TranscriptProviderName = (typeof transcriptProviders)[number]
/** The model each one uses. */
export const transcriptModels: Record<TranscriptProviderName, string> = {
  openai_transcript: 'gpt-transcribe',
  deepgram_transcript: 'nova-3',
  assemblyai: 'universal',
  elevenlabs_transcript: 'scribe_v2',
}

export const afterCallTranscriptGet = defineAction({
  name: 'afterCallTranscript.get',
  description:
    'The transcription providers for finished calls: which one is selected (none: off), which are connected, and which can use a key already saved for an active provider.',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})
export const afterCallTranscriptSet = defineAction({
  name: 'afterCallTranscript.set',
  description:
    'Select the provider that transcribes each finished call again from its recording (the recording file is uploaded to it), or null to turn it off. A provider without a key of its own uses the key saved for the active provider of the same service (OpenAI language model or realtime model, Deepgram or ElevenLabs).',
  input: z.object({ provider: z.enum(transcriptProviders).nullable() }),
  permission: 'instance:admin',
})
/**
 * One transcription provider: `in_use` (selected), `connected` (has a key, its own or linked), `reusable` (a key
 * saved for the active provider `reuseFrom` can be used with one click) or `none` (connect it with its key).
 */
export type AfterCallTranscriptOption = {
  provider: TranscriptProviderName
  model: string
  state: 'in_use' | 'connected' | 'reusable' | 'none'
  reuseFrom: ProviderName | null
}
/** `data` of `afterCallTranscript.get` and `.set`. `recording`: a recording store is in use (else nothing to hear). */
export type AfterCallTranscriptData = {
  selected: TranscriptProviderName | null
  recording: boolean
  options: AfterCallTranscriptOption[]
}

/**
 * The pipeline that answers an assistant's calls: its choice (null: the install default, the realtime model when one
 * is set up) when that one is set up, else the other one when that is. With neither set up: the choice.
 */
export function pipelineFor(choice: VoicePipeline | null | undefined, setUp: PipelinesSetUp): VoicePipeline {
  const wanted = choice ?? (setUp.realtime ? 'realtime' : 'three_stage')
  if (setUp[wanted]) return wanted
  const other: VoicePipeline = wanted === 'realtime' ? 'three_stage' : 'realtime'
  return setUp[other] ? other : wanted
}

/** The closing line an assistant says: its own, or the default. */
export const silenceClosingOf = (stored: string | null | undefined) => stored?.trim() || DEFAULT_SILENCE_CLOSING
/** Said when the caller has nothing else and the assistant hangs up (end_call), unless the owner wrote another line (`goodbye_line`). */
export const DEFAULT_GOODBYE_LINE = 'Thanks for calling. Goodbye!'
/** The owner's goodbye line, or null: the default in the language spoken at that moment. */
export const goodbyeLineOf = (stored: string | null | undefined) => stored?.trim() || null
/** Asked when the line is quiet, unless the owner wrote another line (`silence_reminder`). */
export const DEFAULT_SILENCE_REMINDER = 'Are you still there?'
/** The reminder an assistant asks: its own, or the default. */
export const silenceReminderOf = (stored: string | null | undefined) => stored?.trim() || DEFAULT_SILENCE_REMINDER

export const assistantUpdate = defineAction({
  name: 'assistant.update',
  description:
    "Update the assistant: name, greeting, voice, whether calls are recorded, what it knows about the business, how fast it talks (`talking_speed_pct`: 80-120 percent of the voice's own pace, 100: its own pace), what it asks when the line is quiet (`silence_reminder`, null: the default) and says before hanging up (`silence_closing`), the longest it stays on a call (`max_call_minutes`). `greeting_outside` is used outside business hours when the workspace uses them (null: the same as during hours). `transfers` replaces the list of transfer contacts: who callers are put through to (a landline or mobile in E.164 in a country the workspace may call, see outbound.countries; null while there is none) and when (`condition`, in plain words), tried in list order when several fit; `hours_only` only while the business is open; `ring_seconds` (10-60); `if_no_answer`: message_urgent, message or next (the next contact that fits). `briefing` (default true): an AI voice first tells the person who is calling and they take the call or not; false: the caller is put straight through once the phone is answered (no way to decline, and a voicemail that answers gets the caller). `languages`: `main` (the language it greets and speaks in; missing: the workspace language, English for a workspace in the US or a country whose language calls cannot be answered in) and `mode`: `english` (the main language only, the default; the name is from before the main language could be picked), `allowed` (the main language plus the `allowed` codes) or `any`; the assistant switches to the language the caller speaks only when it is allowed, the greeting stays in the main language. `behaviours` sets switches of the behaviour checklist (ask_name, offer_callback, confirm_number); `ai_disclosure`: whether and when it mentions being an AI (never_confirm: not even when asked, it neither confirms nor denies it; never; when_asked; at_start, the default; at_start_consent: says it and asks whether that is okay); it never claims to be human, and in every mode but never_confirm it says it is an AI when asked. `communication_style`: the tone (standard, professional, casual, formal, empathetic). `call_quality`: `standard`, `premium` or `ultra` (voice.options `callQuality` lists the levels this server has on, with their price a minute where there are prices); the level alone decides what a call minute costs; Standard and Premium answer with speech to text, a language model and the assistant's voice, Ultra with a realtime model in its own voice. A workspace owner or admin, signed in to the app (not through an API key or personal key), raises the level; anyone who edits the assistant lowers it. In a white-label client the partner's team changes it, and the client's own owner and admins only where the partner lets them (voice.options `callQuality.mayChange`). Picks that do not belong to a new level are cleared in the same save. `realtime_voice`: the voice while the realtime model answers its calls, one of the realtime voices (REALTIME_VOICE_IDS: marin and cedar, which OpenAI recommends, alloy, ash, ballad, coral, echo, sage, shimmer, verse); '' (the default): marin. `voice` is the voice of the three stages; each keeps its own. `voice.model` picks the voice model and `llm_model` the language model (as the server's language-model provider names it, e.g. gpt-4.1-mini), `realtime_model` the realtime model on Ultra (gpt-realtime, gpt-realtime-2); each must belong to the assistant's level (Standard: Standard models; Premium: Premium and Standard ones; voice.options `callQuality` lists them per level) and null or missing follows the server's default for the level. `email_rules`: who gets the email about each finished call (emailRouting.get lists the members). `always`: members (user ids) who get every call email. `rules`, in order, each with `id`, `when` (the calls it is about, in plain words, e.g. 'Calls about water heaters or boilers'), `to` (members who get the email) and `assign` (one of `to` who gets the call assigned while nobody has it, or null). Rules are on only when a language model is set up (emailRouting.available); without one they are ignored. After each call the model only says which rules fit; the members of every rule that fits and the `always` members get the email, and the first fitting rule with an assignee assigns it. No rule fits: the `always` members, or without them every member with call emails on. No rules and no `always`: every member with call emails on. At most 20 rules.",
  input: z.object({
    assistantId: z.string().min(1),
    name: z.string().trim().min(1).max(60).optional(),
    greeting: z.string().optional(),
    /** Whether and when the assistant mentions it is an AI: never_confirm, never, when_asked, at_start (default), at_start_consent. */
    ai_disclosure: z.enum(AI_DISCLOSURE_MODES).optional(),
    /** The tone it uses: standard (default), professional, casual, formal, empathetic. */
    communication_style: z.enum(COMMUNICATION_STYLES).optional(),
    /** Used outside business hours, when the workspace uses them; null: the same as during hours. */
    greeting_outside: z.string().nullable().optional(),
    record_calls: z.boolean().optional(),
    /** The whole ordered list of transfer contacts. */
    transfers: transferContacts.optional(),
    /**
     * Silence on the line (SILENCE_*): seconds of silence before "Are you still there?" and between two of them, how
     * many, the seconds of silence at which it says the closing line (null: default) and hangs up.
     */
    silence_first_gap_s: z.number().int().min(SILENCE_FIRST_GAP_MIN_S).max(SILENCE_FIRST_GAP_MAX_S).optional(),
    silence_reminders: z.number().int().min(0).max(SILENCE_REMINDERS_MAX).optional(),
    silence_hang_up_s: z.number().int().min(SILENCE_FIRST_GAP_MIN_S).max(SILENCE_HANG_UP_MAX_S).optional(),
    /** The longest the assistant stays on a call, in minutes (at most ASSISTANT_CALL_MAX_MINUTES); then it says goodbye and hangs up. */
    max_call_minutes: z.number().int().min(1).max(ASSISTANT_CALL_MAX_MINUTES).optional(),
    silence_closing: z.string().trim().max(SILENCE_CLOSING_MAX).nullable().optional(),
    /** Asked when the line is quiet; null: "Are you still there?" in the language spoken. */
    silence_reminder: z.string().trim().max(SILENCE_CLOSING_MAX).nullable().optional(),
    /** Said when the caller has nothing else and the assistant hangs up; null: "Thanks for calling. Goodbye!" in the language spoken. */
    goodbye_line: z.string().trim().max(SILENCE_CLOSING_MAX).nullable().optional(),
    /** How fast it talks, in percent of the voice's own pace (TALKING_SPEED_PCT_MIN to MAX, 100: its own pace). */
    talking_speed_pct: z.number().int().min(TALKING_SPEED_PCT_MIN).max(TALKING_SPEED_PCT_MAX).optional(),
    /** Replaced by talking_speed_pct; still taken from a web app of the release before. */
    talking_speed: z.enum(TALKING_SPEEDS).optional(),
    /** The behaviour checklist: the switches the owner changed (BEHAVIOURS); a missing one uses its default. */
    behaviours: z
      .partialRecord(z.enum([...BEHAVIOUR_IDS, ...REMOVED_BEHAVIOUR_IDS]), z.boolean())
      .transform(
        b =>
          Object.fromEntries(
            Object.entries(b).filter(([id]) => (BEHAVIOUR_IDS as readonly string[]).includes(id)),
          ) as Partial<Record<BehaviourId, boolean>>,
      )
      .optional(),
    /** The assistant's main language and which languages it speaks with callers besides it. */
    languages: assistantLanguages.optional(),
    /**
     * The assistant's call quality (CALL_QUALITIES): what its calls cost a minute and what answers them. Raising it is
     * for a workspace owner or admin (apps/api/src/level-raise.ts).
     */
    call_quality: z.enum(CALL_QUALITIES).optional(),
    /**
     * An empty voice_id: the provider's default voice. `model`: the text-to-speech model (VOICE_MODEL_LEVELS); missing
     * or '': the install's model.
     */
    voice: z
      .object({
        provider: z.string(),
        voice_id: z.union([z.literal(''), voiceId]),
        model: z.string().trim().max(VOICE_MODEL_ID_MAX).optional(),
      })
      .optional(),
    /**
     * Who gets the email about each finished call: `always` members and the rules (name, when, to, assign), saved
     * normalized (an `assign` not among the rule's `to` becomes null). Empty: every member with call emails on.
     */
    email_rules: emailRulesInput.optional(),
    /** The language model of live turns at the install's provider (LANGUAGE_MODEL_LEVELS); null: the level's default. */
    llm_model: z.string().trim().min(1).max(VOICE_MODEL_ID_MAX).nullable().optional(),
    /** The voice while the realtime model answers its calls (REALTIME_VOICE_IDS); '': marin (REALTIME_DEFAULT_VOICE). */
    realtime_voice: realtimeVoiceChoice.optional(),
    /** The realtime model that answers its calls on Ultra (REALTIME_MODEL_LEVELS); null: the server's default for Ultra. */
    realtime_model: z.string().trim().min(1).max(VOICE_MODEL_ID_MAX).nullable().optional(),
    business_profile: z
      .object({
        instructions: z.string().max(INSTRUCTIONS_MAX).optional(),
        description: z.string().optional(),
        services: z.array(z.string()).optional(),
        service_area: z.string().optional(),
        address: z.string().optional(),
        hours: z.string().optional(),
        website: z
          .string()
          .trim()
          .max(2000)
          .refine(w => !businessWebsiteProblem(w), english.t('common.business.problem.website'))
          .optional(),
        /** The business's own number as its listing gives it (business.import) or the owner types it. */
        phone: z
          .string()
          .trim()
          .max(40)
          .refine(p => !businessPhoneProblem(p), english.t('common.business.problem.phone'))
          .optional(),
      })
      .optional(),
  }),
  permission: 'settings:write',
  patch: {
    table: 'assistants',
    id: i => i.assistantId,
    set: ({ assistantId: _id, ...rest }) => defined({ ...rest, ...talkingSpeedColumns(rest) }),
  },
})

/** A workspace can have several assistants; each phone number names the one that answers it. */
export const assistantCreate = defineAction({
  name: 'assistant.create',
  description:
    'Add an assistant to the workspace, with a fresh name and greeting. With `copyOf`, a copy of that assistant of the workspace (its greeting, instructions and voice; its transfer contacts start from the default). Numbers keep their assistant: assign one with phoneNumber.update.',
  input: z.object({
    name: z.string().trim().min(1).max(60).optional(),
    copyOf: z.string().min(1).optional(),
  }),
  permission: 'settings:write',
})
/** `data` of `assistant.create`. */
export type AssistantCreateData = { assistantId: string }

export const assistantDelete = defineAction({
  name: 'assistant.delete',
  description:
    "Delete an assistant of the workspace. Its phone numbers are answered by the workspace's first remaining assistant. The last assistant cannot be deleted.",
  input: z.object({ assistantId: z.string().min(1) }),
  permission: 'settings:write',
})

/** How long recordings may be kept; null keeps them until the call is deleted. */
/**
 * Days a recording is kept. 0: not kept at all; the voice agent does not record (the transcript and summary
 * come from live speech recognition), and a recording made anyway is deleted right after the call.
 */
export const RECORDINGS_NOT_KEPT = 0
export const recordingRetentionChoices = [RECORDINGS_NOT_KEPT, 30, 60, 90, 180, 365] as const
export const DEFAULT_RECORDING_RETENTION_DAYS = 90

/** What the assistant says after the greeting when the recording notice is on and the owner wrote nothing else. */
export const DEFAULT_RECORDING_NOTICE = 'This call may be recorded and transcribed.'
export const RECORDING_NOTICE_MAX = 200

/** `data` of `workspace.getSettings`. */
export type BusinessHoursSpan = { weekday: number; start: string; end: string }
/** `data` of `workspace.getSettings`. `businessHours` empty: no hours set (the assistant says nothing about them). */
/** `recordingOn`: this server records calls (a recording store is picked under Providers, or RECORDING_STORE names one; the voice agent gets the same setting). */
/** `businessHoursOn`: the workspace uses its hours for calls (off by default). */
/** `recordingNoticeOn`, `recordingNotice`: the sentence the assistant says right after the greeting (on by default). */
export type WorkspaceSettingsData = {
  recordingRetentionDays: number | null
  recordingNoticeOn: boolean
  recordingNotice: string
  timeZone: string
  /** The time zone follows the country (moves into it when the country changes); false: set by hand. Missing from an older API. */
  timeZoneFollowsCountry?: boolean
  /** The main time zone of the country in use ("Use country default"); null: none known. Missing from an older API. */
  countryTimeZone?: string | null
  businessHours: BusinessHoursSpan[]
  businessHoursOn: boolean
  recordingOn: boolean
  /** The owner's own closed days (availability_exceptions, source `own`), by date; missing from an older API. */
  closedDays?: ClosedDay[]
  /** The public holiday calendar; null: never set up. Missing from an older API. */
  holidays?: HolidayCalendar | null
  /** From today: the days the holiday calendar and the yearly own days close, by date. Missing from an older API. */
  derivedDays?: DerivedDay[]
  /** Vacation or closure mode; null: off. Missing from an older API. */
  closure?: Closure | null
  /** The value of one booked appointment in the minor units of its currency (cents; whole units for JPY, KRW and CLP), for Insights; null: not set. */
  jobValueCents: number | null
  /** The currency of jobValueCents. Missing from an older API: USD. */
  jobValueCurrency?: JobValueCurrency
  /** The currency follows the country; false: picked by hand. Missing from an older API. */
  jobValueCurrencyFollowsCountry?: boolean
  /** The currency of the country in use ("Use country default"); null: one Insights does not offer. Missing from an older API. */
  countryCurrency?: JobValueCurrency | null
  /** When the assistant picks up, as chosen in onboarding; null: never chosen. Missing from an older API. */
  pickupMode?: PickupMode | null
  /** The country the owner set (ISO 3166-1 alpha-2); null: automatic. Missing from an older API. */
  country?: string | null
  /** The country in use: the one set, else worked out (resolveWorkspaceCountry). Missing from an older API: US. */
  resolvedCountry?: string
  /** Where resolvedCountry came from. */
  countrySource?: WorkspaceCountrySource
  /**
   * The countries this workspace may be in (a workspace on a Linedesk Cloud bill: the sign-up countries); null or
   * missing: every country.
   */
  servedCountries?: readonly string[] | null
  /** The workspace language: the main language of the country in use (resolveWorkspaceLanguage; may be one calls are not answered in). */
  resolvedLanguage?: string
  /** This install bills usage: voices and models have a level with a price a minute. */
  usageLevels: boolean
  /** The install's price of a call minute per level, in US cents (Server admin › Billing); absent from an older server. */
  usageCentsPerMinute?: { standard: number; premium: number; ultra: number }
  /**
   * A white-label client (docs/white-label.md): its people see minutes, never Linedesk's prices, so
   * `usageCentsPerMinute` is absent; and its partner's owner picks Premium or Ultra for its assistants, not its own owner.
   */
  partnerManaged?: boolean
}

/**
 * When the assistant picks up (onboarding, "When should Maya pick up?"): calls the business doesn't answer
 * (conditional forwarding), every call (forwarding all), or only when closed (conditional forwarding plus hours).
 */
export const pickupModes = ['no_answer', 'always', 'after_hours'] as const
export type PickupMode = (typeof pickupModes)[number]

/**
 * An own closed day: closed all day (no times) or open only `start`–`end`; `yearly`: on this date every
 * year (missing from an older API: no).
 */
export type ClosedDay = { date: string; name: string; start: string | null; end: string | null; yearly?: boolean }

/**
 * A day closed by the holiday calendar (`holiday`, `key` the holiday's name) or a later year of an own yearly
 * day (`repeat`, `key` the date of the own day it repeats).
 */
export type DerivedDay = {
  date: string
  name: string
  start: string | null
  end: string | null
  source: 'holiday' | 'repeat'
  key: string
}

/** A real IANA time zone ("America/Los_Angeles"), as the server's and the browser's Intl know it. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-12-24')

/** Longest closure greeting. */
export const CLOSURE_GREETING_MAX = 600

export const closureSchema = z
  .object({
    from: isoDate,
    until: isoDate,
    greeting: z.string().trim().max(CLOSURE_GREETING_MAX),
  })
  .refine(c => c.until >= c.from, { message: 'the last day cannot be before the first' }) satisfies z.ZodType<Closure>

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'a time like 07:00')

export const businessHoursSet = defineAction({
  name: 'businessHours.set',
  description:
    'Set the business hours: per weekday (0 = Sunday … 6 = Saturday) when the office is open, wall-clock times in the workspace time zone. Replaces all hours; an empty list means no hours. The assistant uses them to tell callers whether the office is open and when someone calls back.',
  input: z.object({
    hours: z
      .array(
        z
          .object({ weekday: z.number().int().min(0).max(6), start: clockTime, end: clockTime })
          .refine(h => h.end > h.start, { message: 'end must be after start' }),
      )
      .max(21),
  }),
  permission: 'settings:write',
})

export const closedDaysSet = defineAction({
  name: 'closedDays.set',
  description:
    'Set the own closed days (holidays the business adds itself, closures): dates (YYYY-MM-DD, in the workspace time zone) when the business is closed all day, or open only `start`–`end`; `yearly` repeats a day on the same date every year. Replaces the whole own list; the public holidays are set with holidays.set. The assistant treats them as closed (or as those hours) and books no appointments outside them.',
  input: z.object({
    days: z
      .array(
        z
          .object({
            date: isoDate,
            name: z.string().trim().max(80).default(''),
            start: clockTime.nullable().default(null),
            end: clockTime.nullable().default(null),
            yearly: z.boolean().default(false),
          })
          .refine(d => (d.start === null) === (d.end === null) && (d.start === null || d.end! > d.start), {
            message: 'a day open part-time needs an end after its start',
          }),
      )
      .max(200),
  }),
  permission: 'settings:write',
})

const countryCode = z.string().regex(/^[A-Z]{2}$/, 'a country code like US')
const stateCode = z.string().regex(/^[A-Z0-9]{1,3}$/, 'a state code like CA')

export const holidaysSet = defineAction({
  name: 'holidays.set',
  description:
    'Set the public holiday calendar: `on`, the `country` (ISO 3166 code like "US") and `state` (like "CA", or null for the nationwide holidays only) whose holidays close the business every year; `off` the holidays (by name, from holidays.lookup) it is open on every year; `changes` single dates of this year that differ: `open` true, or open only `start`–`end`. Replaces the whole calendar. The days are kept for the next twelve months, every year.',
  input: z.object({
    on: z.boolean(),
    country: countryCode,
    state: stateCode.nullable().default(null),
    off: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
    changes: z
      .array(
        z
          .object({
            date: isoDate,
            name: z.string().trim().max(80).default(''),
            open: z.boolean().default(false),
            start: clockTime.nullable().default(null),
            end: clockTime.nullable().default(null),
          })
          .refine(c => c.open || (c.start !== null && c.end !== null && c.end > c.start), {
            message: 'a changed day is open, or open from a start to a later end',
          }),
      )
      .max(100)
      .default([]),
  }),
  permission: 'settings:write',
})

/** A country or one of its states (or regions), as the public-holiday import lists them. */
export type HolidayPlace = { code: string; name: string }

/** `data` of `holidays.lookup`: what the import offers for the picked country and state. */
export type HolidayLookupData = {
  countries: HolidayPlace[]
  /** The country looked up: the one asked for, else the workspace time zone's, else the US. */
  country: string
  /** Its states or regions; empty when it has none. */
  states: HolidayPlace[]
  state: string | null
  /** Each public holiday of the next twelve months once, by its next date: `key` its name every year. */
  holidays: { key: string; date: string; name: string }[]
}

export const holidaysLookup = defineAction({
  name: 'holidays.lookup',
  description:
    'Look up the public holidays of a country (ISO 3166 code like "US") and, optionally, one of its states or regions (like "CA"), from today for a year in the workspace time zone. Without a country it uses the one of the workspace time zone. Changes nothing: follow a calendar with holidays.set.',
  input: z.object({
    country: countryCode.optional(),
    state: stateCode.optional(),
  }),
  permission: 'call:read',
  readOnly: true,
})

export const workspaceGetSettings = defineAction({
  name: 'workspace.getSettings',
  description:
    'Read the workspace settings that are not synced to the browser: how many days call recordings are kept.',
  input: z.object({}),
  permission: 'call:read',
  readOnly: true,
})

export const workspaceUpdateSettings = defineAction({
  name: 'workspace.updateSettings',
  description:
    'Change workspace settings: `recordingRetentionDays` (0: no recordings are kept, calls are not recorded; 30, 60, 90, 180 or 365; null keeps recordings; older recordings are deleted by the daily cleanup), `businessHoursOn` (whether calls use the business hours; off: the assistant says nothing about hours), `recordingNoticeOn` (the assistant says a recording notice right after the greeting when the call is recorded; on by default), `recordingNotice` (that sentence, e.g. "This call may be recorded and transcribed."), `timeZone` (the IANA zone the business hours are in, e.g. "America/Los_Angeles"; set, it stays when the country changes; null: follows the country again, its main zone) and `jobValueCents` (what a booked appointment is worth on average, for Insights, in the minor units of its currency: cents, or whole units for JPY, KRW and CLP; null clears it), `jobValueCurrency` (its currency: ' +
    jobValueCurrencies.join(', ') +
    '; until picked, the currency of the workspace country, changing with it; null: follows the country again; changed without jobValueCents, the shown amount stays: $350 becomes ¥350); `country` (where the business is, ISO 3166-1 alpha-2 like "US"; null: automatic, from the assistant\'s number, the business phone or the holiday calendar, else US; the default country of phone numbers, the forwarding guide, the holidays and the currency, and the region phone numbers callers say are read in; its main language is what call summaries and messages for the team are written in, and what an assistant without a main language of its own greets in); `closure` (vacation or closure mode: closed from `from` to `until`, with its own `greeting`, and `transfers` none or urgent only; null: off); `pickupMode` (when the assistant picks up, as chosen in onboarding: no_answer, always or after_hours; it decides which forwarding code is shown, the routing itself stays with the number\'s mode and the business hours).',
  input: z.object({
    recordingRetentionDays: z.union([z.literal(recordingRetentionChoices), z.null()]).optional(),
    businessHoursOn: z.boolean().optional(),
    recordingNoticeOn: z.boolean().optional(),
    recordingNotice: z
      .string()
      .trim()
      .min(1, 'Write the sentence the assistant says.')
      .max(RECORDING_NOTICE_MAX)
      .optional(),
    /** Set by hand; null: follows the country again (its main time zone). */
    timeZone: z.string().refine(isTimeZone, 'a time zone like America/Los_Angeles').nullable().optional(),
    /** Vacation or closure mode; null turns it off. */
    closure: closureSchema.nullable().optional(),
    jobValueCents: z.number().int().min(0).max(JOB_VALUE_MAX_CENTS).nullable().optional(),
    /** Picked by hand; null: follows the country again. */
    jobValueCurrency: z.enum(jobValueCurrencies).nullable().optional(),
    pickupMode: z.enum(pickupModes).optional(),
    country: workspaceCountrySchema.nullable().optional(),
  }),
  permission: 'settings:write',
})

export const WORKSPACE_NAME_MAX = 80

/** Control characters (C0, DEL, C1), line and paragraph separators, and the bidi controls that reorder text. */
const unsafeNameChar = (c: number) =>
  c < 0x20 ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x061c ||
  c === 0x200e ||
  c === 0x200f ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069)

/**
 * A workspace (business) name, the same for creating a workspace and for workspace.rename: trimmed, 1 to 80
 * characters, one line, no control or bidi characters (it goes into emails, the menu and other members' screens).
 */
const isOneLineName = (name: string) => ![...name].some(ch => unsafeNameChar(ch.codePointAt(0)!))

export const workspaceName = z
  .string()
  .trim()
  .min(1, english.t('common.business.problem.nameEmpty'))
  .max(WORKSPACE_NAME_MAX, english.t('common.business.problem.nameTooLong', { max: WORKSPACE_NAME_MAX }))
  .refine(isOneLineName, english.t('common.business.problem.nameOneLine'))

/**
 * Why the business's phone in its profile is not a phone number, or null (empty is fine). As people and listings
 * write it ("(503) 555-0142", "+1 503-555-0142"): digits with spaces, dots, dashes, brackets and a leading +, 7 to 15
 * digits.
 */
export function businessPhoneProblem(phone: string, words: Words = english): string | null {
  const text = phone.trim()
  if (!text) return null
  const digits = text.replace(/\D/g, '').length
  return /^\+?[\d\s().-]+$/.test(text) && digits >= 7 && digits <= 15 ? null : words.t('common.business.problem.phone')
}

/** Why the business's website in its profile is not a website address, or null (empty is fine). */
export function businessWebsiteProblem(website: string, words: Words = english): string | null {
  const text = website.trim()
  if (!text) return null
  return /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(text)
    ? null
    : words.t('common.business.problem.website')
}

/** Why `name` is not a workspace name (the checks of `workspaceName`), in `words`, or null when it is one. */
export function workspaceNameProblem(name: unknown, words: Words = english): string | null {
  const text = typeof name === 'string' ? name.trim() : ''
  if (!text) return words.t('common.business.problem.nameEmpty')
  if (text.length > WORKSPACE_NAME_MAX)
    return words.t('common.business.problem.nameTooLong', { max: WORKSPACE_NAME_MAX })
  return isOneLineName(text) ? null : words.t('common.business.problem.nameOneLine')
}

export const workspaceRename = defineAction({
  name: 'workspace.rename',
  description:
    "Rename the workspace: `name` is the business name shown in the app (the workspace menu, emails). The assistant's greeting is changed separately with assistant.update.",
  input: z.object({
    name: workspaceName,
  }),
  permission: 'settings:write',
})

/**
 * What an owner must have done before deleting their workspace (apps/api/src/owner-step-up.ts): a sign-in in the
 * last few minutes, with their passkey when they have one. `passkey`: confirm with the passkey; `signIn`: sign in
 * again; null: nothing, the delete goes ahead.
 */
export type OwnerStepUp = 'passkey' | 'signIn'

/**
 * An owner deletes their own workspace (Workspace settings › Danger zone), like an instance admin's
 * workspace.delete: every row of it, its recordings, its numbers at the carrier. Only an owner, with a fresh sign-in
 * (OwnerStepUp); `name` is the workspace's name, typed to confirm. Every other member is emailed; members who
 * belong to no other workspace (and are not instance admins) lose their accounts, the owner too unless
 * `keepOwnAccount` (then they land on the no-workspace page).
 */
export const workspaceDeleteOwn = defineAction({
  name: 'workspace.deleteOwn',
  description:
    "Delete this workspace with all its data: calls, contacts, bookings, settings, members and invitations, recordings and phone numbers. Only an owner, signed in within the last 10 minutes (with their passkey when they have one). `name` is the workspace's name, typed to confirm. Every other member is emailed; members who belong to no other workspace lose their accounts, the owner too, unless keepAccounts is true (every account stays; they wait for an invitation) or keepOwnAccount is true (only the owner's stays).",
  input: z
    .object({
      name: z.string().trim().min(1).max(200),
      keepOwnAccount: z.boolean().optional(),
      keepAccounts: z.boolean().optional(),
    })
    .strict(),
  permission: 'workspace:own',
})
/**
 * What `workspace.deleteOwn` did, and the workspace the owner continues in (null: none is left).
 * `ownAccountDeleted`: the owner's account went with it; their session is gone.
 */
export type WorkspaceDeleteOwnData = WorkspaceDeleteData & {
  nextWorkspaceId: string | null
  ownAccountDeleted: boolean
}

/** What deleting this workspace would take with it, for the owner's confirmation dialog. Owners only. */
export const workspaceDeletePreview = defineAction({
  name: 'workspace.deletePreview',
  description:
    'What deleting this workspace would delete: calls, contacts, phone numbers, other members and the accounts that go with it. The owner only.',
  input: z.object({}),
  permission: 'workspace:own',
  readOnly: true,
})
/**
 * `data` of `workspace.deletePreview`. Numbers: `bought` were bought through the install's carrier account and are
 * released there; `attached` (brought, or in the workspace's own carrier account) stop reaching Linedesk and stay
 * the business's. `accountsDeleted`: members (besides the owner) who belong to no other workspace and are not
 * instance admins. `ownAccountDeleted`: the owner's own account goes too unless they keep it (this is their only
 * workspace and they are not an instance admin). `stepUp`: what the server asks for right now before it deletes.
 */
export type WorkspaceDeletePreviewData = {
  name: string
  calls: number
  contacts: number
  numbers: { bought: number; attached: number }
  otherMembers: number
  accountsDeleted: number
  ownAccountDeleted: boolean
  /** The workspace is the only one on a running Cloud plan: deleting it ends the plan at once, no refund (LIN-647). */
  planEnds: boolean
  stepUp: OwnerStepUp | null
}

export const phoneNumberModes = ['forward_conditional', 'forward_all', 'new', 'ported'] as const

/** Three digits of an area code a number can be bought in (AREA_CODES: US, Canada, Puerto Rico). */
const buyableAreaCodeInput = z
  .string()
  .regex(/^\d{3}$/)
  .refine(code => buyableAreaCode(code) !== undefined, {
    message: 'not an area code a number can be bought in (US, Canada, Puerto Rico)',
  })

export const phoneNumberSetup = defineAction({
  name: 'phoneNumber.setup',
  description:
    "Connect a phone number to the workspace and route its calls to the assistant. By default it attaches `e164`, a number that already exists in the carrier account, and buys nothing (in the install's account only an instance admin may). With `purchase: true` it buys `e164`, or the first free number in `areaCode`, which costs money; only a workspace in a country of the install's buy offers can buy (the US, Canada and Puerto Rico by area code; Germany in the area codes the server offers, such as 6221, where it has German numbers on), a number or an area code of its own country (none set yet: the country of the area code, which the number then sets); elsewhere attach a number the business already has. An area code is its digits without the trunk 0 (503, 6221). Where the offer is a national number without an area code, give neither `e164` nor `areaCode`: the first free number of the country is bought. Repeating it for the same number finishes a setup that failed halfway.",
  input: z
    .object({
      e164: z
        .string()
        .regex(/^\+[1-9]\d{6,14}$/)
        .optional(),
      /**
       * An area code of the workspace country's buy offer, without the trunk 0: three digits in the US, Canada and
       * Puerto Rico (AREA_CODES), the listed codes in Germany (`6221`). The server checks it against the offer.
       */
      areaCode: z
        .string()
        .regex(/^[1-9]\d{1,4}$/, english.t('server.api.areaCodeDigits'))
        .optional(),
      /** Buying is never implied: without this, a number that is not in the account is rejected. */
      purchase: z.boolean().default(false),
      /** How the business uses the number. Default: `new` for a bought number, `forward_conditional` for an attached one. */
      mode: z.enum(phoneNumberModes).optional(),
      /** The assistant that answers it (one of the workspace's). Default: the workspace's first. */
      assistantId: z.string().min(1).optional(),
    })
    .refine(i => i.e164 || i.areaCode || i.purchase, {
      message: 'give a number (e164), an area code, or purchase: true',
    })
    .refine(i => i.e164 || i.purchase, {
      message: 'an area code alone means buying a number: pass purchase: true, or give the number (e164) to attach',
    }),
  permission: 'settings:write',
})

/** `data` of `phoneNumber.listCarrierNumbers`. */
export type CarrierNumbersData = {
  /** The numbers in the carrier account that are not set up in Linedesk yet (E.164), sorted. */
  numbers: string[]
  /** The account has more numbers than one read lists: a number not shown can still be typed. */
  more: boolean
}

export const phoneNumberListCarrierNumbers = defineAction({
  name: 'phoneNumber.listCarrierNumbers',
  description:
    "List the numbers already in the workspace's carrier account (its own, else the install's) that are not set up in Linedesk yet, to pick one for `phoneNumber.setup`. One read at the carrier, free; buys nothing. Numbers in the install's account are listed only for instance admins.",
  input: z.object({}),
  permission: 'settings:write',
  readOnly: true,
})

/** `data` of `phoneNumber.searchNearby`. */
export type NearbyNumbersData = {
  /** The area code that had no free number. */
  areaCode: string
  /** The codes tried at the carrier, best first (nearbyAreaCodes: the overlays, then the closest). */
  searched: string[]
  /** Those of them with a free number now, in the same order; `sameArea`: an overlay of `areaCode`. */
  free: { code: string; sameArea: boolean }[]
}

export const phoneNumberSearchNearby = defineAction({
  name: 'phoneNumber.searchNearby',
  // i18n-ignore: API and MCP docs for agents and developers, not shown in the app
  description:
    "When an area code has no free number: search its overlays and the nearby area codes of the same country at the workspace's carrier (its own account, else the install's) and list those with a free number, for `phoneNumber.setup`. Searches only, free; buys nothing.",
  input: z.object({
    /** The area code that had no free number (AREA_CODES). */
    areaCode: buyableAreaCodeInput,
  }),
  permission: 'settings:write',
  readOnly: true,
})

export const phoneNumberUpdate = defineAction({
  name: 'phoneNumber.update',
  description:
    'Change how a connected phone number is used: `mode` (forward_conditional, forward_all, new or ported) and `assistantId`, the assistant of the workspace that answers it.',
  input: z
    .object({
      phoneNumberId: z.string().min(1),
      mode: z.enum(phoneNumberModes).optional(),
      assistantId: z.string().min(1).optional(),
    })
    .refine(i => i.mode || i.assistantId, { message: 'give a mode or an assistantId' }),
  permission: 'settings:write',
})

export const phoneNumberRelease = defineAction({
  name: 'phoneNumber.release',
  description:
    'Disconnect a phone number from the workspace: the assistant stops answering it. A number bought through Linedesk is also released at the carrier (its monthly cost stops, and the number may go to someone else); a number that was attached from the carrier account stays there. `confirm` must repeat the number.',
  input: z
    .object({
      phoneNumberId: z.string().min(1),
      /** The number as the person typed it to confirm; compared by digits with the stored number. */
      confirm: z.string().min(1).max(40),
    })
    .strict(),
  permission: 'settings:write',
})

/** Whether what was typed is the number (spaces, dashes, brackets and a leading +1 do not matter). */
export function confirmsNumber(typed: string, e164: string): boolean {
  const digits = (value: string) => value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return digits(typed).length > 0 && digits(typed) === digits(e164)
}

// Talking to the assistant from the web app. Read-only for the action runner: it writes no rows,
// and its result (a LiveKit token) must not be kept in the command log.
export const assistantStartTestCall = defineAction({
  name: 'assistant.startTestCall',
  description:
    'Start a test call with the assistant in the browser: returns a short-lived LiveKit token for a new room the assistant joins.',
  /** The assistant to talk to (one of the workspace's); default: the workspace's first. */
  input: z.object({ assistantId: z.string().min(1).optional() }),
  permission: 'settings:write',
  readOnly: true,
})
/** `data` of `assistant.startTestCall`: where and how the browser joins. The token can join only `room`. */
export type TestCallData = { url: string; token: string; room: string; expiresAt: string }
