import { z } from 'zod'
import { defineAction, type PatchSpec } from './define.ts'
import type { Call } from '@linedesk/db/types'

const callId = z.object({ callId: z.string().min(1) })
type CallId = z.infer<typeof callId>

const callPatch = (name: string, description: string, set: (now: string) => Partial<Call>, destructive?: true) =>
  defineAction({
    name,
    description,
    input: callId,
    permission: 'call:write',
    public: true,
    ...(destructive ? { destructive } : {}),
    patch: { table: 'calls', id: i => i.callId, set: (_i, now) => set(now) } satisfies PatchSpec<CallId, 'calls'>,
  })

export const callMarkDone = callPatch('call.markDone', 'Mark a call as done.', () => ({
  inbox_state: 'done',
  unread: false,
}))
export const callMarkNotDone = callPatch('call.markNotDone', 'Move a done call back to the inbox.', () => ({
  inbox_state: 'open',
}))
export const callMarkRead = callPatch('call.markRead', 'Mark a call as read.', () => ({ unread: false }))
export const callMarkUnread = callPatch('call.markUnread', 'Mark a call as unread.', () => ({ unread: true }))
export const callClearReminder = callPatch('call.clearReminder', 'Remove the reminder from a call.', () => ({
  reminder_at: null,
  reminder_label: null,
}))
export const callDelete = callPatch('call.delete', 'Delete a call.', now => ({ deleted_at: now }), true)
export const callRestore = callPatch('call.restore', 'Restore a deleted call.', () => ({ deleted_at: null }))
/**
 * Destructive: it takes the call out of the inbox and its outcome is lost (call.markNotSpam makes it a
 * callback), and it is exactly what a caller would ask an assistant reading the transcript to do.
 */
export const callMarkSpam = callPatch(
  'call.markSpam',
  'File a call as spam (a sales call or robocall).',
  () => ({ outcome: 'spam', unread: false }),
  true,
)
/** `outcome`: what the call was before it was filed as spam (undo); without it a callback, so a person looks at it. */
const notSpamInput = z.object({
  callId: z.string().min(1),
  outcome: z
    .enum(['booked', 'rescheduled', 'cancelled', 'callback', 'message', 'answered', 'transferred', 'hangup'])
    .optional(),
})
export const callMarkNotSpam = defineAction({
  name: 'call.markNotSpam',
  description:
    'Take a call out of spam: it was a real caller, so it goes back to the open inbox (as a callback unless an outcome is given).',
  input: notSpamInput,
  permission: 'call:write',
  public: true,
  patch: {
    table: 'calls',
    id: i => i.callId,
    set: i => ({ outcome: i.outcome ?? 'callback', inbox_state: 'open' }),
  } satisfies PatchSpec<z.infer<typeof notSpamInput>, 'calls'>,
})

export const callRemind = defineAction({
  name: 'call.remind',
  description: 'Hide a call until a point in time, then bring it back.',
  input: callId.extend({ at: z.iso.datetime({ offset: true }), label: z.string().max(60).optional() }),
  permission: 'call:write',
  public: true,
  patch: { table: 'calls', id: i => i.callId, set: i => ({ reminder_at: i.at, reminder_label: i.label ?? null }) },
})

/**
 * Hand a call to a teammate (a member of the workspace), or take it back with null. Applied at once
 * in the browser; the server also checks that the user is a member (apps/api/src/handlers.ts).
 */
export const callAssign = defineAction({
  name: 'call.assign',
  description: 'Assign a call to a member of the workspace (their user id), or unassign it with null.',
  input: callId.extend({ userId: z.string().min(1).nullable() }),
  permission: 'call:write',
  public: true,
  patch: { table: 'calls', id: i => i.callId, set: i => ({ assignee_id: i.userId }) },
})

export const callSetActionItems = defineAction({
  name: 'call.setActionItems',
  description: 'Replace the next steps of a call, for example to tick one off.',
  input: callId.extend({ items: z.array(z.object({ text: z.string().min(1), done: z.boolean().optional() })) }),
  permission: 'call:write',
  public: true,
  patch: { table: 'calls', id: i => i.callId, set: i => ({ action_items: i.items }) },
})

// Written by the voice agent (and the dev simulator). Server handlers live in apps/api.
const speaker = z.enum(['agent', 'caller', 'human', 'system'])
export const outcome = z.enum([
  'booked',
  'rescheduled',
  'cancelled',
  'callback',
  'message',
  'answered',
  'transferred',
  'hangup',
  'spam',
])
export const urgency = z.enum(['urgent', 'normal', 'low'])

