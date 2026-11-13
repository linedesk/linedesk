import {
  AI_DISCLOSURE_MODES,
  BEHAVIOUR_IDS,
  type BehaviourId,
  COMMUNICATION_STYLES,
  REMOVED_BEHAVIOUR_IDS,
} from './assistant-prompt.ts'
import type { Closure } from '@linedesk/db/types'
import { z } from 'zod'
import { ASSISTANT_CALL_MAX_MINUTES } from './calls.ts'
import { defineAction } from './define.ts'
import { JOB_VALUE_MAX_CENTS } from './insights.ts'
import { assistantLanguages } from './languages.ts'
import { transferContacts } from './transfer.ts'
import { voiceId } from './voices.ts'

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

/** Add someone by hand. A number that belonged to a deleted contact brings that contact back (with its calls). */
export const contactCreate = defineAction({
  name: 'contact.create',
  description: 'Add a contact by hand: a phone number in E.164 (+15035550100), and optionally a name and company.',
  input: z.object({
    phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'a phone number in E.164, like +15035550100'),
    name: z.string().trim().min(1).optional(),
    company: z.string().trim().min(1).optional(),
  }),
  permission: 'contact:write',
  public: true,
})

/** Most rows one contact.import takes; the browser sends a longer file in parts. */
export const CONTACT_IMPORT_MAX_ROWS = 500

/** Longest text contact.import keeps per field; the browser cuts longer values from a file to these. */
export const CONTACT_IMPORT_LIMITS = { name: 200, company: 200, email: 254, address: 500, note: 2000 } as const

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
 * The defaults ask at 5 and 10 seconds of silence and hang up at 15.
 */
export const SILENCE_FIRST_GAP_DEFAULT_S = 5
export const SILENCE_FIRST_GAP_MIN_S = 4
export const SILENCE_FIRST_GAP_MAX_S = 30
export const SILENCE_REMINDERS_DEFAULT = 2
export const SILENCE_REMINDERS_MAX = 4
export const SILENCE_HANG_UP_DEFAULT_S = 15
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
 * language model, voice). Instance admins set each up under Admin › Providers; each assistant picks one.
 */
export const VOICE_PIPELINES = ['realtime', 'three_stage'] as const
export type VoicePipeline = (typeof VOICE_PIPELINES)[number]
export const VOICE_PIPELINE_LABELS: Record<VoicePipeline, string> = {
  realtime: 'Realtime model',
  three_stage: 'Three stages',
}
/** Which pipelines the install has set up. */
export type PipelinesSetUp = Record<VoicePipeline, boolean>

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
/** Asked when the line is quiet, unless the owner wrote another line (`silence_reminder`). */
export const DEFAULT_SILENCE_REMINDER = 'Are you still there?'
/** The reminder an assistant asks: its own, or the default. */
export const silenceReminderOf = (stored: string | null | undefined) => stored?.trim() || DEFAULT_SILENCE_REMINDER

