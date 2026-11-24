// What each triage action sends and how it is undone: registry actions and their inverses.
import { actions } from '@linedesk/actions'
import type { Call, Contact } from '@linedesk/db/types'
import { parseTs } from '../time.ts'
import type { ReminderOption } from './remind.ts'
import { i18n } from '../i18n/index.tsx'

export type Step = [action: string, input: Record<string, unknown>]
/**
 * `onLive`: the change is fine while the call is still going (assigning it). `final`: it cannot be undone (a call
 * deleted permanently): no Undo in the toast, nothing on the undo stack.
 */
export type Change = { steps: Step[]; inverse: Step[]; label: string; key: string; onLive?: true; final?: true }

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
  label: i18n().t('inbox.change.done'),
  key: 'E',
})

export const notDoneChange = (call: Call): Change => ({
  steps: [['call.markNotDone', id(call)]],
  inverse: [['call.markDone', id(call)]],
  label: i18n().t('inbox.change.notDone'),
  key: '⇧E',
})

export const unreadChange = (call: Call): Change => ({
  steps: [[call.unread ? 'call.markRead' : 'call.markUnread', id(call)]],
  inverse: [[call.unread ? 'call.markUnread' : 'call.markRead', id(call)]],
  label: call.unread ? i18n().t('inbox.change.read') : i18n().t('inbox.change.unread'),
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
    label: i18n().t('inbox.change.reminderSet', { when: option.inline ?? option.label }),
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
      label: i18n().t('inbox.change.unblocked'),
      key: '⇧B',
    }
  }
  const toSpam = call.outcome === 'spam' ? null : spamChange(call)
  return {
    steps: [['contact.block', contactId], ...(toSpam?.steps ?? [])],
    inverse: [['contact.unblock', contactId], ...(toSpam?.inverse ?? [])],
    label: i18n().t('inbox.change.blocked'),
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
      label: i18n().t('inbox.change.spam'),
      key: '!',
    }
  }
  return {
    steps: [['call.markNotSpam', id(call)]],
    inverse: [
      ['call.markSpam', id(call)],
      ...(call.inbox_state === 'done' ? [['call.markDone', id(call)] satisfies Step] : []),
    ],
    label: i18n().t('inbox.change.notSpam'),
    key: '!',
  }
}

export const clearReminderChange = (call: Call): Change => ({
  steps: [['call.clearReminder', id(call)]],
  inverse: call.reminder_at ? [remindStep(call)] : [],
  label: i18n().t('inbox.change.reminderCleared'),
  key: '⇧H',
})

/**
 * Assign the call to `userId` (null: nobody). `who` names them in the toast ("you", "Sam"). Undo puts
 * the call back without telling the previous assignee again (notify: false).
 */
export const assignChange = (call: Call, userId: string | null, who: string): Change => ({
  steps: [['call.assign', { ...id(call), userId }]],
  inverse: [['call.assign', { ...id(call), userId: call.assignee_id, notify: false }]],
  label: userId ? i18n().t('inbox.change.assigned', { who }) : i18n().t('inbox.change.unassigned'),
  key: 'A',
  onLive: true,
})

export const deleteChange = (call: Call): Change => ({
  steps: [['call.delete', id(call)]],
  inverse: [['call.restore', id(call)]],
  label: i18n().t('inbox.change.deleted'),
  key: '#',
})

/** Deleted permanently now (owners and admins): erased at once instead of after 30 days, so no undo. */
export const eraseChange = (call: Call): Change => ({
  steps: [['call.delete', { ...id(call), permanent: true }]],
  inverse: [],
  label: i18n().t('inbox.change.deletedPermanently'),
  key: '',
  final: true,
})
