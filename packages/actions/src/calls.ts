import { z } from 'zod'
import { defineAction, type PatchSpec } from './define.ts'
import { behaviourOn } from './assistant-prompt.ts'
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
 * Hand a call to a member of the workspace, or take it back with null. Applied at once in the browser;
 * the server checks the member, records it in the call's activity and tells the assignee
 * (apps/api/src/assign-notifications.ts). The voice assistant cannot assign.
 */
export const callAssign = defineAction({
  name: 'call.assign',
  description:
    'Assign a call to a member of the workspace (their userId from member.list), or unassign it with userId null. The member is notified unless notify is false.',
  input: callId.extend({
    userId: z.string().min(1).nullable(),
    /** false: no notification to the assignee (undo puts a call back where it was). */
    notify: z.boolean().optional(),
  }),
  permission: 'call:write',
  public: true,
  patch: { table: 'calls', id: i => i.callId, set: i => ({ assignee_id: i.userId }) },
})

/** One member calls can be assigned to (member.list). */
export type AssignableMember = { userId: string; name: string; role: string }

export const memberList = defineAction({
  name: 'member.list',
  description: 'List the members of the workspace that calls can be assigned to: their userId, name and role.',
  input: z.object({}),
  permission: 'call:read',
  public: true,
  readOnly: true,
})

export const callSetActionItems = defineAction({
  name: 'call.setActionItems',
  description: 'Replace the next steps of a call, for example to tick one off.',
  input: callId.extend({
    items: z.array(
      z.object({ text: z.string().min(1), done: z.boolean().optional(), kind: z.literal('message').optional() }),
    ),
  }),
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

/**
 * The longest the assistant stays on a call: it says goodbye and hangs up then (the agent's timer). The limit is
 * about what the assistant costs, so a call it put through to a person goes on. The same on every usage level:
 * the owner may set up to 30 minutes (decisions.md 2026-11-16), the default is 20.
 */
export const ASSISTANT_CALL_MAX_MINUTES = 30
/** An assistant's own limit until the owner picks another (assistants.max_call_minutes; at most ASSISTANT_CALL_MAX_MINUTES). */
export const ASSISTANT_CALL_DEFAULT_MINUTES = 20
/** The longest any call lasts, one put through to a person included: the inbound trunk hangs up then. */
export const CALL_MAX_MINUTES = 120

/** How a caller's carrier vouched for the caller ID (calls.caller_attestation). */
export const CALLER_ATTESTATIONS = ['A', 'B', 'C', 'failed', 'none'] as const
export type CallerAttestation = (typeof CALLER_ATTESTATIONS)[number]

/**
 * Whether a call's caller ID is trusted to name the caller (their contact's name, notes, history and bookings, the
 * business's caller lookup). Calls without a phone line (test, simulated) always. A phone call unless the carrier
 * said explicitly that it did not vouch for the number (an attestation other than A) and the assistant's owner left
 * "Recognize callers only when their carrier verified the number" on. No attestation at all (a trunk that passes no
 * SIP headers, an older agent) is handled as before the check; headers without a verstat arrive as `none`.
 */
export function callerRecognized(
  source: 'phone' | 'test' | 'sample' | 'simulated',
  attestation: CallerAttestation | null | undefined,
  behaviours: Readonly<Record<string, boolean>> | null | undefined,
): boolean {
  if (source !== 'phone') return true
  return attestation == null || attestation === 'A' || !behaviourOn(behaviours, 'verified_caller_only')
}

export const callStart = defineAction({
  name: 'call.start',
  description: 'Register an incoming call. The workspace is resolved from the dialled number.',
  input: z.object({
    from: z.string().min(3),
    to: z.string().min(3),
    room: z.string().optional(),
    /** `simulated`: a scripted call from the call simulator; filed like a phone call, never counted as a real one. */
    source: z.enum(['phone', 'simulated']).optional(),
    /** STIR/SHAKEN attestation the carrier sent with the call (callerAttestation in apps/agent); missing: not read (older agent). */
    attestation: z.enum(CALLER_ATTESTATIONS).optional(),
    /** The carrier's spam screening flagged the call. */
    spamLikely: z.boolean().optional(),
  }),
  permission: 'agent',
  secretResult: ['callToken'],
  logged: 'ids',
})
/**
 * Whether a caller ID is a real, dialable number (E.164). Withheld numbers arrive as "anonymous",
 * "restricted" and the like: such a caller gets no contact, no booking lookup and no booking changes.
 */
export const isE164 = (value: string | null | undefined): value is string => !!value && /^\+[1-9]\d{7,14}$/.test(value)

/**
 * A caller ID as E.164 when it is a number in another common shape: carriers may send it without the "+"
 * ("19715550123"), with "00" for the "+", or with spaces, dashes, dots and brackets. A bare 10-digit number
 * ("9715550123") is read as +1 only with `nationalUs`, when the number dialled is a +1 number: elsewhere ten
 * digits are a national number of that country. Anything else ("anonymous", too short) comes back unchanged and is not E.164.
 */
export function normalizeCallerId(value: string, { nationalUs = false }: { nationalUs?: boolean } = {}): string {
  const raw = value.trim()
  if (!/^[+\d\s().-]+$/.test(raw)) return raw
  const digits = raw.replace(/\D/g, '')
  const e164 = raw.startsWith('+')
    ? `+${digits}`
    : digits.startsWith('00')
      ? `+${digits.slice(2)}`
      : /^1[2-9]\d{9}$/.test(digits)
        ? `+${digits}`
        : nationalUs && /^[2-9]\d{9}$/.test(digits)
          ? `+1${digits}`
          : null
  return e164 && isE164(e164) ? e164 : raw
}

/** The contact a test call from the web app is filed under, so the inbox shows it as "Test call". */
export const testCallContact = { phone: 'test', name: 'Test call' } as const

export const callStartTest = defineAction({
  name: 'call.startTest',
  description:
    "Register a test call a member started from the web app. The workspace is the agent's x-workspace-id and the assistant `assistantId`, both taken from the dispatch the API signed; an assistant of another workspace is refused.",
  input: z.object({ room: z.string().min(1).max(128), assistantId: z.string().min(1).optional() }),
  permission: 'agent',
  secretResult: ['callToken'],
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
/** For the call simulator: the install's Linedesk numbers (E.164), so it can dial the only one without being told. */
export const callListNumbers = defineAction({
  name: 'call.listNumbers',
  description: "List the install's Linedesk numbers, for the call simulator to pick the one to dial.",
  input: z.object({}),
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
  /**
   * `instruction`: when the assistant offers the type (empty: no condition). `required_fields` includes
   * 'name' when the type asks for the caller's name (an API of an older version always wanted it and did not list it).
   */
  appointmentTypes: {
    id: string
    name: string
    duration_min: number
    required_fields: ('name' | 'phone' | 'email' | 'address')[]
    instruction?: string
  }[]
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
  logged: 'ids',
})
/**
 * Longest caller name an action takes (characters): names come from what callers say, and go into contacts,
 * calendar events and the assistant's instructions.
 */
export const CALLER_NAME_MAX = 80

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
    /** The caller's name as the summary found it: names the contact when it has no name yet. */
    callerName: z.string().trim().max(CALLER_NAME_MAX).optional(),
    /**
     * The call was recorded: when after-call transcription is on, its news (email, push, evaluation, webhooks) waits
     * for the corrected transcript (`data.held`), and the agent follows up with call.correctTranscript and
     * call.finalize. Missing: the news goes now, as before.
     */
    awaitTranscript: z.boolean().optional(),
  }),
  permission: 'agent',
  logged: 'ids',
})
/** `data` of call.finish: whether the call's news waits for the corrected transcript (call.finalize sends it). */
/** `named`: this finish gave the call's contact the caller's name (call.finalize may then correct it). */
export type CallFinishData = { held: boolean; named?: boolean }

