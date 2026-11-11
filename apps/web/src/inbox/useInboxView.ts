// What the inbox shows and what is selected: the view, the search, the list, the cursor and the open call.
import type { Call } from '@linedesk/db/types'
import { useEffect, useMemo } from 'react'
import { useSegmentsByCall } from '../call/segments.ts'
import { type CallGroups, countsFor, groupRepeats, listFor, sortForList, type InboxTab, viewForOpened } from '../inbox-model.ts'
import { useNow } from '../shell/useNow.ts'
import type { RouteApi } from '../shell/useRoute.ts'
import { useAssistantName, useRows, useRun, useSnapshot } from '../store.tsx'
import { SEARCH_INPUT_ID } from './InboxHead.tsx'
import { matchesSearch } from './search.tsx'
import { useCursor } from './useCursor.ts'

const NO_REVIEW: ReadonlySet<string> = new Set()

/** `me`: the signed-in member's user id (Assigned to me). `review`: calls whose evaluation needs a person (Needs review). */
export function useInboxView(nav: RouteApi, me: string | null = null, review: ReadonlySet<string> = NO_REVIEW) {
  const calls = useRows('calls')
  const contacts = useSnapshot().tables.contacts
  const segments = useSegmentsByCall()
  const assistantName = useAssistantName()
  const now = useNow()
  const run = useRun()
  const { tab, search } = nav // the view and the search live in the URL, so a reload keeps them
  const setTabState = (next: InboxTab) => nav.setView({ tab: next, search })

  const { list, groups } = useMemo((): { list: Call[]; groups: CallGroups } => {
    if (search !== null) {
      const hits = calls.filter(
        c =>
          !c.deleted_at &&
          matchesSearch(
            {
              call: c,
              contact: c.contact_id ? contacts.get(c.contact_id) : undefined,
              segments: segments.get(c.id) ?? [],
              assistantName,
            },
            search,
          ),
      )
      return { list: sortForList(hits, false), groups: new Map() }
    }
    const inTab = listFor(calls, tab, now, me, review)
    return tab === 'you' ? groupRepeats(inTab) : { list: inTab, groups: new Map() }
  }, [calls, contacts, segments, assistantName, tab, search, now, me, review])
  /** Every call a row stands for: a folded row's repeat calls, else the call alone. */
  const groupOf = (call: Call): Call[] => groups.get(call.id) ?? [call]
  const counts = useMemo(() => countsFor(calls, now, me, review), [calls, now, me, review])
  /** The menu's Inbox badge: the unread dots a person sees in Needs you. */
  const unreadNeedsYou = useMemo(() => {
    const needsYou = groupRepeats(listFor(calls, 'you', now))
    return needsYou.list.filter(c => (needsYou.groups.get(c.id) ?? [c]).some(m => m.unread)).length
  }, [calls, now])
  const liveCall = useMemo(() => listFor(calls, 'you', now).find(c => c.status === 'live'), [calls, now]) // newest live call
  const [cursorId, setCursor] = useCursor(list)
  const onInbox = nav.route === 'calls'
  const openCall = onInbox && nav.callId ? calls.find(c => c.id === nav.callId && !c.deleted_at) : undefined
  const target = onInbox ? (openCall ?? list.find(c => c.id === cursorId)) : undefined

  // A reloaded search keeps its query in the URL; put the caret back into the field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on the first render
  useEffect(() => {
    if (search !== null && onInbox && !nav.callId) document.getElementById(SEARCH_INPUT_ID)?.focus()
  }, [])

  /** The hash names a call that is not there (deleted, another workspace, a typo). Rows are known once any call is loaded. */
  const missingCall = onInbox && !!nav.callId && calls.length > 0 && !openCall

  /** Show a call full width and mark it read, with the repeat calls its row stands for. */
  function show(call: Call) {
    nav.openCall(call.id)
    setCursor(call.id)
    for (const c of groupOf(call)) if (c.unread) void run('call.markRead', { callId: c.id })
  }
  /** Open a call from anywhere: also switches to the view it lives in (viewForOpened). */
  function open(call: Call) {
    show(call)
    const next = viewForOpened(call, tab, list)
    if (search === null && next !== tab) setTabState(next)
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
    nav.setView({ tab: next, search: null })
    setCursor(null)
  }
  function openSearch() {
    if (nav.callId) nav.closeCall()
    else if (!onInbox) nav.go('calls')
    nav.setView({ tab, search: search ?? '' })
    setTimeout(() => {
      const el = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null
      el?.focus()
      el?.select()
    }, 0)
  }

  return {
    calls,
    contacts,
    segments,
    list,
    groups,
    groupOf,
    counts,
    unreadNeedsYou,
    liveCall,
    tab,
    search,
    cursorId,
    openCall,
    target,
    onInbox,
    missingCall,
    setTab,
    setTabState,
    setCursor,
    open,
    showById,
    step,
    openSearch,
    back: nav.closeCall,
    changeSearch: (query: string) => {
      nav.setView({ tab, search: query })
      setCursor(null)
    },
    closeSearch: () => {
      nav.setView({ tab, search: null })
      setCursor(null)
    },
  }
}
export type InboxView = ReturnType<typeof useInboxView>
