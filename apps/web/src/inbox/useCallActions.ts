// Triage actions on a call. Each one runs registry actions through the outbox, fades the row
// out when it leaves the current view, moves on to the next call and can be undone.
import type { Call } from '@callfront/db/types'
import { useRef, useState } from 'react'
import { tabOf, type InboxTab } from '../inbox-model.ts'
import type { Toaster } from '../shell/useToast.ts'
import { useRun } from '../store.tsx'
import { type Change, clearReminderChange, deleteChange, doneChange, isNoOp, notDoneChange, preview, remindChange, type Step, unreadChange } from './changes.ts'
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
  const runAll = (steps: Step[]) => { for (const [name, input] of steps) void run(name, input) }

  /** Send now, or after the row has faded out. Returns how to cancel a write that has not been sent. */
  function write(callId: string, steps: Step[], fadeFirst: boolean): () => boolean {
    if (!fadeFirst) { runAll(steps); return () => false }
    let waiting = true
    setLeaving(callId)
    const timer = setTimeout(() => { waiting = false; runAll(steps); setLeaving(null) }, LEAVE_MS)
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
    const leaves = searching ? !!after.deleted_at : tabOf(after) !== tab
    const wasOpen = openId === call.id
    const cancelWrite = write(call.id, steps, leaves && !wasOpen)
    if (leaves) {
      const i = list.findIndex(c => c.id === call.id)
      const next = (list[i + 1] ?? list[i - 1])?.id ?? null
      setCursor(next)
      if (wasOpen) showCall(next)
    }
    undoStack.current = [...undoStack.current, { steps: inverse, callId: call.id, tab, wasOpen, cancelWrite }].slice(-UNDO_DEPTH)
    toaster.show(toaster.withTip(label, key), true)
  }

  function undo() {
    const entry = undoStack.current.pop()
    if (!entry) return toaster.show('Nothing to undo.')
    const neverSent = entry.cancelWrite()
    if (!neverSent) runAll(entry.steps)
    setTab(entry.tab)
    setCursor(entry.callId)
    if (entry.wasOpen) showCall(entry.callId)
    else if (!neverSent) { setEntering(entry.callId); setTimeout(() => setEntering(null), ENTER_MS) }
    toaster.show(toaster.withTip('Undone.', 'Z'))
  }

  return {
    leaving,
    entering,
    undo,
    markDone: (call: Call) => act(call, doneChange(call)),
    markNotDone: (call: Call) => (call.inbox_state === 'done' ? act(call, notDoneChange(call)) : toaster.show('This call is not done.')),
    toggleUnread: (call: Call) => act(call, unreadChange(call)),
    remind: (call: Call, option: ReminderOption) => act(call, remindChange(call, option)),
    clearReminder: (call: Call) => (tabOf(call) === 'reminders' ? act(call, clearReminderChange(call)) : toaster.show('No reminder on this call.')),
    remove: (call: Call) => act(call, deleteChange(call)),
    isTriageable: (call: Call) => {
      if (call.status === 'live') toaster.show(LIVE_NOTE)
      return call.status !== 'live'
    },
  }
}
export type CallActions = ReturnType<typeof useCallActions>
