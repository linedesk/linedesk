// What each triage action sends and how it is undone: registry actions and their inverses.
import { actions } from '@linedesk/actions'
import type { Call, Contact } from '@linedesk/db/types'
import { parseTs } from '../time.ts'
import type { ReminderOption } from './remind.ts'

export type Step = [action: string, input: Record<string, unknown>]
export type Change = { steps: Step[]; inverse: Step[]; label: string; key: string }

const id = (call: Call) => ({ callId: call.id })

/** The row after the steps' patches, to see what a change does before it is sent. */
export function preview(call: Call, steps: Step[], now = new Date().toISOString()): Call {
  const row = { ...call }
  for (const [name, input] of steps) Object.assign(row, actions.get(name)?.patch?.set(input, now))
  return row
}

/** True when the steps would leave the row as it is (for example E on a call that is already done). */
export function isNoOp(call: Call, steps: Step[]): boolean {
  const after = preview(call, steps) as Record<string, unknown>
  return Object.entries(after).every(
    ([field, value]) => JSON.stringify(value) === JSON.stringify((call as Record<string, unknown>)[field]),
  )
}

const remindStep = (call: Call): Step => [
  'call.remind',
  {
    callId: call.id,
    at: parseTs(call.reminder_at!).toISOString(),
    ...(call.reminder_label ? { label: call.reminder_label } : {}),
  },
]
const restoreReminder = (call: Call): Step[] =>
  call.reminder_at ? [remindStep(call)] : [['call.clearReminder', id(call)]]

export const doneChange = (call: Call): Change => ({
  steps: [['call.markDone', id(call)]],
  inverse: [['call.markNotDone', id(call)], ...(call.unread ? [['call.markUnread', id(call)] satisfies Step] : [])],
  label: 'Marked done.',
  key: 'E',
})

export const notDoneChange = (call: Call): Change => ({
  steps: [['call.markNotDone', id(call)]],
  inverse: [['call.markDone', id(call)]],
  label: 'Marked not done.',
  key: '⇧E',
})

export const unreadChange = (call: Call): Change => ({
  steps: [[call.unread ? 'call.markRead' : 'call.markUnread', id(call)]],
  inverse: [[call.unread ? 'call.markUnread' : 'call.markRead', id(call)]],
  label: call.unread ? 'Marked read.' : 'Marked unread.',
  key: 'U',
})

/** Reminding a done call reopens it, so the reminder can bring it back. */
export function remindChange(call: Call, option: ReminderOption): Change {
  const wasDone = call.inbox_state === 'done'
  return {
    steps: [
      ...(wasDone ? [['call.markNotDone', id(call)] satisfies Step] : []),
      ['call.remind', { callId: call.id, at: option.at.toISOString(), label: option.label }],
    ],
    inverse: [...restoreReminder(call), ...(wasDone ? [['call.markDone', id(call)] satisfies Step] : [])],
    // "tomorrow morning" reads lowercase in the sentence; a typed time ("Fri 2:00 PM") keeps its form.
    label: `Reminder set: ${/\d/.test(option.label) ? option.label : option.label.toLowerCase()}.`,
    key: 'H',
  }
}

/** Spam or not (!): a sales call that got through goes to Spam; a real caller misfiled as spam goes back to Needs you. */
/** Block the caller's number (⇧B), which also files this call in Spam; or unblock it. */
export function blockChange(call: Call, contact: Contact): Change {
  const contactId = { contactId: contact.id }
  if (contact.blocked_at) {
    return {
      steps: [['contact.unblock', contactId]],
      inverse: [['contact.block', contactId]],
      label: 'Number unblocked.',
      key: '⇧B',
    }
  }
  const toSpam = call.outcome === 'spam' ? null : spamChange(call)
  return {
    steps: [['contact.block', contactId], ...(toSpam?.steps ?? [])],
    inverse: [['contact.unblock', contactId], ...(toSpam?.inverse ?? [])],
    label: 'Number blocked: its calls go to Spam.',
    key: '⇧B',
  }
}

export function spamChange(call: Call): Change {
  if (call.outcome !== 'spam') {
    return {
      steps: [['call.markSpam', id(call)]],
      inverse: [
        ['call.markNotSpam', { ...id(call), ...(call.outcome ? { outcome: call.outcome } : {}) }],
        ...(call.inbox_state === 'done' ? [['call.markDone', id(call)] satisfies Step] : []),
        ...(call.unread ? [['call.markUnread', id(call)] satisfies Step] : []),
      ],
      label: 'Moved to Spam.',
      key: '!',
    }
  }
  return {
    steps: [['call.markNotSpam', id(call)]],
    inverse: [
      ['call.markSpam', id(call)],
      ...(call.inbox_state === 'done' ? [['call.markDone', id(call)] satisfies Step] : []),
    ],
    label: 'Not spam: back in Needs you.',
    key: '!',
  }
}

export const clearReminderChange = (call: Call): Change => ({
  steps: [['call.clearReminder', id(call)]],
  inverse: call.reminder_at ? [remindStep(call)] : [],
  label: 'Reminder cleared.',
  key: '⇧H',
})

/** A: the call is yours; on a call that is already yours, nobody's. */
export const assignChange = (call: Call, me: string): Change => {
  const mine = call.assignee_id === me
  return {
    steps: [['call.assign', { ...id(call), userId: mine ? null : me }]],
    inverse: [['call.assign', { ...id(call), userId: call.assignee_id }]],
    label: mine ? 'Unassigned.' : 'Assigned to you.',
    key: 'A',
  }
}

export const deleteChange = (call: Call): Change => ({
  steps: [['call.delete', id(call)]],
  inverse: [['call.restore', id(call)]],
  label: 'Deleted.',
  key: '#',
})
