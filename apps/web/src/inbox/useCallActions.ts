// Triage actions on a call. Each one runs registry actions through the outbox, fades the row
// out when it leaves the current view, moves on to the next call and can be undone.
import type { Call } from '@linedesk/db/types'
import { useRef, useState } from 'react'
import { type InboxTab, tabOf } from '../inbox-model.ts'
import type { Toaster } from '../shell/useToast.ts'
import { useRun, useTable } from '../store.tsx'
import {
  assignChange,
  blockChange,
  type Change,
  clearReminderChange,
  deleteChange,
  doneChange,
  eraseChange,
  isNoOp,
  notDoneChange,
  preview,
  remindChange,
  type Step,
  spamChange,
  unreadChange,
} from './changes.ts'
import type { ReminderOption } from './remind.ts'
import { i18n } from '../i18n/index.tsx'

/** `cancelWrite` stops a write that is still waiting for the fade; true when it had not been sent yet. */
/** `page`: a change made on a page (not a call); undoing it stays on that page. */
type UndoEntry = {
  steps: Step[]
  callId: string
  tab: InboxTab
  wasOpen: boolean
  cancelWrite: () => boolean
  page?: true
  /** Undoes a change that is not a list of steps (the go-live checklist's "Not needed", with its cached read). */
  revert?: () => void
}

const LEAVE_MS = 170
const ENTER_MS = 260
const UNDO_DEPTH = 10
const liveNote = () => i18n().t('inbox.toast.live')

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
  /** The signed-in member's user id: toasts say "you" for them. */
  me: string
}

