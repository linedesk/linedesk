// The signed-in app: holds what is selected and wires the inbox, overlays, toasts and keyboard.
import type { Call } from '@callfront/db/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { auth, type Me } from './auth.ts'
import { useSegmentsByCall } from './call/segments.ts'
import { Inbox } from './inbox/Inbox.tsx'
import { SEARCH_INPUT_ID } from './inbox/InboxHead.tsx'
import { reminderOptions, type ReminderOption } from './inbox/remind.ts'
import { matchesSearch } from './inbox/search.tsx'
import { useCallActions } from './inbox/useCallActions.ts'
import { useCursor } from './inbox/useCursor.ts'
import { countsFor, listFor, sortForList, type InboxTab } from './inbox-model.ts'
import { handleKey, type KeyContext, type Overlay } from './shell/keys.ts'
import { Toast } from './shell/Toast.tsx'
import { useNow } from './shell/useNow.ts'
import { useToast, type Source } from './shell/useToast.ts'
import { localDbName, useAssistantName, useRejection, useRows, useSnapshot } from './store.tsx'
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
  const [overlay, setOverlay] = useState<Overlay>(null)
  const remindFor = useRef<{ call: Call; source: Source } | null>(null)

  const list = useMemo(() => {
    if (search === null) return listFor(calls, tab, now)
    const hits = calls.filter(c => !c.deleted_at && matchesSearch({ call: c, contact: c.contact_id ? contacts.get(c.contact_id) : undefined, segments: segments.get(c.id) ?? [], assistantName }, search))
    return sortForList(hits, false)
  }, [calls, contacts, segments, assistantName, tab, search, now])
  const counts = useMemo(() => countsFor(calls, now), [calls, now])
  const [cursorId, setCursor] = useCursor(list)
  const target = list.find(c => c.id === cursorId)
  const liveCall = calls.find(c => c.status === 'live' && !c.deleted_at)

  const setTab = (next: InboxTab) => { setTabState(next); setSearch(null); setCursor(null) }
  const actions = useCallActions({ list, tab, searching: search !== null, openId: null, setTab: setTabState, setCursor, setOpenId: () => {}, toaster })

  function step(by: number) {
    const i = target ? list.indexOf(target) : -1
    setCursor(list[Math.max(0, Math.min(list.length - 1, i + by))]?.id ?? null)
  }
  function openSearch() {
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
    overlay, tab, searching: search !== null, target, step, setTab, openSearch, closeSearch, openRemind,
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
        <Inbox list={list} segments={segments} cursor={target?.id ?? null} leaving={actions.leaving} entering={actions.entering}
          tab={tab} setTab={setTab} counts={counts} liveCall={liveCall}
          search={search} onSearch={openSearch} onSearchChange={q => { setSearch(q); setCursor(null) }} onSearchClose={closeSearch}
          onHover={c => setCursor(c.id)} onToggleDone={toggleDone} onToggleUnread={actions.toggleUnread}
          onRemind={openRemind} onClearReminder={actions.clearReminder}
          menu={<Button size="sm" variant="ghost" onClick={signOut}>Sign out</Button>} />
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
