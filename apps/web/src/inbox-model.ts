// Inbox views are derived, never stored: does a person still have to act? (architecture §9)
import type { Call, Contact, TranscriptSegment } from '@linedesk/db/types'
import { parseTs, whenLabel } from './time.ts'

/**
 * `mine`: calls assigned to the signed-in member that are still open; `member`: the same for another
 * member (the route names them); `unassigned`: Needs you calls nobody has taken. Filters, not places of their own.
 */
export type InboxTab = 'you' | 'ai' | 'spam' | 'reminders' | 'done' | 'mine' | 'member' | 'unassigned'
/** The views that list calls by who they are assigned to. */
export const assigneeTabs: readonly InboxTab[] = ['mine', 'member', 'unassigned']
/** The three views Tab cycles through. Reminders, Done and Assigned to me are modes outside the cycle. */
export const splits = ['you', 'ai', 'spam'] as const satisfies readonly InboxTab[]
/** The views shown as tabs and cycled with Tab: Spam only while there is a spam call, or while it is open. */
export const visibleSplits = (counts: Record<InboxTab, number>, tab: InboxTab): (typeof splits)[number][] =>
  splits.filter(s => s !== 'spam' || counts.spam > 0 || tab === 'spam')
export const viewByKey: Record<string, InboxTab> = { 1: 'you', 2: 'ai', 3: 'spam', 4: 'reminders', 5: 'done' }

const needsPerson = new Set<Call['outcome']>(['callback', 'message', 'hangup'])

export function tabOf(call: Call, now = new Date()): InboxTab {
  if (call.inbox_state === 'done') return 'done'
  if (hasReminder(call, now)) return 'reminders'
  if (call.outcome === 'spam') return 'spam'
  if (call.status === 'live' || call.urgency === 'urgent' || needsPerson.has(call.outcome)) return 'you'
  return 'ai'
}

/**
 * The view to show after opening a call: the one it lives in, unless the current view lists it
 * (Assigned to me cuts across the views, and up/down must keep walking that list).
 */
export function viewForOpened(call: Call, tab: InboxTab, list: readonly Call[], now = new Date()): InboxTab {
  return list.some(c => c.id === call.id) ? tab : tabOf(call, now)
}

export const hasReminder = (call: Call, now = new Date()) => !!call.reminder_at && parseTs(call.reminder_at) > now

const startedMs = (call: Call) => parseTs(call.started_at).getTime()
/** A call in progress on top, then newest first, in every view (Reminders sort by when they come back, see listFor). */
export function sortForList(calls: Call[]): Call[] {
  const live = (c: Call) => (c.status === 'live' ? 0 : 1)
  return [...calls].sort((a, b) => live(a) - live(b) || startedMs(b) - startedMs(a))
}

/** Assigned to `userId` and still open: not done, not spam. */
const isOpenFor = (call: Call, userId: string | null, now: Date) => {
  if (!userId || call.assignee_id !== userId) return false
  const tab = tabOf(call, now)
  return tab !== 'done' && tab !== 'spam'
}

/** In Needs you and nobody has taken it. */
const isUnassigned = (call: Call, now: Date) => !call.assignee_id && tabOf(call, now) === 'you'

export function listFor(
  calls: Call[],
  tab: InboxTab,
  now = new Date(),
  me: string | null = null,
  member: string | null = null,
): Call[] {
  const visible = calls.filter(c => !c.deleted_at)
  if (tab === 'mine') return sortForList(visible.filter(c => isOpenFor(c, me, now)))
  if (tab === 'member') return sortForList(visible.filter(c => isOpenFor(c, member, now)))
  if (tab === 'unassigned') return sortForList(visible.filter(c => isUnassigned(c, now)))
  const inTab = visible.filter(c => tabOf(c, now) === tab)
  // Reminders read as a schedule: the one that comes back first is on top.
  if (tab === 'reminders')
    return inTab.sort((a, b) => parseTs(a.reminder_at!).getTime() - parseTs(b.reminder_at!).getTime())
  return sortForList(inTab)
}

/** Every view counts rows, so repeat hang-ups from one number count once (see groupRepeats). */
export function countsFor(
  calls: Call[],
  now = new Date(),
  me: string | null = null,
  member: string | null = null,
): Record<InboxTab, number> {
  const counts: Record<InboxTab, number> = {
    you: 0,
    ai: 0,
    spam: 0,
    reminders: 0,
    done: 0,
    mine: 0,
    member: 0,
    unassigned: 0,
  }
  const inView: Record<InboxTab, Call[]> = {
    you: [],
    ai: [],
    spam: [],
    reminders: [],
    done: [],
    mine: [],
    member: [],
    unassigned: [],
  }
  for (const c of calls) {
    if (c.deleted_at) continue
    inView[tabOf(c, now)].push(c)
    if (isOpenFor(c, me, now)) inView.mine.push(c)
    if (isOpenFor(c, member, now)) inView.member.push(c)
    if (isUnassigned(c, now)) inView.unassigned.push(c)
  }
  // The rows a view shows do not depend on its order, so the calls are grouped unsorted.
  for (const tab of Object.keys(counts) as InboxTab[]) counts[tab] = groupRepeats(inView[tab]).list.length
  return counts
}

/** Row id -> every call the row stands for (the row's own call first). Only rows that stand for more than one call. */
export type CallGroups = ReadonlyMap<string, Call[]>

const foldable = (c: Call) => c.outcome === 'hangup' && c.status !== 'live' && c.from_number.startsWith('+')

