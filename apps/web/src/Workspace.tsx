// The signed-in app: composes the inbox, the pages, the navigation, overlays and toasts.
import type { Call } from '@callfront/db/types'
import { useEffect, useRef, useState } from 'react'
import { AdminMode } from './admin/AdminMode.tsx'
import type { Me } from './auth.ts'
import { CallView } from './call/CallView.tsx'
import { ContactSide } from './call/ContactSide.tsx'
import { togglePlayback } from './call/playback.ts'
import { Inbox } from './inbox/Inbox.tsx'
import type { ReminderOption } from './inbox/remind.ts'
import { useSelection } from './inbox/selection.ts'
import { useCallActions } from './inbox/useCallActions.ts'
import { useInboxView } from './inbox/useInboxView.ts'
import { callerName, callTitle, type InboxTab } from './inbox-model.ts'
import { commandGroups, type Command } from './shell/commands.ts'
import type { Overlay } from './shell/keys.ts'
import { MenuButton, Nav } from './shell/Nav.tsx'
import { Overlays } from './shell/Overlays.tsx'
import { SyncBar } from './shell/SyncBar.tsx'
import { pages, type Page, type PageRoute } from './shell/pages.tsx'
import { Toast } from './shell/Toast.tsx'
import { useKeyboard } from './shell/useKeyboard.ts'
import { useRoute } from './shell/useRoute.ts'
import { useSignOut } from './shell/useSignOut.ts'
import { useToast, type Source } from './shell/useToast.ts'
import { useAssistantName, useRejection } from './store.tsx'
import type { SelectVia } from './ui/CommandMenu.tsx'
import { ErrorBoundary } from './ui/ErrorBoundary.tsx'
import { cx } from './ui/kit.tsx'

const chordTabs: Record<string, InboxTab> = { i: 'you', e: 'done', h: 'reminders' }
const chordPages: Record<string, PageRoute> = { a: 'assistant', c: 'contacts', t: 'team' }

