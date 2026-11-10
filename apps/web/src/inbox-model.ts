// Inbox views are derived, never stored: does a person still have to act? (architecture §9)
import type { Call, Contact } from '@callfront/db/types'
import { parseTs } from './time.ts'

export type InboxTab = 'you' | 'ai' | 'spam' | 'reminders' | 'done'
/** The three splits Tab cycles through. Reminders and Done are modes outside the cycle. */
export const splits = ['you', 'ai', 'spam'] as const satisfies readonly InboxTab[]
export const viewByKey: Record<string, InboxTab> = { 1: 'you', 2: 'ai', 3: 'spam', 4: 'reminders', 5: 'done' }

const needsPerson = new Set<Call['outcome']>(['callback', 'message', 'hangup'])

export function tabOf(call: Call, now = new Date()): InboxTab {
  if (call.inbox_state === 'done') return 'done'
  if (hasReminder(call, now)) return 'reminders'
  if (call.outcome === 'spam') return 'spam'
  if (call.status === 'live' || call.urgency === 'urgent' || needsPerson.has(call.outcome)) return 'you'
  return 'ai'
}

export const hasReminder = (call: Call, now = new Date()) => !!call.reminder_at && parseTs(call.reminder_at) > now

const startedMs = (call: Call) => parseTs(call.started_at).getTime()
const dayStartMs = (call: Call) => { const d = parseTs(call.started_at); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }

/** Ids of calls that are the first one from their number. */
export function firstCallIds(calls: Call[]): Set<string> {
  const first = new Map<string, Call>()
  for (const c of calls) {
    const seen = first.get(c.from_number)
    if (!seen || startedMs(c) < startedMs(seen)) first.set(c.from_number, c)
  }
  return new Set([...first.values()].map(c => c.id))
}

/** Needs you, inside a day: live, urgent, new-caller callbacks, other callbacks, messages, hang-ups. */
export function priorityOf(call: Call, isNewCaller: boolean): number {
  if (call.status === 'live') return 0
  if (call.urgency === 'urgent') return 1
  if (call.outcome === 'callback') return isNewCaller ? 2 : 3
  if (call.outcome === 'message') return 4
  if (call.outcome === 'hangup') return 5
  return 6
}

/** Days newest first; inside each calendar day by priority (Needs you only), then newest first. */
export function sortForList(calls: Call[], byPriority: boolean, all: Call[] = calls): Call[] {
  const firsts = byPriority ? firstCallIds(all) : new Set<string>()
  const key = (c: Call) => [-dayStartMs(c), byPriority ? priorityOf(c, firsts.has(c.id)) : 0, -startedMs(c)] as const
  const keys = new Map(calls.map(c => [c.id, key(c)]))
  return [...calls].sort((a, b) => {
    const ka = keys.get(a.id)!, kb = keys.get(b.id)!
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2]
  })
}

export function listFor(calls: Call[], tab: InboxTab, now = new Date()): Call[] {
  const visible = calls.filter(c => !c.deleted_at)
  return sortForList(visible.filter(c => tabOf(c, now) === tab), tab === 'you', visible)
}

export function countsFor(calls: Call[], now = new Date()): Record<InboxTab, number> {
  const counts: Record<InboxTab, number> = { you: 0, ai: 0, spam: 0, reminders: 0, done: 0 }
  for (const c of calls) if (!c.deleted_at) counts[tabOf(c, now)]++
  return counts
}

export const callerName = (call: Call, contact?: Contact) => contact?.name || formatPhone(call.from_number)
export const callTitle = (call: Call) => call.title ?? (call.status === 'live' ? 'Call in progress' : 'Call')

export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164
}

export type StatusLabel = { text: string; tone: 'danger' | 'neutral' | 'info' | 'next' | 'quiet' }

/** The status column of a row (a live call shows the live indicator instead). */
export function statusLabel(call: Call, tab: InboxTab, assistantName: string, now = new Date()): StatusLabel {
  const next = call.action_items.find(i => !i.done)?.text
  if (call.reminder_label && hasReminder(call, now) && call.inbox_state === 'open') return { text: call.reminder_label, tone: 'neutral' }
  if (call.outcome === 'booked') return { text: 'Booked', tone: 'neutral' }
  if (call.urgency === 'urgent') return { text: 'Urgent callback', tone: 'danger' }
  if (call.outcome === 'transferred') return { text: 'Transferred', tone: 'info' }
  if (call.outcome === 'hangup') return { text: 'Missed', tone: 'danger' }
  if (call.outcome === 'spam') return { text: 'Blocked', tone: 'neutral' }
  if (next && tab === 'you') return { text: next, tone: 'next' }
  if (call.direction === 'out') return { text: 'Outbound', tone: 'quiet' }
  return { text: tabOf(call, now) === 'ai' ? `Resolved by ${assistantName}` : next ?? 'Follow-up', tone: 'quiet' }
}

/**
 * Where the cursor is after the list changed. It stays on the same call; if that call left the
 * list it moves to the nearest former neighbour (next first), so E never hits an unrelated row.
 */
export function resolveCursor(ids: string[], cursorId: string | null, previousIds: string[]): string | null {
  if (cursorId && ids.includes(cursorId)) return cursorId
  const was = cursorId ? previousIds.indexOf(cursorId) : -1
  if (was < 0) return ids[0] ?? null
  const present = new Set(ids)
  const neighbour = [...previousIds.slice(was + 1), ...previousIds.slice(0, was).reverse()].find(id => present.has(id))
  return neighbour ?? ids[0] ?? null
}