/**
 * Repeat calls from one number that left nothing to act on (hang-ups and missed calls) fold into one row,
 * so ten hang-ups are one line, not ten. They join the newest real call from that number in the list
 * (its issue stays the title), else the newest of them. Calls with an issue of their own keep their rows.
 * Every inbox view groups its own list this way (Needs you, Handled, Spam, Reminders, Done, the assignee
 * views); search lists single calls (each hit is one call, from any view), and so does a contact's history.
 */
export function groupRepeats(list: Call[]): { list: Call[]; groups: CallGroups } {
  const anchorOf = new Map<string, Call>()
  for (const c of list) {
    if (c.status === 'live' || !c.from_number.startsWith('+')) continue
    const seen = anchorOf.get(c.from_number)
    const better =
      !seen || (foldable(seen) && !foldable(c)) || (foldable(seen) === foldable(c) && startedMs(c) > startedMs(seen))
    if (better) anchorOf.set(c.from_number, c)
  }
  const groups = new Map<string, Call[]>()
  const rows: Call[] = []
  for (const c of list) {
    const anchor = foldable(c) ? anchorOf.get(c.from_number) : undefined
    if (!anchor || anchor === c) {
      rows.push(c)
      continue
    }
    groups.set(anchor.id, [...(groups.get(anchor.id) ?? [anchor]), c])
  }
  return { list: rows, groups }
}

/**
 * How a call went: the one answer for the row badge, the call header and the transcript.
 * `missed`: nobody picked up (the assistant was not running or not set up). `hungUp`: the assistant
 * answered and the caller left without saying anything. Needs the call's transcript.
 */
export type CallStatus = 'live' | 'missed' | 'hungUp' | 'spam' | 'outbound' | 'answered'
export function callStatus(call: Call, segments: TranscriptSegment[]): CallStatus {
  if (call.status === 'live') return 'live'
  if (call.direction === 'out') return 'outbound'
  if (call.outcome === 'spam') return 'spam'
  if (call.outcome !== 'hangup') return 'answered'
  return segments.some(s => s.speaker === 'agent' || s.speaker === 'human') ? 'hungUp' : 'missed'
}

/** One word per status, the same in the row, the call header and in place of the transcript. */
export const STATUS_WORD = { missed: 'Missed', hungUp: 'Hung up' } as const

/** The call header's "who answered" part. */
export function answeredByLabel(call: Call, segments: TranscriptSegment[], assistant: string): string {
  const status = callStatus(call, segments)
  if (status === 'missed') return STATUS_WORD.missed
  if (status === 'spam') return `Blocked by ${assistant}`
  if (status === 'outbound') return `Outbound call by ${assistant}`
  const who = call.answered_by === 'human' ? 'the team' : assistant
  return status === 'hungUp' ? `Answered by ${who}, caller hung up` : `Answered by ${who}`
}

/** A deleted contact no longer names the call: the number does. */
export const callerName = (call: Call, contact?: Contact) =>
  (!contact?.deleted_at && contact?.name) || formatPhone(call.from_number)
export const callTitle = (call: Call) => call.title ?? (call.status === 'live' ? 'Call in progress' : 'Call')

export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164
}

/** How a warm transfer during the call went, for the call's header; null when there was none. */
export function transferText(
  call: Pick<Call, 'transfer_to' | 'transfer_result'> & Partial<Pick<Call, 'transfer_name'>>,
): string | null {
  if (!call.transfer_result) return null
  const number = call.transfer_to ? formatPhone(call.transfer_to) : null
  const to = call.transfer_name
    ? number
      ? `${call.transfer_name} (${number})`
      : call.transfer_name
    : (number ?? 'the on-call phone')
  if (call.transfer_result === 'connected') return `Transferred to ${to}`
  if (call.transfer_result === 'dialing') return `Transferring to ${to}`
  if (call.transfer_result === 'declined') return `Transfer declined by ${to}`
  if (call.transfer_result === 'failed') return 'Transfer could not be placed'
  return 'Transfer not answered'
}

export type StatusLabel = { text: string; tone: 'danger' | 'neutral' | 'info' | 'next' | 'quiet' }

/** The status column of a row (a live call shows the live indicator instead). */
export function statusLabel(
  call: Call,
  tab: InboxTab,
  assistantName: string,
  now = new Date(),
  segments: TranscriptSegment[] = [],
): StatusLabel {
  const next = call.action_items.find(i => !i.done)?.text
  if (hasReminder(call, now) && call.inbox_state === 'open')
    return { text: whenLabel(parseTs(call.reminder_at!), now), tone: 'neutral' }
  if (call.urgency === 'urgent') return { text: 'Urgent callback', tone: 'danger' }
  if (call.outcome === 'transferred') return { text: 'Transferred', tone: 'info' }
  if (call.outcome === 'hangup')
    return callStatus(call, segments) === 'hungUp'
      ? { text: STATUS_WORD.hungUp, tone: 'quiet' }
      : { text: STATUS_WORD.missed, tone: 'danger' }
  if (call.outcome === 'spam') return { text: 'Blocked', tone: 'neutral' }
  if (next && tab === 'you') return { text: next, tone: 'next' }
  if (call.direction === 'out') return { text: 'Outbound', tone: 'quiet' }
  return { text: tabOf(call, now) === 'ai' ? `Resolved by ${assistantName}` : (next ?? 'Follow-up'), tone: 'quiet' }
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
