// Triage actions on a call. Each one runs registry actions through the outbox, fades the row
// out when it leaves the current view, moves on to the next call and can be undone.
import type { Call } from '@callfront/db/types'
import { useRef, useState } from 'react'
import { tabOf, type InboxTab } from '../inbox-model.ts'
import type { Toaster } from '../shell/useToast.ts'
import { useRun } from '../store.tsx'
import {
  type Change,
  clearReminderChange,
  deleteChange,
  doneChange,
  isNoOp,
  notDoneChange,
  preview,
  remindChange,
  spamChange,
  type Step,
  unreadChange,
} from './changes.ts'
import type { ReminderOption } from './remind.ts'

/** `cancelWrite` stops a write that is still waiting for the fade; true when it had not been sent yet. */
type UndoEntry = { steps: Step[]; callId: string; tab: InboxTab; wasOpen: boolean; cancelWrite: () => boolean }

const LEAVE_MS = 170
const ENTER_MS = 260
const UNDO_DEPTH = 10
const LIVE_NOTE = 'A live call can be triaged once it has ended.'

type Context = {
  list: Call[]
  tab: InboxTab
  searching: boolean
  openId: string | null
  setTab: (tab: InboxTab) => void
  setCursor: (id: string | null) => void
  /** Show this call full width (marking it read), or go back to the list with null. */
  showCall: (id: string | null) => void
  toaster: Toaster
}

