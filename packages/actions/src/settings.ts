import { CALL_RULES_MAX } from './assistant-prompt.ts'
import { z } from 'zod'
import { defineAction } from './define.ts'

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
  patch: { table: 'contacts', id: i => i.contactId, set: ({ contactId: _id, ...rest }) => defined(rest) },
})

const contactId = z.object({ contactId: z.string().min(1) })

/** Calls from a blocked number are not answered: call.start files them quietly in Spam and tells the agent to hang up. */
export const contactBlock = defineAction({
  name: 'contact.block',
  description: 'Block a caller: calls from their number are not answered and are filed in Spam.',
  input: contactId,
  permission: 'contact:write',
  patch: { table: 'contacts', id: i => i.contactId, set: (_i, now) => ({ blocked_at: now }) },
})

export const contactUnblock = defineAction({
  name: 'contact.unblock',
  description: 'Unblock a caller: their calls are answered again.',
  input: contactId,
  permission: 'contact:write',
  patch: { table: 'contacts', id: i => i.contactId, set: () => ({ blocked_at: null }) },
})

/** Add someone by hand. A number that belonged to a deleted contact brings that contact back (with its calls). */
export const contactCreate = defineAction({
  name: 'contact.create',
  description: 'Add a contact by hand: a phone number in E.164 (+15035550142), and optionally a name and company.',
  input: z.object({
    phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'a phone number in E.164, like +15035550142'),
    name: z.string().trim().min(1).optional(),
    company: z.string().trim().min(1).optional(),
  }),
  permission: 'contact:write',
})

/** Contacts leave the list but keep their calls; contact.restore undoes it. */
export const contactDelete = defineAction({
  name: 'contact.delete',
  description: 'Delete a contact. Their calls stay in the inbox, shown by number.',
  input: contactId,
  permission: 'contact:write',
  patch: { table: 'contacts', id: i => i.contactId, set: (_i, now) => ({ deleted_at: now }) },
})

export const contactRestore = defineAction({
  name: 'contact.restore',
  description: 'Bring back a deleted contact.',
  input: contactId,
  permission: 'contact:write',
  patch: { table: 'contacts', id: i => i.contactId, set: () => ({ deleted_at: null }) },
})

/** Longest free-text instructions an assistant takes (characters). */
export const INSTRUCTIONS_MAX = 20_000

export const assistantUpdate = defineAction({
  name: 'assistant.update',
  description:
    'Update the assistant: name, greeting, voice, whether calls are recorded, what it knows about the business and how it handles calls (call_rules; null for the default).',
  input: z.object({
    assistantId: z.string().min(1),
    name: z.string().min(1).optional(),
    greeting: z.string().optional(),
    disclose_ai: z.boolean().optional(),
    /** null goes back to the default rules. */
    call_rules: z.string().max(CALL_RULES_MAX).nullable().optional(),
    record_calls: z.boolean().optional(),
    voice: z.object({ provider: z.string(), voice_id: z.string() }).optional(),
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

/** How long recordings may be kept; null keeps them until the call is deleted. */
export const recordingRetentionChoices = [30, 60, 90, 180, 365] as const
export const DEFAULT_RECORDING_RETENTION_DAYS = 90

/** `data` of `workspace.getSettings`. */
export type BusinessHoursSpan = { weekday: number; start: string; end: string }
/** `data` of `workspace.getSettings`. `businessHours` empty: no hours set (the assistant says nothing about them). */
export type WorkspaceSettingsData = { recordingRetentionDays: number | null; timeZone: string; businessHours: BusinessHoursSpan[] }

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
    'Change workspace settings: `recordingRetentionDays` (30, 60, 90, 180 or 365; null keeps recordings). Older recordings are deleted by the daily cleanup.',
  input: z.object({
    recordingRetentionDays: z.union([z.literal(recordingRetentionChoices), z.null()]).optional(),
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
    })
    .refine(i => i.e164 || i.areaCode, { message: 'give a number (e164) or an area code' })
    .refine(i => i.e164 || i.purchase, {
      message: 'an area code alone means buying a number: pass purchase: true, or give the number (e164) to attach',
    }),
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
  input: z.object({}),
  permission: 'settings:write',
  readOnly: true,
})
/** `data` of `assistant.startTestCall`: where and how the browser joins. The token can join only `room`. */
export type TestCallData = { url: string; token: string; room: string; expiresAt: string }