/** How long a held call's news waits at most for call.finalize; then the CALL_RELEASE job sends it (seconds). */
export const AWAIT_TRANSCRIPT_MAX_SEC = 60

/**
 * The agent asks for the after-call transcript of a held call now, after call.setRecording: the provider hears the
 * recording and the caller's lines are corrected. `data` is CorrectTranscriptData. Runs outside a transaction (the
 * provider takes seconds), like call.lookUpCaller.
 */
export const callCorrectTranscript = defineAction({
  name: 'call.correctTranscript',
  description: "Transcribe a finished call's recording again and correct the caller's lines; the corrected transcript.",
  input: callId,
  permission: 'agent',
  readOnly: true,
})
/** `data` of call.correctTranscript: `lines` (the whole transcript, in order) only when caller lines changed. */
export type CorrectTranscriptData = {
  status: 'updated' | 'skipped' | 'failed'
  lines?: { speaker: z.infer<typeof speaker>; text: string }[]
}

/**
 * The summary of the corrected transcript for a held call (call.finish with awaitTranscript), then the call's news
 * goes out. Without the summary fields the one call.finish stored stays. A call no longer held keeps its news as sent.
 */
export const callFinalize = defineAction({
  name: 'call.finalize',
  description: "Store the summary of a call's corrected transcript and send the call's notifications.",
  input: callId.extend({
    outcome: outcome.optional(),
    urgency: urgency.optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    actionItems: z.array(z.object({ text: z.string(), done: z.boolean().optional() })).optional(),
    fields: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    callerName: z.string().trim().max(CALLER_NAME_MAX).optional(),
    /**
     * What the agent sent with call.finish: its action items are replaced (the team's notes stay); `callerName` only
     * when call.finish named the contact with it (CallFinishData.named), which is then named again; `urgency`: the
     * first summary's, which the new one may change while the news is held; `title` and `summary`: the first summary's,
     * replaced only when the team has not changed them since.
     */
    previous: z
      .object({
        actionItems: z.array(z.string()).max(200).default([]),
        callerName: z.string().trim().max(CALLER_NAME_MAX).optional(),
        urgency: urgency.optional(),
        title: z.string().optional(),
        summary: z.string().optional(),
      })
      .optional(),
  }),
  permission: 'agent',
  logged: 'ids',
})