export function useCallActions({ list, tab, searching, openId, setTab, setCursor, showCall, toaster }: Context) {
  const run = useRun()
  const undoStack = useRef<UndoEntry[]>([])
  const [leaving, setLeaving] = useState<string | null>(null)
  const [entering, setEntering] = useState<string | null>(null)
  const runAll = (steps: Step[]) => {
    for (const [name, input] of steps) void run(name, input)
  }

  /** Send now, or after the row has faded out. Returns how to cancel a write that has not been sent. */
  function write(callId: string, steps: Step[], fadeFirst: boolean): () => boolean {
    if (!fadeFirst) {
      runAll(steps)
      return () => false
    }
    let waiting = true
    setLeaving(callId)
    const timer = setTimeout(() => {
      waiting = false
      runAll(steps)
      setLeaving(null)
    }, LEAVE_MS)
    return () => {
      if (!waiting) return false
      waiting = false
      clearTimeout(timer)
      setLeaving(null)
      return true
    }
  }

  function act(call: Call, { steps, inverse, label, key }: Change) {
    if (call.status === 'live') return toaster.show(LIVE_NOTE)
    if (isNoOp(call, steps)) return // nothing to send, nothing to undo
    const after = preview(call, steps)
    const leaves = !!after.deleted_at || (!searching && tabOf(after) !== tab) // a deleted call leaves every view
    const wasOpen = openId === call.id
    const cancelWrite = write(call.id, steps, leaves && !wasOpen)
    if (leaves) {
      const i = list.findIndex(c => c.id === call.id)
      const next = (list[i + 1] ?? list[i - 1])?.id ?? null
      setCursor(next)
      if (wasOpen) showCall(next)
    }
    undoStack.current = [...undoStack.current, { steps: inverse, callId: call.id, tab, wasOpen, cancelWrite }].slice(
      -UNDO_DEPTH,
    )
    toaster.show(toaster.withTip(label, key), true)
  }

  /** The same change on several calls: sent at once, one toast, one undo for all of them. */
  function actMany(calls: Call[], make: (call: Call) => Change | null, label: (n: number) => string) {
    const changes = calls
      .filter(c => c.status !== 'live')
      .map(c => ({ call: c, change: make(c) }))
      .filter((x): x is { call: Call; change: Change } => !!x.change && !isNoOp(x.call, x.change.steps))
    if (!changes.length) return toaster.show(calls.some(c => c.status === 'live') ? LIVE_NOTE : 'Nothing to change.')
    for (const { change } of changes) runAll(change.steps)
    const leaving = new Set(
      changes
        .filter(({ call, change }) => {
          const after = preview(call, change.steps)
          return !!after.deleted_at || (!searching && tabOf(after) !== tab)
        })
        .map(x => x.call.id),
    )
    if (leaving.size) {
      // The nearest row that stays, after the first one that leaves (then before it), as for one call.
      const first = list.findIndex(c => leaving.has(c.id))
      const stays = (c: Call) => !leaving.has(c.id)
      const next =
        (list.slice(first).find(stays) ?? list.slice(0, Math.max(0, first)).reverse().find(stays))?.id ?? null
      setCursor(next)
      if (openId && leaving.has(openId)) showCall(next) // done from the call view: on to the next call
    }
    const openLeft = !!openId && leaving.has(openId)
    const inverse = changes.flatMap(x => x.change.inverse)
    undoStack.current = [
      ...undoStack.current,
      {
        steps: inverse,
        callId: openLeft ? openId : changes[0]!.call.id,
        tab,
        wasOpen: openLeft,
        cancelWrite: () => false,
      },
    ].slice(-UNDO_DEPTH)
    toaster.show(toaster.withTip(label(changes.length), 'Z'), true)
  }
  const calls = (n: number) => `${n} ${n === 1 ? 'call' : 'calls'}`

  function undo() {
    const entry = undoStack.current.pop()
    if (!entry) return toaster.show('Nothing to undo.')
    const neverSent = entry.cancelWrite()
    if (!neverSent) runAll(entry.steps)
    setTab(entry.tab)
    setCursor(entry.callId)
    if (entry.wasOpen) showCall(entry.callId)
    else if (!neverSent) {
      setEntering(entry.callId)
      setTimeout(() => setEntering(null), ENTER_MS)
    }
    toaster.show(toaster.withTip('Undone.', 'Z'))
  }

  return {
    leaving,
    entering,
    undo,
    markDone: (call: Call) =>
      call.inbox_state === 'done' ? toaster.show('Already done.') : act(call, doneChange(call)),
    markNotDone: (call: Call) =>
      call.inbox_state === 'done' ? act(call, notDoneChange(call)) : toaster.show('This call is not done.'),
    toggleUnread: (call: Call) => act(call, unreadChange(call)),
    remind: (call: Call, option: ReminderOption) => act(call, remindChange(call, option)),
    clearReminder: (call: Call) =>
      tabOf(call) === 'reminders' ? act(call, clearReminderChange(call)) : toaster.show('No reminder on this call.'),
    remove: (call: Call) => act(call, deleteChange(call)),
    toggleSpam: (call: Call) => act(call, spamChange(call)),
    many: {
      markDone: (list: Call[]) =>
        actMany(
          list,
          c => (c.inbox_state === 'done' ? null : doneChange(c)),
          n => `${calls(n)} marked done.`,
        ),
      markNotDone: (list: Call[]) =>
        actMany(
          list,
          c => (c.inbox_state === 'done' ? notDoneChange(c) : null),
          n => `${calls(n)} back in the inbox.`,
        ),
      /** Mark all read when any is unread, else mark all unread. */
      toggleUnread: (list: Call[]) => {
        const read = list.some(c => c.unread)
        actMany(
          list,
          c => (c.unread === read ? unreadChange(c) : null),
          n => `${calls(n)} marked ${read ? 'read' : 'unread'}.`,
        )
      },
      remind: (list: Call[], option: ReminderOption) =>
        actMany(
          list,
          c => remindChange(c, option),
          n => `Reminder set for ${calls(n)}.`,
        ),
      clearReminder: (list: Call[]) =>
        actMany(
          list,
          c => (tabOf(c) === 'reminders' ? clearReminderChange(c) : null),
          n => `Reminder cleared on ${calls(n)}.`,
        ),
      remove: (list: Call[]) => actMany(list, deleteChange, n => `${calls(n)} deleted.`),
      /** All to Spam, unless all of them are spam already: then all back to Needs you. */
      toggleSpam: (list: Call[]) => {
        const toSpam = list.some(c => c.outcome !== 'spam')
        actMany(
          list,
          c => ((c.outcome === 'spam') === toSpam ? null : spamChange(c)),
          n => (toSpam ? `${calls(n)} moved to Spam.` : `${calls(n)} back in Needs you.`),
        )
      },
    },
    isTriageable: (call: Call) => {
      if (call.status === 'live') toaster.show(LIVE_NOTE)
      return call.status !== 'live'
    },
  }
}
export type CallActions = ReturnType<typeof useCallActions>
