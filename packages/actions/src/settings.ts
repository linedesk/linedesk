import { CALL_RULES_MAX } from './assistant-prompt.ts'
import { z } from 'zod'
import { defineAction } from './define.ts'
import { onCallNumber } from './transfer.ts'
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
  patch: { table: 'contacts', id: i => i.contactId, set: ({ contactId: _id, ...rest }) => defined(rest) },
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
          name: importText(200),
          company: importText(200),
          email: importText(254),
          address: importText(500),
          note: importText(2000),
        }),
      )
      .min(1)
      .max(CONTACT_IMPORT_MAX_ROWS),
  }),
  permission: 'contact:write',
})

const mergedField = z.string().trim().max(2000).nullable()

/**
 * Two contacts that are one person: `mergeId` goes into `keepId`. The kept contact gets the values
 * given (the ones the member picked from either), the other one's calls and bookings move to it, and
 * the other one leaves Contacts; a later call from its number lands on the kept contact.
 */
export const contactMerge = defineAction({
  name: 'contact.merge',
  description: "Merge two contacts that are one person: the second one's calls move to the first, which keeps the given details.",
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
 * Silence on the line: after a first quiet gap the assistant asks "Are you still there?", again after a gap twice as
 * long, and so on for the number of reminders; then it says the closing line and hangs up. Never during a transfer.
 */
export const SILENCE_FIRST_GAP_DEFAULT_S = 8
export const SILENCE_FIRST_GAP_MIN_S = 4
export const SILENCE_FIRST_GAP_MAX_S = 30
export const SILENCE_REMINDERS_DEFAULT = 2
export const SILENCE_REMINDERS_MAX = 4
export const SILENCE_CLOSING_MAX = 200
export const DEFAULT_SILENCE_CLOSING = "I can't hear anyone on the line, so I'll hang up now. Please call us back anytime."
/** The closing line an assistant says: its own, or the default. */
export const silenceClosingOf = (stored: string | null | undefined) => stored?.trim() || DEFAULT_SILENCE_CLOSING

/** Most options a keypad menu offers: callers forget a longer list. */
export const KEYPAD_MENU_MAX_OPTIONS = 5
export const KEYPAD_MENU_LABEL_MAX = 60

/** A keypad menu: keys 1–9, each once, each with what the caller hears ("emergencies") and what it does. */
export const keypadMenu = z.object({
  options: z
    .array(
      z.object({
        key: z.string().regex(/^[1-9]$/, 'Keys are 1 to 9.'),
        label: z.string().trim().min(1, 'Each key needs a label.').max(KEYPAD_MENU_LABEL_MAX),
        action: z.enum(['transfer', 'topic']),
      }),
    )
    .min(1)
    .max(KEYPAD_MENU_MAX_OPTIONS)
    .refine(options => new Set(options.map(o => o.key)).size === options.length, 'Each key can be used once.'),
})

export const assistantUpdate = defineAction({
  name: 'assistant.update',
  description:
    'Update the assistant: name, greeting, whether a known caller is greeted by first name (`greet_by_name`), voice, whether calls are recorded, what it knows about the business and how it handles calls (call_rules; null for the default). `greeting_outside` and `instructions_outside` are used outside business hours when the workspace uses them (null: the same as during hours). `transfer_urgent` puts urgent calls through to `transfer_number` (a US number in E.164), only while the business is open when `transfer_hours_only`. `keypad_menu` (null: off) plays "press 1 for …" after the greeting; a `transfer` key is an urgent call, a `topic` key tells the assistant what the caller wants.',
  input: z.object({
    assistantId: z.string().min(1),
    name: z.string().min(1).optional(),
    greeting: z.string().optional(),
    disclose_ai: z.boolean().optional(),
    /** null goes back to the default rules. */
    call_rules: z.string().max(CALL_RULES_MAX).nullable().optional(),
    /** Used outside business hours, when the workspace uses them; null: the same as during hours. */
    greeting_outside: z.string().nullable().optional(),
    instructions_outside: z.string().max(INSTRUCTIONS_MAX).nullable().optional(),
    record_calls: z.boolean().optional(),
    /** Greet a caller whose number matches a contact with a name by first name. */
    greet_by_name: z.boolean().optional(),
    transfer_urgent: z.boolean().optional(),
    /** null: no on-call number (transfer stays off). */
    transfer_number: onCallNumber.nullable().optional(),
    transfer_hours_only: z.boolean().optional(),
    /** Silence on the line (SILENCE_*): seconds before the first "Are you still there?", how many, the closing line (null: default). */
    silence_first_gap_s: z.number().int().min(SILENCE_FIRST_GAP_MIN_S).max(SILENCE_FIRST_GAP_MAX_S).optional(),
    silence_reminders: z.number().int().min(0).max(SILENCE_REMINDERS_MAX).optional(),
    silence_closing: z.string().trim().max(SILENCE_CLOSING_MAX).nullable().optional(),
    /** null: no keypad menu (the default). */
    keypad_menu: keypadMenu.nullable().optional(),
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
        faqs: z.array(z.object({ q: z.string(), a: z.string() })).optional(),
      })
      .optional(),
  }),
  permission: 'settings:write',
  patch: { table: 'assistants', id: i => i.assistantId, set: ({ assistantId: _id, ...rest }) => defined(rest) },
})

/** A workspace can have several assistants; each phone number names the one that answers it. */
export const assistantCreate = defineAction({
  name: 'assistant.create',
  description:
    'Add an assistant to the workspace, with a fresh name and greeting and the default call rules. With `copyOf`, a copy of that assistant of the workspace (its greeting, instructions, rules and voice). Numbers keep their assistant: assign one with phoneNumber.update.',
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
export const recordingRetentionChoices = [30, 60, 90, 180, 365] as const
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

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'a time like 07:00')

export const businessHoursSet = defineAction({
  name: 'businessHours.set',
  description:
    'Set the business hours: per weekday (0 = Sunday … 6 = Saturday) when the office is open, wall-clock times in the workspace time zone. Replaces all hours; an empty list means no hours. The assistant uses them to tell callers whether the office is open and when someone calls back.',
  input: z.object({
    hours: z
      .array(z.object({ weekday: z.number().int().min(0).max(6), start: clockTime, end: clockTime }).refine(h => h.end > h.start, { message: 'end must be after start' }))
      .max(21),
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
    'Change workspace settings: `recordingRetentionDays` (30, 60, 90, 180 or 365; null keeps recordings; older recordings are deleted by the daily cleanup), `businessHoursOn` (whether calls use the business hours; off: the assistant says nothing about hours), `recordingNoticeOn` (the assistant says a recording notice right after the greeting; off by default), `recordingNotice` (that sentence, e.g. "This call may be recorded.") and `timeZone` (the IANA zone the business hours are in, e.g. "America/Los_Angeles").',
  input: z.object({
    recordingRetentionDays: z.union([z.literal(recordingRetentionChoices), z.null()]).optional(),
    businessHoursOn: z.boolean().optional(),
    recordingNoticeOn: z.boolean().optional(),
    recordingNotice: z.string().trim().min(1, 'Write the sentence the assistant says.').max(RECORDING_NOTICE_MAX).optional(),
    timeZone: z.string().refine(isTimeZone, 'a time zone like America/Los_Angeles').optional(),
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