export const callStart = defineAction({
  name: 'call.start',
  description: 'Register an incoming call. The workspace is resolved from the dialled number.',
  input: z.object({ from: z.string().min(3), to: z.string().min(3), room: z.string().optional() }),
  permission: 'agent',
})
/**
 * Whether a caller ID is a real, dialable number (E.164). Withheld numbers arrive as "anonymous",
 * "restricted" and the like: such a caller gets no contact, no booking lookup and no booking changes.
 */
export const isE164 = (value: string | null | undefined): value is string => !!value && /^\+[1-9]\d{7,14}$/.test(value)

/** The contact a test call from the web app is filed under, so the inbox shows it as "Test call". */
export const testCallContact = { phone: 'test', name: 'Test call' } as const

export const callStartTest = defineAction({
  name: 'call.startTest',
  description:
    "Register a test call a member started from the web app. The workspace is the agent's x-workspace-id and the assistant `assistantId`, both taken from the dispatch the API signed; an assistant of another workspace is refused.",
  input: z.object({ room: z.string().min(1).max(128), assistantId: z.string().min(1).optional() }),
  permission: 'agent',
})
/** For the phone-to-phone call test: the newest call from `from` to `to` since a moment, and how far it got. */
export const callFindForTest = defineAction({
  name: 'call.findForTest',
  description:
    'Find the call the call test placed in the workspace of a business number: by caller number or by room, the newest since a moment.',
  input: z.object({
    /** The business number: it names the workspace. */
    to: z.string().min(3),
    since: z.iso.datetime({ offset: true }),
    /** A call over the phone, by caller number; or a no-phone test call, by its room. */
    from: z.string().min(3).optional(),
    room: z.string().min(1).optional(),
  }),
  permission: 'agent',
  readOnly: true,
})
/** `data` of `call.findForTest`. `call` is null while no such call exists. */
export type CallTestFinding = {
  workspaceId: string
  call: {
    id: string
    status: string
    outcome: string | null
    urgency: string
    title: string | null
    summary: string | null
    recording_key: string | null
    duration_sec: number | null
    action_items: number
    /** How a warm transfer during the call went (call.transfer); null: no transfer. */
    transfer_result?: string | null
  } | null
  turns: { caller: number; agent: number; system: number }
  /** The transcript in order; `at_ms` is when each line was written, from the start of the call. */
  lines: { speaker: string; text: string; at_ms: number }[]
  /** Whether the workspace's assistant can book (an appointment type and an enabled calendar of a connected account). */
  bookingReady?: boolean
  /**
   * The call's bookings. `event` is what the calendar provider says now: the event exists (`found`, at
   * `event_start`), is gone (`missing`), or could not be asked (`unchecked`, with the reason).
   */
  bookings?: {
    id: string
    status: string
    start_at: string
    title: string | null
    calendar_name: string | null
    calendar_instruction: string | null
    event: 'found' | 'missing' | 'unchecked'
    event_start: string | null
    note: string | null
  }[]
}

/** What call.start tells the agent about booking; null when the assistant cannot book (no type or no calendar). */
export type BookingContext = {
  timeZone: string
  /** Today in the business's time zone, as the assistant says it ("Wednesday, November 11, 2026"), and as YYYY-MM-DD. */
  today: string
  todayDate: string
  appointmentTypes: { id: string; name: string; duration_min: number; required_fields: ('phone' | 'email' | 'address')[] }[]
  calendars: { id: string; name: string; instruction: string; is_default: boolean }[]
  /**
   * Always empty: caller ID is not proof of identity, so the assistant is never told a caller's bookings.
   * Kept for agents of an older version, which read it.
   */
  upcoming: { id: string; label: string; title: string | null }[]
  /**
   * Whether the assistant may offer to cancel or move a booking on this call: only for a caller with a
   * dialable number (E.164). The API still checks the day and the name on the booking the caller states.
   */
  canChangeBookings: boolean
}

/** How many earlier calls and upcoming bookings call.start gives for a returning caller. */
export const CALLER_HISTORY_CALLS = 3
export const CALLER_HISTORY_BOOKINGS = 3

/**
 * What call.start tells the agent about a caller whose number matched a contact of the workspace: their last
 * calls (newest first) and their upcoming bookings. Only for a phone call from a dialable number; null else.
 * Summaries and next steps come from earlier calls, so partly from what callers said: untrusted text.
 */