export function Workspace({ me, onSignedOut }: { me: Me; onSignedOut: () => void | Promise<void> }) {
  const nav = useRoute()
  const toaster = useToast()
  const view = useInboxView(nav)
  const assistantName = useAssistantName()
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [navOpen, setNavOpen] = useState(false)
  const remindFor = useRef<{ calls: Call[]; source: Source } | null>(null)
  const signOut = useSignOut({ workspaceId: me.workspace!.id, onSignedOut, toast: toaster.show })
  const { list, tab, search, openCall, target } = view
  const isInstanceAdmin = me.permissions.includes('instance:admin')

  const actions = useCallActions({
    list,
    tab,
    searching: search !== null,
    openId: openCall?.id ?? null,
    setTab: view.setTabState,
    setCursor: view.setCursor,
    showCall: view.showById,
    toaster,
  })
  const selection = useSelection(list)
  // A new view or search starts with nothing selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear when the view changes, not when the clear function does
  useEffect(() => selection.clear(), [tab, search])
  const open = (call: Call) => {
    setOverlay(null)
    view.open(call)
  }
  const openSearch = () => {
    setOverlay(null)
    setNavOpen(false)
    view.openSearch()
  }
  const goPage = (to: PageRoute) => {
    setOverlay(null)
    nav.go(to)
  }
  const bulk = selection.count > 0 && !openCall
  /** A row that stands for repeat calls acts on all of them (see groupRepeats). */
  const perRow = (one: (call: Call) => void, many: (calls: Call[]) => void) => (call: Call) => {
    const group = view.groupOf(call)
    return group.length > 1 ? many(group) : one(call)
  }
  /** With calls selected, an action applies to all of them and the selection ends. */
  const each = (one: (call: Call) => void, many: (calls: Call[]) => void) => (call: Call) => {
    if (!bulk) return perRow(one, many)(call)
    many(selection.calls.flatMap(view.groupOf))
    selection.clear()
  }
  function openRemind(call: Call) {
    const calls = bulk ? selection.calls.flatMap(view.groupOf) : view.groupOf(call)
    if (!bulk && !actions.isTriageable(call)) return
    remindFor.current = { calls, source: toaster.currentSource() }
    setOverlay('remind')
  }
  function pickReminder(option: ReminderOption) {
    setOverlay(null)
    const pending = remindFor.current
    if (!pending) return
    toaster.via(pending.source, () =>
      pending.calls.length > 1 || bulk
        ? actions.many.remind(pending.calls, option)
        : actions.remind(pending.calls[0]!, option),
    )
    if (bulk) selection.clear()
  }
  const toggleDone = (call: Call) =>
    call.inbox_state === 'done'
      ? perRow(actions.markNotDone, actions.many.markNotDone)(call)
      : perRow(actions.markDone, actions.many.markDone)(call)

  const callHandlers = {
    markDone: each(actions.markDone, actions.many.markDone),
    markNotDone: each(actions.markNotDone, actions.many.markNotDone),
    toggleUnread: each(actions.toggleUnread, actions.many.toggleUnread),
    remove: each(actions.remove, actions.many.remove),
    clearReminder: each(actions.clearReminder, actions.many.clearReminder),
    undo: actions.undo,
    openRemind,
  }
  function extendSelect(by: number) {
    if (!target) return
    const i = list.indexOf(target)
    const next = list[i + by]
    selection.add(target.id, ...(next ? [next.id] : []))
    view.step(by)
  }
  useKeyboard(
    {
      ...callHandlers,
      overlay,
      setOverlay,
      navOpen,
      setNavOpen,
      onInbox: view.onInbox,
      tab,
      searching: search !== null,
      target,
      step: view.step,
      setTab: view.setTab,
      openSearch,
      closeSearch: view.closeSearch,
      open,
      isCallOpen: !!openCall,
      back: view.back,
      togglePlayback,
      selectionCount: bulk ? selection.count : 0,
      toggleSelect: c => selection.toggle(c.id),
      extendSelect,
      selectAll: selection.all,
      clearSelection: selection.clear,
      goChord: key => {
        if (key === 'd' && isInstanceAdmin) goPage('admin')
        else if (chordPages[key]) goPage(chordPages[key])
        else if (chordTabs[key]) view.setTab(chordTabs[key])
        return !!chordPages[key] || !!chordTabs[key] || (key === 'd' && isInstanceAdmin)
      },
    },
    toaster.via,
  )

  // A hash that leads nowhere shows the inbox, says so once and is cleaned up.
  const lost = !nav.known ? 'That page does not exist.' : view.missingCall ? 'Call not found.' : null
  useEffect(() => {
    if (!lost) return
    toaster.show(lost)
    nav.backToInbox()
  }, [lost, toaster.show, nav.backToInbox])

  // The keyboard cursor wins over a resting mouse: while keys are used, hover does not highlight a second row.
  useEffect(() => {
    const root = document.documentElement
    const keys = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) root.dataset.input = 'keys'
    }
    const mouse = (e: MouseEvent) => {
      if (e.movementX || e.movementY) root.dataset.input = 'mouse'
    }
    window.addEventListener('keydown', keys, true)
    window.addEventListener('mousemove', mouse, true)
    return () => {
      window.removeEventListener('keydown', keys, true)
      window.removeEventListener('mousemove', mouse, true)
    }
  }, [])

  // The browser tab says where you are: the open call's issue, the view or the page.
  const viewTitles: Record<InboxTab, string> = {
    you: 'Needs you',
    ai: `Handled by ${assistantName}`,
    spam: 'Spam',
    reminders: 'Reminders',
    done: 'Done',
  }
  const where =
    nav.route !== 'calls'
      ? pages[nav.route].title
      : openCall
        ? callTitle(openCall)
        : search !== null
          ? 'Search'
          : viewTitles[tab]
  useEffect(() => {
    document.title = `${where} · Linedesk`
  }, [where])

  const { rejection, clearRejection } = useRejection()
  useEffect(() => {
    if (!rejection) return
    toaster.show(`Could not ${rejection.action}: ${rejection.error}`)
    clearRejection()
  }, [rejection, clearRejection, toaster.show])

  const commands = commandGroups({
    ...callHandlers,
    target,
    targetName: bulk
      ? `${selection.count} selected calls`
      : target
        ? callerName(target, target.contact_id ? view.contacts.get(target.contact_id) : undefined)
        : '',
    selection:
      view.onInbox && !openCall
        ? {
            count: bulk ? selection.count : 0,
            toggle: () => target && selection.toggle(target.id),
            all: selection.all,
            clear: selection.clear,
          }
        : null,
    goInbox: view.setTab,
    goPage,
    isInstanceAdmin,
    openSearch,
    signOut: () => void signOut(),
    openHelp: () => setOverlay('help'),
    openNav: () => setNavOpen(true),
  })
  function runCommand(command: Command, via: SelectVia) {
    setOverlay(null)
    setTimeout(() => toaster.via(via === 'key' ? 'menu-key' : 'mouse', command.run), 0) // after the palette has closed
  }

  // Admin mode replaces the whole app; leaving it returns to where the user was.
  const beforeAdmin = useRef('#calls')
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read the hash whenever the place in the app changes
  useEffect(() => {
    if (nav.route !== 'admin') beforeAdmin.current = window.location.hash || '#calls'
  }, [nav.route, nav.callId, nav.tab, nav.search])
  if (nav.route === 'admin' && isInstanceAdmin) {
    return (
      <AdminMode
        currentUserId={me.actorId}
        onExit={() => {
          window.location.hash = beforeAdmin.current
        }}
      />
    )
  }

  const menu = <MenuButton open={navOpen} onOpen={() => setNavOpen(true)} />
  const page: Page | null = nav.route === 'calls' ? null : pages[nav.route]
  return (
    <div className={cx('app', navOpen && 'nav-open')}>
      <Nav
        open={navOpen}
        route={nav.route}
        tab={tab}
        unreadCount={view.unreadNeedsYou}
        reminderCount={view.counts.reminders}
        workspaceName={me.workspace!.name}
        isInstanceAdmin={isInstanceAdmin}
        onInbox={view.setTab}
        onPage={goPage}
        onHelp={() => setOverlay('help')}
        onSignOut={() => void signOut()}
        onClose={() => setNavOpen(false)}
      />
      <button type="button" className="scrim" aria-label="Close menu" tabIndex={-1} onClick={() => setNavOpen(false)} />
      <main className="main">
        {page ? (
          <>
            {!page.ownHeader && (
              <div className="pagebar">
                {menu}
                <b>{page.title}</b>
              </div>
            )}
            <ErrorBoundary
              key={nav.route}
              fallback={
                <div className="page">
                  <div className="empty">
                    <b>This page could not be shown</b>
                    <span>Reload the app, or go back to the inbox with G I.</span>
                  </div>
                </div>
              }
            >
              {page.render({
                toast: toaster.show,
                canEditSettings: me.permissions.includes('settings:write'),
                isInstanceAdmin,
                userId: me.actorId,
                menu,
                openCall: open,
              })}
            </ErrorBoundary>
          </>
        ) : openCall ? (
          <CallView
            key={openCall.id}
            call={openCall}
            segments={view.segments.get(openCall.id) ?? []}
            repeatCount={view.groupOf(openCall).length}
            index={list.indexOf(openCall)}
            count={list.length}
            search={search}
            menu={menu}
            onBack={view.back}
            onStep={view.step}
            onDone={perRow(actions.markDone, actions.many.markDone)}
            onNotDone={perRow(actions.markNotDone, actions.many.markNotDone)}
            onRemind={openRemind}
            onClearReminder={actions.clearReminder}
            onCommands={() => setOverlay('commands')}
            side={<ContactSide call={openCall} onOpen={open} toast={toaster.show} />}
          />
        ) : (
          <Inbox
            list={list}
            segments={view.segments}
            cursor={target?.id ?? null}
            leaving={actions.leaving}
            entering={actions.entering}
            menu={menu}
            selected={selection.ids}
            groups={view.groups}
            onSelect={(c, range) => (range ? selection.range(c.id) : selection.toggle(c.id))}
            bulk={{
              count: selection.count,
              inDone: tab === 'done',
              onDone: () => (tab === 'done' ? callHandlers.markNotDone : callHandlers.markDone)(selection.calls[0]!),
              onRemind: () => openRemind(selection.calls[0]!),
              onToggleRead: () => callHandlers.toggleUnread(selection.calls[0]!),
              onDelete: () => callHandlers.remove(selection.calls[0]!),
              onCommands: () => setOverlay('commands'),
              onSelectAll: selection.all,
              onClear: selection.clear,
            }}
            tab={tab}
            setTab={view.setTab}
            counts={view.counts}
            liveCall={view.liveCall}
            onOpen={open}
            canFixVoice={isInstanceAdmin}
            search={search}
            onSearch={openSearch}
            onSearchChange={view.changeSearch}
            onSearchClose={view.closeSearch}
            onHover={c => view.setCursor(c.id)}
            onToggleDone={toggleDone}
            onToggleUnread={callHandlers.toggleUnread}
            onRemind={openRemind}
            onClearReminder={actions.clearReminder}
            onCommands={c => {
              view.setCursor(c.id)
              setOverlay('commands')
            }}
          />
        )}
        {me.workspace?.disabled && (
          <div className="sync-bar" role="status">
            This workspace is disabled. Calls are not answered and nothing can be changed.
          </div>
        )}
        <SyncBar />
      </main>
      <Overlays
        overlay={overlay}
        commands={commands}
        onClose={() => setOverlay(null)}
        onCommand={runCommand}
        onReminder={pickReminder}
      />
      {toaster.toast && <Toast toast={toaster.toast} onUndo={actions.undo} />}
    </div>
  )
}