export function useCallActions({ list, tab, searching, openId, setTab, setCursor, showCall, toaster, me }: Context) {
  const run = useRun()
  const contacts = useTable('contacts')
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

  function act(call: Call, { steps, inverse, label, key, onLive, final }: Change) {
    if (call.status === 'live' && !onLive) return toaster.show(liveNote())
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
    if (final) return toaster.show(label)
    undoStack.current = [...undoStack.current, { steps: inverse, callId: call.id, tab, wasOpen, cancelWrite }].slice(
      -UNDO_DEPTH,
    )
    toaster.show(toaster.withTip(label, key), true)
  }

  /** The same change on several calls: sent at once, one toast, one undo for all of them. */
  function actMany(calls: Call[], make: (call: Call) => Change | null, label: (n: number) => string) {
    const changes = calls
      .map(c => ({ call: c, change: make(c) }))
      .filter((x): x is { call: Call; change: Change } => !!x.change && !isNoOp(x.call, x.change.steps))
      .filter(x => x.call.status !== 'live' || x.change.onLive)
    if (!changes.length) return toaster.show(calls.some(c => c.status === 'live') ? liveNote() : i18n().t('inbox.toast.nothingToChange'))
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
    if (changes.every(x => x.change.final)) return toaster.show(label(changes.length))
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

  function undo() {
    const entry = undoStack.current.pop()
    if (!entry) return toaster.show(i18n().t('inbox.toast.nothingToUndo'))
    const neverSent = entry.cancelWrite()
    if (!neverSent) entry.revert ? entry.revert() : runAll(entry.steps)
    if (entry.page) return toaster.show(toaster.withTip(i18n().t('inbox.toast.undone'), 'Z'))
    setTab(entry.tab)
    setCursor(entry.callId)
    if (entry.wasOpen) showCall(entry.callId)
    else if (!neverSent) {
      setEntering(entry.callId)
      setTimeout(() => setEntering(null), ENTER_MS)
    }
    toaster.show(toaster.withTip(i18n().t('inbox.toast.undone'), 'Z'))
  }

  /** A change outside the inbox (a contact deleted on the Contacts page): sent now, one toast, undone with Z. */
  function runUndoable(steps: Step[], inverse: Step[], label: string, key: string) {
    runAll(steps)
    undoStack.current = [
      ...undoStack.current,
      { steps: inverse, callId: '', tab, wasOpen: false, cancelWrite: () => false, page: true as const },
    ].slice(-UNDO_DEPTH)
    toaster.show(toaster.withTip(label, key), true)
  }

  /** A change made elsewhere that undoes itself (`revert`): one toast with Undo, undone with Z like the rest. */
  function undoable(label: string, key: string, revert: () => void) {
    undoStack.current = [
      ...undoStack.current,
      { steps: [], callId: '', tab, wasOpen: false, cancelWrite: () => false, page: true as const, revert },
    ].slice(-UNDO_DEPTH)
    toaster.show(toaster.withTip(label, key), true)
  }

  return {
    leaving,
    entering,
    undo,
    runUndoable,
    undoable,
    markDone: (call: Call) =>
      call.inbox_state === 'done' ? toaster.show(i18n().t('inbox.toast.alreadyDone')) : act(call, doneChange(call)),
    markNotDone: (call: Call) =>
      call.inbox_state === 'done' ? act(call, notDoneChange(call)) : toaster.show(i18n().t('inbox.toast.notDone')),
    toggleUnread: (call: Call) => act(call, unreadChange(call)),
    remind: (call: Call, option: ReminderOption) => act(call, remindChange(call, option)),
    clearReminder: (call: Call) =>
      tabOf(call) === 'reminders' ? act(call, clearReminderChange(call)) : toaster.show(i18n().t('inbox.toast.noReminder')),
    remove: (call: Call) => act(call, deleteChange(call)),
    /** Delete permanently now (owners and admins, call:erase): no undo. */
    erase: (call: Call) => act(call, eraseChange(call)),
    /** Assign to a member (null: nobody); `who` names them in the toast. */
    assign: (call: Call, userId: string | null, who: string) =>
      act(call, assignChange(call, userId, userId === me ? i18n().t('inbox.change.you') : who)),
    toggleSpam: (call: Call) => act(call, spamChange(call)),
    toggleBlock: (call: Call) => {
      const contact = call.contact_id ? contacts.get(call.contact_id) : undefined
      if (!contact) return toaster.show(i18n().t('inbox.toast.noContactToBlock'))
      act(call, blockChange(call, contact))
    },
    many: {
      markDone: (list: Call[]) =>
        actMany(
          list,
          c => (c.inbox_state === 'done' ? null : doneChange(c)),
          n => i18n().t('inbox.many.done', { count: n }),
        ),
      markNotDone: (list: Call[]) =>
        actMany(
          list,
          c => (c.inbox_state === 'done' ? notDoneChange(c) : null),
          n => i18n().t('inbox.many.notDone', { count: n }),
        ),
      /** Mark all read when any is unread, else mark all unread. */
      toggleUnread: (list: Call[]) => {
        const read = list.some(c => c.unread)
        actMany(
          list,
          c => (c.unread === read ? unreadChange(c) : null),
          n => (read ? i18n().t('inbox.many.read', { count: n }) : i18n().t('inbox.many.unread', { count: n })),
        )
      },
      remind: (list: Call[], option: ReminderOption) =>
        actMany(
          list,
          c => remindChange(c, option),
          n => i18n().t('inbox.many.reminderSet', { count: n }),
        ),
      clearReminder: (list: Call[]) =>
        actMany(
          list,
          c => (tabOf(c) === 'reminders' ? clearReminderChange(c) : null),
          n => i18n().t('inbox.many.reminderCleared', { count: n }),
        ),
      remove: (list: Call[]) => actMany(list, deleteChange, n => i18n().t('inbox.many.deleted', { count: n })),
      erase: (list: Call[]) =>
        actMany(list, eraseChange, n => i18n().t('inbox.many.deletedPermanently', { count: n })),
      assign: (list: Call[], userId: string | null, who: string) =>
        actMany(
          list,
          c => assignChange(c, userId, who),
          n =>
            userId
              ? i18n().t('inbox.many.assigned', { count: n, who: userId === me ? i18n().t('inbox.change.you') : who })
              : i18n().t('inbox.many.unassigned', { count: n }),
        ),
      /** All to Spam, unless all of them are spam already: then all back to Needs you. */
      toggleSpam: (list: Call[]) => {
        const toSpam = list.some(c => c.outcome !== 'spam')
        actMany(
          list,
          c => ((c.outcome === 'spam') === toSpam ? null : spamChange(c)),
          n => (toSpam ? i18n().t('inbox.many.spam', { count: n }) : i18n().t('inbox.many.notSpam', { count: n })),
        )
      },
    },
    isTriageable: (call: Call) => {
      if (call.status === 'live') toaster.show(liveNote())
      return call.status !== 'live'
    },
  }
}
export type CallActions = ReturnType<typeof useCallActions>