export const assistantUpdate = defineAction({
  name: 'assistant.update',
  description:
    "Update the assistant: name, greeting, voice, whether calls are recorded, what it knows about the business, how fast it talks (`talking_speed_pct`: 80-120 percent of the voice's own pace, 100: its own pace), what it asks when the line is quiet (`silence_reminder`, null: the default) and says before hanging up (`silence_closing`), the longest it stays on a call (`max_call_minutes`). `greeting_outside` is used outside business hours when the workspace uses them (null: the same as during hours). `transfers` replaces the list of transfer contacts: who callers are put through to (a US number in E.164, null while there is none) and when (`condition`, in plain words), tried in list order when several fit; `hours_only` only while the business is open; `ring_seconds` (10-60); `if_no_answer`: message_urgent, message or next (the next contact that fits). `languages`: `english` (English only, the default), `allowed` (English plus the `allowed` codes) or `any`; the assistant switches to the language the caller speaks only when it is allowed, the greeting stays in English. `behaviours` sets switches of the behaviour checklist (ask_name, offer_callback, confirm_number); `ai_disclosure`: whether and when it mentions being an AI (never, when_asked, at_start, at_start_consent: says it and asks whether that is okay); it never claims to be human. `communication_style`: the tone (standard, professional, casual, formal, empathetic). `voice_pipeline`: how calls are answered, `realtime` (a realtime model, in its own voice) or `three_stage` (speech to text, language model and the assistant's voice); null: the install default; when the chosen one is not set up, the other answers.",
  input: z.object({
    assistantId: z.string().min(1),
    name: z.string().min(1).optional(),
    greeting: z.string().optional(),
    /** Replaced by ai_disclosure; still taken from a web app of the release before. */
    disclose_ai: z.boolean().optional(),
    /** Whether and when the assistant mentions it is an AI: never, when_asked (default), at_start, at_start_consent. */
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
    /** Which languages the assistant speaks with callers besides English. */
    languages: assistantLanguages.optional(),
    /** How calls are answered (VOICE_PIPELINES); null: the install default. */
    voice_pipeline: z.enum(VOICE_PIPELINES).nullable().optional(),
    /** An empty voice_id: the provider's default voice. */
    voice: z.object({ provider: z.string(), voice_id: z.union([z.literal(''), voiceId]) }).optional(),
    business_profile: z
      .object({
        instructions: z.string().max(INSTRUCTIONS_MAX).optional(),
        description: z.string().optional(),
        services: z.array(z.string()).optional(),
        service_area: z.string().optional(),
        address: z.string().optional(),
        hours: z.string().optional(),
        website: z.string().trim().max(2000).optional(),
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
export const DEFAULT_RECORDING_NOTICE = 'This call may be recorded.'
export const RECORDING_NOTICE_MAX = 200

/** `data` of `workspace.getSettings`. */
export type BusinessHoursSpan = { weekday: number; start: string; end: string }
/** `data` of `workspace.getSettings`. `businessHours` empty: no hours set (the assistant says nothing about them). */
/** `recordingOn`: this server records calls (a recording store is picked under Providers, or RECORDING_STORE names one; the voice agent gets the same setting). */
/** `businessHoursOn`: the workspace uses its hours for calls (off by default). */
/** `recordingNoticeOn`, `recordingNotice`: the sentence the assistant says right after the greeting (off by default). */
export type WorkspaceSettingsData = {
  recordingRetentionDays: number | null
  recordingNoticeOn: boolean
  recordingNotice: string
  timeZone: string
  businessHours: BusinessHoursSpan[]
  businessHoursOn: boolean
  recordingOn: boolean
  /** Holidays and other days with their own hours (availability_exceptions), by date; missing from an older API. */
  closedDays?: ClosedDay[]
  /** Vacation or closure mode; null: off. Missing from an older API. */
  closure?: Closure | null
  /** The value of one booked job in cents (Insights); null: not set. */
  jobValueCents: number | null
  /** When the assistant picks up, as chosen in onboarding; null: never chosen. Missing from an older API. */
  pickupMode?: PickupMode | null
}

/**
 * When the assistant picks up (onboarding, "When should Maya pick up?"): calls the business doesn't answer
 * (conditional forwarding), every call (forwarding all), or only when closed (conditional forwarding plus hours).
 */
export const pickupModes = ['no_answer', 'always', 'after_hours'] as const
export type PickupMode = (typeof pickupModes)[number]

/** A holiday or closure day: closed all day (no times) or open only `start`–`end`. */
export type ClosedDay = { date: string; name: string; start: string | null; end: string | null }

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
    'Set the holidays and other closure days: dates (YYYY-MM-DD, in the workspace time zone) when the business is closed all day, or open only `start`–`end`. Replaces the whole list. The assistant treats them as closed (or as those hours) and books no appointments outside them.',
  input: z.object({
    days: z
      .array(
        z
          .object({
            date: isoDate,
            name: z.string().trim().max(80).default(''),
            start: clockTime.nullable().default(null),
            end: clockTime.nullable().default(null),
          })
          .refine(d => (d.start === null) === (d.end === null) && (d.start === null || d.end! > d.start), {
            message: 'a day open part-time needs an end after its start',
          }),
      )
      .max(200),
  }),
  permission: 'settings:write',
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
    'Change workspace settings: `recordingRetentionDays` (0: no recordings are kept, calls are not recorded; 30, 60, 90, 180 or 365; null keeps recordings; older recordings are deleted by the daily cleanup), `businessHoursOn` (whether calls use the business hours; off: the assistant says nothing about hours), `recordingNoticeOn` (the assistant says a recording notice right after the greeting; off by default), `recordingNotice` (that sentence, e.g. "This call may be recorded."), `timeZone` (the IANA zone the business hours are in, e.g. "America/Los_Angeles") and `jobValueCents` (what a booked job is worth on average, in cents, for Insights; null clears it); `closure` (vacation or closure mode: closed from `from` to `until`, with its own `greeting`, and `transfers` none or urgent only; null: off); `pickupMode` (when the assistant picks up, as chosen in onboarding: no_answer, always or after_hours; it decides which forwarding code is shown, the routing itself stays with the number\'s mode and the business hours).',
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
    timeZone: z.string().refine(isTimeZone, 'a time zone like America/Los_Angeles').optional(),
    /** Vacation or closure mode; null turns it off. */
    closure: closureSchema.nullable().optional(),
    jobValueCents: z.number().int().min(0).max(JOB_VALUE_MAX_CENTS).nullable().optional(),
    pickupMode: z.enum(pickupModes).optional(),
  }),
  permission: 'settings:write',
})

export const phoneNumberModes = ['forward_conditional', 'forward_all', 'new', 'ported'] as const

export const phoneNumberSetup = defineAction({
  name: 'phoneNumber.setup',
  description:
    'Connect a phone number to the workspace and route its calls to the assistant. By default it attaches `e164`, a number that already exists in the carrier account, and buys nothing. With `purchase: true` it buys `e164`, or the first free number in `areaCode`, which costs money. Repeating it for the same number finishes a setup that failed halfway.',
  input: z
    .object({
      e164: z
        .string()
        .regex(/^\+[1-9]\d{6,14}$/)
        .optional(),
      areaCode: z
        .string()
        .regex(/^\d{3}$/)
        .optional(),
      /** Buying is never implied: without this, a number that is not in the account is rejected. */
      purchase: z.boolean().default(false),
      /** How the business uses the number. Default: `new` for a bought number, `forward_conditional` for an attached one. */
      mode: z.enum(phoneNumberModes).optional(),
      /** The assistant that answers it (one of the workspace's). Default: the workspace's first. */
      assistantId: z.string().min(1).optional(),
    })
    .refine(i => i.e164 || i.areaCode, { message: 'give a number (e164) or an area code' })
    .refine(i => i.e164 || i.purchase, {
      message: 'an area code alone means buying a number: pass purchase: true, or give the number (e164) to attach',
    }),
  permission: 'settings:write',
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
  input: z.object({
    phoneNumberId: z.string().min(1),
    /** The number as the person typed it to confirm; compared by digits with the stored number. */
    confirm: z.string().min(1).max(40),
  }),
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
