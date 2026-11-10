// Inbox views are derived, never stored: does a person still have to act? (architecture §9)
import type { Call, Contact } from '@callfront/db/types'
import { parseTs } from './time.ts'

export type InboxTab = 'you' | 'ai' | 'spam' | 'reminders' | 'done'
export const tabs: [InboxTab, string][] = [['you', 'Needs you'], ['ai', 'Handled by Maya'], ['spam', 'Spam']]

const needsPerson = new Set<Call['outcome']>(['callback', 'message', 'hangup'])

export function tabOf(call: Call, now = new Date()): InboxTab {
  if (call.inbox_state === 'done') return 'done'
  if (call.reminder_at && parseTs(call.reminder_at) > now) return 'reminders'
  if (call.outcome === 'spam') return 'spam'
  if (call.status === 'live' || call.urgency === 'urgent' || needsPerson.has(call.outcome)) return 'you'
  return 'ai'
}

export function listFor(calls: Call[], tab: InboxTab, now = new Date()): Call[] {
  return calls
    .filter(c => !c.deleted_at && tabOf(c, now) === tab)
    .sort((a, b) => Number(b.status === 'live') - Number(a.status === 'live') || parseTs(b.started_at).getTime() - parseTs(a.started_at).getTime())
}

export function countsFor(calls: Call[], now = new Date()): Record<InboxTab, number> {
  const counts: Record<InboxTab, number> = { you: 0, ai: 0, spam: 0, reminders: 0, done: 0 }
  for (const c of calls) if (!c.deleted_at) counts[tabOf(c, now)]++
  return counts
}

export const callerName = (call: Call, contact?: Contact) => contact?.name || formatPhone(call.from_number)

export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164
}

export function statusLabel(call: Call): { text: string; tone: 'danger' | 'neutral' | 'plain' } | null {
  if (call.status === 'live') return { text: 'Live', tone: 'plain' }
  if (call.reminder_label && call.inbox_state === 'open') return { text: call.reminder_label, tone: 'neutral' }
  if (call.urgency === 'urgent') return { text: 'Urgent callback', tone: 'danger' }
  if (call.outcome === 'hangup') return { text: 'Missed', tone: 'danger' }
  if (call.outcome === 'spam') return { text: 'Blocked', tone: 'neutral' }
  const next = call.action_items.find(i => !i.done)?.text
  if (next) return { text: next, tone: 'plain' }
  if (call.outcome === 'booked') return { text: 'Booked', tone: 'neutral' }
  return null
}
