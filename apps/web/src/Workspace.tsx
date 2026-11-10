// The signed-in app: holds what is selected and wires the inbox, overlays, toasts and keyboard.
import type { Call } from '@callfront/db/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { auth, type Me } from './auth.ts'
import { CallView } from './call/CallView.tsx'
import { CustomerSide } from './call/CustomerSide.tsx'
import { useSegmentsByCall } from './call/segments.ts'
import { Inbox } from './inbox/Inbox.tsx'
import { SEARCH_INPUT_ID } from './inbox/InboxHead.tsx'
import { reminderOptions, type ReminderOption } from './inbox/remind.ts'
import { matchesSearch } from './inbox/search.tsx'
import { useCallActions } from './inbox/useCallActions.ts'
import { useCursor } from './inbox/useCursor.ts'
import { countsFor, listFor, sortForList, tabOf, type InboxTab } from './inbox-model.ts'
import { handleKey, type KeyContext, type Overlay } from './shell/keys.ts'
import { Toast } from './shell/Toast.tsx'
import { useNow } from './shell/useNow.ts'
import { useToast, type Source } from './shell/useToast.ts'
import { localDbName, useAssistantName, useRejection, useRows, useRun, useSnapshot } from './store.tsx'
import { Backdrop } from './ui/Backdrop.tsx'
import { CommandMenu } from './ui/CommandMenu.tsx'
import { Button } from './ui/kit.tsx'

const chordTabs: Record<string, InboxTab> = { i: 'you', e: 'done', h: 'reminders' }

export function Workspace({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const calls = useRows('calls')
  const contacts = useSnapshot().tables.contacts
  const segments = useSegmentsByCall()
  const assistantName = useAssistantName()
  const now = useNow()
  const toaster = useToast()
  const [tab, setTabState] = useState<InboxTab>('you')
  const [search, setSearch] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const run = useRun()
  const remindFor = useRef<{ call: Call; source: Source } | null>(null)

  const list = useMemo(() => {
    if (search === null) return listFor(calls, tab, now)
    const hits = calls.filter(c => !c.deleted_at && matchesSearch({ call: c, contact: c.contact_id ? contacts.get(c.contact_id) : undefined, segments: segments.get(c.id) ?? [], assistantName }, search))
    return sortForList(hits, false)
  }, [calls, contacts, segments, assistantName, tab, search, now])
  const counts = useMemo(() => countsFor(calls, now), [calls, now])
  const [cursorId, setCursor] = useCursor(list)
  const openCall = openId ? calls.find(c => c.id === openId && !c.deleted_at) : undefined
  const target = openCall ?? list.find(c => c.id === cursorId)
  const liveCall = useMemo(() => listFor(calls, 'you', now).find(c => c.status === 'live'), [calls, now]) // newest live call

  const setTab = (next: InboxTab) => { setTabState(next); setSearch(null); setCursor(null); setOpenId(null) }
  const actions = useCallActions({ list, tab, searching: search !== null, openId: openCall?.id ?? null, setTab: setTabState, setCursor, setOpenId, toaster })

  /** Open a call full width. Opening marks it read and shows the view it lives in. */
  function open(call: Call) {
    setOpenId(call.id)
    setCursor(call.id)
    setOverlay(null)
    if (call.unread) void run('call.markRead', { callId: call.id })
    if (search === null && tabOf(call) !== tab) setTabState(tabOf(call))
  }
  function step(by: number) {
    const i = target ? list.indexOf(target) : -1
    const next = list[Math.max(0, Math.min(list.length - 1, i + by))]
    if (next && openCall) open(next)
    else setCursor(next?.id ?? null)
  }
  function openSearch() {
    setOpenId(null)
    setSearch(s => s ?? '')
    setTimeout(() => { const el = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null; el?.focus(); el?.select() }, 0)
  }
  const closeSearch = () => { setSearch(null); setCursor(null) }
  function openRemind(call: Call) {
    if (!actions.isTriageable(call)) return
    remindFor.current = { call, source: toaster.currentSource() }
    setOverlay('remind')
  }
  function pickReminder(option: ReminderOption) {
    setOverlay(null)
    const pending = remindFor.current
    if (pending) toaster.via(pending.source, () => actions.remind(pending.call, option))
  }
  const toggleDone = (call: Call) => (call.inbox_state === 'done' ? actions.markNotDone(call) : actions.markDone(call))

  const keys: KeyContext = {
    overlay, tab, searching: search !== null, target, step, setTab, openSearch, closeSearch, openRemind, open,
    isCallOpen: !!openCall, back: () => setOpenId(null),
    closeOverlay: () => setOverlay(null),
    goChord: key => { const to = chordTabs[key]; if (to) setTab(to); return !!to },
    markDone: actions.markDone, markNotDone: actions.markNotDone, toggleUnread: actions.toggleUnread,
    remove: actions.remove, clearReminder: actions.clearReminder, undo: actions.undo,
  }
  const keysRef = useRef(keys)
  keysRef.current = keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (toaster.via('key', () => handleKey(e, keysRef.current))) e.preventDefault() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toaster.via])

  const { rejection, clearRejection } = useRejection()
  useEffect(() => {
    if (!rejection) return
    toaster.show(`Could not ${rejection.action}: ${rejection.error}`)
    clearRejection()
  }, [rejection, clearRejection, toaster.show])

  async function signOut() {
    await auth.signOut()
    indexedDB.deleteDatabase(localDbName(me.workspace!.id)) // local rows belong to the signed-in member
    onSignedOut()
  }

  return (
    <div className="app">
      <main className="main">
        {openCall ? (
          <CallView key={openCall.id} call={openCall} segments={segments.get(openCall.id) ?? []} index={list.indexOf(openCall)} count={list.length} search={search}
            onBack={() => setOpenId(null)} onStep={step} onDone={actions.markDone} onNotDone={actions.markNotDone}
            onRemind={openRemind} onClearReminder={actions.clearReminder}
            side={<CustomerSide call={openCall} onOpen={open} toast={toaster.show} />} />
        ) : (
          <Inbox list={list} segments={segments} cursor={target?.id ?? null} leaving={actions.leaving} entering={actions.entering}
            tab={tab} setTab={setTab} counts={counts} liveCall={liveCall} onOpen={open}
            search={search} onSearch={openSearch} onSearchChange={q => { setSearch(q); setCursor(null) }} onSearchClose={closeSearch}
            onHover={c => setCursor(c.id)} onToggleDone={toggleDone} onToggleUnread={actions.toggleUnread}
            onRemind={openRemind} onClearReminder={actions.clearReminder}
            menu={<Button size="sm" variant="ghost" onClick={signOut}>Sign out</Button>} />
        )}
      </main>
      {overlay === 'remind' && (
        <Backdrop onClose={() => setOverlay(null)}>
          <CommandMenu numbered placeholder="Remind me …" groups={[{ label: 'Bring this call back', items: reminderOptions() }]} onSelect={pickReminder} />
        </Backdrop>
      )}
      {toaster.toast && <Toast toast={toaster.toast} onUndo={actions.undo} />}
    </div>
  )
}
