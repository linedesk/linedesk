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