export type CallerHistory = {
  recentCalls: {
    /** When the call was, in the business's time zone ("Tuesday, November 3"). */
    when: string
    title: string | null
    summary: string | null
    outcome: string | null
    /** Next steps not done yet. */
    openSteps: string[]
  }[]
  /**
   * Upcoming bookings booked under the contact's name, soonest first; empty when the caller cannot change
   * bookings on this call (no booking setup, or locked after misses). `date` is YYYY-MM-DD for the tools.
   */
  upcomingBookings: { date: string; when: string; type: string | null }[]
}

export const callAppendTranscript = defineAction({
  name: 'call.appendTranscript',
  description: 'Append one transcript segment to a live call.',
  input: callId.extend({
    speaker,
    text: z.string().min(1),
    atMs: z.number().int().nonnegative(),
    toolEvent: z.object({ tool: z.string(), label: z.string() }).optional(),
  }),
  permission: 'agent',
})
export const callFinish = defineAction({
  name: 'call.finish',
  description: 'End a call and store its outcome and summary.',
  input: callId.extend({
    outcome: outcome.optional(),
    urgency: urgency.optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    actionItems: z.array(z.object({ text: z.string(), done: z.boolean().optional() })).optional(),
    fields: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    callerName: z.string().optional(),
  }),
  permission: 'agent',
})

// Tools the assistant can use during a call.
export const callTakeMessage = defineAction({
  name: 'call.takeMessage',
  description: 'Take a message for the business: adds an action item to the call.',
  input: callId.extend({ message: z.string().min(1).max(500) }),
  permission: 'agent',
})
export const callFlagUrgent = defineAction({
  name: 'call.flagUrgent',
  description: 'Flag a call as urgent, for emergencies that need a person right away.',
  input: callId,
  permission: 'agent',
  patch: { table: 'calls', id: i => i.callId, set: () => ({ urgency: 'urgent' }) } satisfies PatchSpec<CallId, 'calls'>,
})

// Recordings. The key is never taken from a client: both sides derive it from the workspace and the call.
/** `ogg` from LiveKit egress; `wav` for the demo recording the seed makes. */
export const recordingFormats = ['ogg', 'wav'] as const
export type RecordingFormat = (typeof recordingFormats)[number]
/** The recording stores (providers of the `recording` category in admin.ts); a call keeps which one holds its recording. */
export const recordingStores = ['file', 's3'] as const
export type RecordingStoreName = (typeof recordingStores)[number]

/** Where the recording of a call lives in the recording store: `<workspace>/<call>.<format>`. */
export const recordingKey = (workspaceId: string, callId: string, format: RecordingFormat = 'ogg') =>
  `${workspaceId}/${callId}.${format}`

const KEY_PATTERN = new RegExp(`^[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\\.(${recordingFormats.join('|')})$`)
/** True for keys of the shape `recordingKey` builds: two plain segments, no dots or slashes inside them. */
export const isRecordingKey = (key: string) => KEY_PATTERN.test(key)

const PREFIX_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/
/** True for an S3 path prefix such as `linedesk/recordings` (plain segments, no `.` or `..` segment). Slashes around it are ignored. */
export const isRecordingPrefix = (prefix: string) => {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '')
  return !trimmed || (PREFIX_PATTERN.test(trimmed) && !trimmed.split('/').some(part => part === '.' || part === '..'))
}
/** The object key in an S3 bucket: the optional prefix, then the recording key. Egress writes it, the API reads it. */
export function recordingObjectKey(prefix: string | null | undefined, key: string): string {
  if (!isRecordingKey(key)) throw new Error(`not a recording key: ${key}`)
  if (prefix && !isRecordingPrefix(prefix)) throw new Error('the S3 path prefix may only hold letters, digits, - _ . and /')
  const trimmed = (prefix ?? '').replace(/^\/+|\/+$/g, '')
  return trimmed ? `${trimmed}/${key}` : key
}

// The agent reports that the recording of a call is final; the server derives the key. Members play
// it through GET /v1/calls/<id>/recording.
export const callSetRecording = defineAction({
  name: 'call.setRecording',
  description:
    'Mark the recording of a call as final. The server derives its key; `store` says which recording store holds it (missing: the one RECORDING_STORE names).',
  input: callId.extend({ format: z.enum(recordingFormats).default('ogg'), store: z.enum(recordingStores).optional() }),
  permission: 'agent',
})