/** One assistant reply's time, split by where it went (reply_timings); milliseconds, each part where it was measured. */
const replyTiming = z.object({
  at: z.iso.datetime({ offset: true }),
  turnMs: z.number().int().nonnegative().max(600_000).optional(),
  modelMs: z.number().int().nonnegative().max(600_000).optional(),
  voiceMs: z.number().int().nonnegative().max(600_000).optional(),
  serverMs: z.number().int().nonnegative().max(600_000).optional(),
  totalMs: z.number().int().nonnegative().max(600_000).optional(),
  heardMs: z.number().int().nonnegative().max(600_000).optional(),
})
export type ReplyTiming = z.infer<typeof replyTiming>
/** `phone`: rows of the call test with only what the caller heard over the phone (`heardMs`), whatever answered. */
export const REPLY_PIPELINES = ['cascaded', 'realtime', 'phone'] as const

export const callRecordTimings = defineAction({
  name: 'call.recordTimings',
  description:
    "Store how long the assistant's replies took on a call, split by where the time went (turn detection, model, voice, the agent itself, and what the caller heard in a call test).",
  input: callId.extend({
    pipeline: z.enum(REPLY_PIPELINES),
    /** Who did each part: turn, model, voice → provider id. */
    providers: z
      .object({
        turn: z.string().max(80).optional(),
        model: z.string().max(80).optional(),
        voice: z.string().max(80).optional(),
      })
      .default({}),
    replies: z.array(replyTiming).min(1).max(500),
  }),
  permission: 'agent',
  logged: 'ids',
})

// What the agent saves during a call (the urgent flag; a message when a transfer found nobody).
export const callTakeMessage = defineAction({
  name: 'call.takeMessage',
  description: 'Take a message for the business: adds an action item to the call.',
  input: callId.extend({ message: z.string().min(1).max(500) }),
  permission: 'agent',
  logged: 'ids',
})
export const callFlagUrgent = defineAction({
  name: 'call.flagUrgent',
  description: 'Flag a call as urgent, so the team sees it first.',
  input: callId,
  permission: 'agent',
  patch: { table: 'calls', id: i => i.callId, set: () => ({ urgency: 'urgent' }) } satisfies PatchSpec<CallId, 'calls'>,
})

const setUrgencyInput = callId.extend({ urgency })
/** The team's own urgent flag (⌘K Mark urgent / Not urgent). */
export const callSetUrgency = defineAction({
  name: 'call.setUrgency',
  description: 'Set how urgent a call is: urgent puts it at the top of the inbox; normal or low takes the flag off.',
  input: setUrgencyInput,
  permission: 'call:write',
  public: true,
  patch: { table: 'calls', id: i => i.callId, set: i => ({ urgency: i.urgency }) } satisfies PatchSpec<
    z.infer<typeof setUrgencyInput>,
    'calls'
  >,
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

/** Where an uploaded document (no longer offered) was kept in the recording store: `<workspace>/knowledge/<document>.<pdf|txt|md>`. */
const DOCUMENT_KEY_PATTERN = /^[A-Za-z0-9_-]+\/knowledge\/[A-Za-z0-9_-]+\.(pdf|txt|md)$/
export const isDocumentKey = (key: string) => DOCUMENT_KEY_PATTERN.test(key)
/** A key the store may use: a call recording or an uploaded document. */
export const isStoreKey = (key: string) => isRecordingKey(key) || isDocumentKey(key)

const PREFIX_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/
/** True for an S3 path prefix such as `linedesk/recordings` (plain segments, no `.` or `..` segment). Slashes around it are ignored. */
export const isRecordingPrefix = (prefix: string) => {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '')
  return !trimmed || (PREFIX_PATTERN.test(trimmed) && !trimmed.split('/').some(part => part === '.' || part === '..'))
}
/** The object key in an S3 bucket: the optional prefix, then the recording key. Egress writes it, the API reads it. */
export function recordingObjectKey(prefix: string | null | undefined, key: string): string {
  if (!isStoreKey(key)) throw new Error(`not a recording key: ${key}`)
  if (prefix && !isRecordingPrefix(prefix))
    throw new Error('the S3 path prefix may only hold letters, digits, - _ . and /')
  const trimmed = (prefix ?? '').replace(/^\/+|\/+$/g, '')
  return trimmed ? `${trimmed}/${key}` : key
}

// S3 recording: the API starts LiveKit egress for the call with the bucket's keys, which never go to
// the agent; the agent stops it and reports it with call.setRecording as for the other stores.
export const callStartRecording = defineAction({
  name: 'call.startRecording',
  description:
    "Start recording a call's room into the S3-compatible recording store; returns the egress id in `data.egressId`.",
  input: callId,
  permission: 'agent',
})

// The agent reports that the recording of a call is final; the server derives the key. Members play
// it through GET /v1/calls/<id>/recording.
export const callSetRecording = defineAction({
  name: 'call.setRecording',
  description:
    'Mark the recording of a call as final. The server derives its key; `store` says which recording store holds it (missing: the one RECORDING_STORE names).',
  input: callId.extend({ format: z.enum(recordingFormats).default('ogg'), store: z.enum(recordingStores).optional() }),
  permission: 'agent',
})
