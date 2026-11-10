// What the inbox shows and what is selected: the view, the search, the list, the cursor and the open call.
import type { Call } from '@callfront/db/types'
import { useMemo, useState } from 'react'
import { useSegmentsByCall } from '../call/segments.ts'
import { countsFor, listFor, sortForList, tabOf, type InboxTab } from '../inbox-model.ts'
import { useNow } from '../shell/useNow.ts'
import type { RouteApi } from '../shell/useRoute.ts'
import { useAssistantName, useRows, useRun, useSnapshot } from '../store.tsx'
import { SEARCH_INPUT_ID } from './InboxHead.tsx'
import { matchesSearch } from './search.tsx'
import { useCursor } from './useCursor.ts'

export function useInboxView(nav: RouteApi) {
  const calls = useRows('calls')
  const contacts = useSnapshot().tables.contacts
  const segments = useSegmentsByCall()
  const assistantName = useAssistantName()
  const now = useNow()
  const run = useRun()
  const [tab, setTabState] = useState<InboxTab>('you')
  const [search, setSearch] = useState<string | null>(null)

  const list = useMemo(() => {
    if (search === null) return listFor(calls, tab, now)
    const hits = calls.filter(c => !c.deleted_at && matchesSearch({ call: c, contact: c.contact_id ? contacts.get(c.contact_id) : undefined, segments: segments.get(c.id) ?? [], assistantName }, search))
    return sortForList(hits, false)
  }, [calls, contacts, segments, assistantName, tab, search, now])
  const counts = useMemo(() => countsFor(calls, now), [calls, now])
  const liveCall = useMemo(() => listFor(calls, 'you', now).find(c => c.status === 'live'), [calls, now]) // newest live call
  const [cursorId, setCursor] = useCursor(list)
  const onInbox = nav.route === 'calls'
  const openCall = onInbox && nav.callId ? calls.find(c => c.id === nav.callId && !c.deleted_at) : undefined
  const target = onInbox ? openCall ?? list.find(c => c.id === cursorId) : undefined

  /** Show a call full width and mark it read. */
  function show(call: Call) {
    nav.openCall(call.id)
    setCursor(call.id)
    if (call.unread) void run('call.markRead', { callId: call.id })
  }
  /** Open a call from anywhere: also switches to the view it lives in. */
  function open(call: Call) {
    show(call)
    if (search === null && tabOf(call) !== tab) setTabState(tabOf(call))
  }
  function showById(id: string | null) {
    const call = id ? calls.find(c => c.id === id) : undefined
    if (call) show(call)
    else nav.closeCall()
  }
  function step(by: number) {
    const i = target ? list.indexOf(target) : -1
    const next = list[Math.max(0, Math.min(list.length - 1, i + by))]
    if (next && openCall) show(next)
    else setCursor(next?.id ?? null)
  }
  function setTab(next: InboxTab) {
    if (nav.callId) nav.closeCall()
    else if (!onInbox) nav.go('calls')
    setTabState(next)
    setSearch(null)
    setCursor(null)
  }
  function openSearch() {
    if (nav.callId) nav.closeCall()
    else if (!onInbox) nav.go('calls')
    setSearch(s => s ?? '')
    setTimeout(() => { const el = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null; el?.focus(); el?.select() }, 0)
  }

  return {
    calls, contacts, segments, list, counts, liveCall, tab, search, cursorId, openCall, target, onInbox,
    setTab, setTabState, setCursor, open, showById, step, openSearch, back: nav.closeCall,
    changeSearch: (query: string) => { setSearch(query); setCursor(null) },
    closeSearch: () => { setSearch(null); setCursor(null) },
  }
}
export type InboxView = ReturnType<typeof useInboxView>
