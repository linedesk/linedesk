import { z } from 'zod'
import { defineAction, type PatchSpec } from './define.ts'
import type { Call } from '@callfront/db/types'

const callId = z.object({ callId: z.string().min(1) })
type CallId = z.infer<typeof callId>

const callPatch = (name: string, description: string, set: (now: string) => Partial<Call>) =>
  defineAction({
    name,
    description,
    input: callId,
    permission: 'call:write',
    patch: { table: 'calls', id: i => i.callId, set: (_i, now) => set(now) } satisfies PatchSpec<CallId, 'calls'>,
  })

export const callMarkDone = callPatch('call.markDone', 'Mark a call as done.', () => ({ inbox_state: 'done', unread: false }))
export const callMarkNotDone = callPatch('call.markNotDone', 'Move a done call back to the inbox.', () => ({ inbox_state: 'open' }))
export const callMarkRead = callPatch('call.markRead', 'Mark a call as read.', () => ({ unread: false }))
export const callMarkUnread = callPatch('call.markUnread', 'Mark a call as unread.', () => ({ unread: true }))
export const callClearReminder = callPatch('call.clearReminder', 'Remove the reminder from a call.', () => ({ reminder_at: null, reminder_label: null }))
export const callDelete = callPatch('call.delete', 'Delete a call.', now => ({ deleted_at: now }))
export const callRestore = callPatch('call.restore', 'Restore a deleted call.', () => ({ deleted_at: null }))

export const callRemind = defineAction({
  name: 'call.remind',
  description: 'Hide a call until a point in time, then bring it back.',
  input: callId.extend({ at: z.iso.datetime({ offset: true }), label: z.string().max(60).optional() }),
  permission: 'call:write',
  patch: { table: 'calls', id: i => i.callId, set: i => ({ reminder_at: i.at, reminder_label: i.label ?? null }) },
})

export const callSetActionItems = defineAction({
  name: 'call.setActionItems',
  description: 'Replace the next steps of a call, for example to tick one off.',
  input: callId.extend({ items: z.array(z.object({ text: z.string().min(1), done: z.boolean().optional() })) }),
  permission: 'call:write',
  patch: { table: 'calls', id: i => i.callId, set: i => ({ action_items: i.items }) },
})

// Written by the voice agent (and the dev simulator). Server handlers live in apps/api.
const speaker = z.enum(['agent', 'caller', 'human', 'system'])
export const outcome = z.enum(['booked', 'rescheduled', 'cancelled', 'callback', 'message', 'answered', 'transferred', 'hangup', 'spam'])
export const urgency = z.enum(['urgent', 'normal', 'low'])

export const callStart = defineAction({
  name: 'call.start',
  description: 'Register an incoming call. The workspace is resolved from the dialled number.',
  input: z.object({ from: z.string().min(3), to: z.string().min(3), room: z.string().optional() }),
  permission: 'agent',
})
/** The contact a test call from the web app is filed under, so the inbox shows it as "Test call". */
export const testCallContact = { phone: 'test', name: 'Test call' } as const

export const callStartTest = defineAction({
  name: 'call.startTest',
  description: 'Register a test call a member started from the web app. The workspace is the agent\'s x-workspace-id, taken from the dispatch the API created.',
  input: z.object({ room: z.string().min(1).max(128) }),
  permission: 'agent',
})
/** For the phone-to-phone call test: the newest call from `from` to `to` since a moment, and how far it got. */
export const callFindForTest = defineAction({
  name: 'call.findForTest',
  description: 'Find the call the call test placed in the workspace of a business number: by caller number or by room, the newest since a moment.',
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
  call: { id: string; status: string; outcome: string | null; urgency: string; title: string | null; summary: string | null; recording_key: string | null; duration_sec: number | null; action_items: number } | null
  turns: { caller: number; agent: number; system: number }
  /** The transcript in order; `at_ms` is when each line was written, from the start of the call. */
  lines: { speaker: string; text: string; at_ms: number }[]
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
export const recordingFormats = ['ogg'] as const
export type RecordingFormat = (typeof recordingFormats)[number]

/** Where the recording of a call lives in the recording store: `<workspace>/<call>.<format>`. */
export const recordingKey = (workspaceId: string, callId: string, format: RecordingFormat = 'ogg') => `${workspaceId}/${callId}.${format}`

const KEY_PATTERN = new RegExp(`^[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\\.(${recordingFormats.join('|')})$`)
/** True for keys of the shape `recordingKey` builds: two plain segments, no dots or slashes inside them. */
export const isRecordingKey = (key: string) => KEY_PATTERN.test(key)

// The agent reports that the recording of a call is final; the server derives the key. Members play
// it through GET /v1/calls/<id>/recording.
export const callSetRecording = defineAction({
  name: 'call.setRecording',
  description: 'Mark the recording of a call as final. The server derives where it is stored.',
  input: callId.extend({ format: z.enum(recordingFormats).default('ogg') }),
  permission: 'agent',
})
