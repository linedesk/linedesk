// The signed-in app: composes the inbox, the pages, the navigation, overlays and toasts.
import type { Call } from '@callfront/db/types'
import { useEffect, useRef, useState } from 'react'
import type { Me } from './auth.ts'
import { CallView } from './call/CallView.tsx'
import { CustomerSide } from './call/CustomerSide.tsx'
import { Inbox } from './inbox/Inbox.tsx'
import type { ReminderOption } from './inbox/remind.ts'
import { useCallActions } from './inbox/useCallActions.ts'
import { useInboxView } from './inbox/useInboxView.ts'
import { callerName, type InboxTab } from './inbox-model.ts'
import { commandGroups, type Command } from './shell/commands.ts'
import type { Overlay } from './shell/keys.ts'
import { MenuButton, Nav } from './shell/Nav.tsx'
import { Overlays } from './shell/Overlays.tsx'
import { pages, type PageRoute } from './shell/pages.tsx'
import { Toast } from './shell/Toast.tsx'
import { useKeyboard } from './shell/useKeyboard.ts'
import { useRoute } from './shell/useRoute.ts'
import { useSignOut } from './shell/useSignOut.ts'
import { useToast, type Source } from './shell/useToast.ts'
import { useRejection } from './store.tsx'
import type { SelectVia } from './ui/CommandMenu.tsx'
import { ErrorBoundary } from './ui/ErrorBoundary.tsx'
import { cx } from './ui/kit.tsx'

const chordTabs: Record<string, InboxTab> = { i: 'you', e: 'done', h: 'reminders' }

export function Workspace({ me, onSignedOut }: { me: Me; onSignedOut: () => void | Promise<void> }) {
  const nav = useRoute()
  const toaster = useToast()
  const view = useInboxView(nav)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [navOpen, setNavOpen] = useState(false)
  const remindFor = useRef<{ call: Call; source: Source } | null>(null)
  const signOut = useSignOut({ workspaceId: me.workspace!.id, onSignedOut, toast: toaster.show })
  const { list, tab, search, openCall, target } = view

  const actions = useCallActions({
    list, tab, searching: search !== null, openId: openCall?.id ?? null, setTab: view.setTabState, setCursor: view.setCursor, showCall: view.showById, toaster,
  })
  const open = (call: Call) => { setOverlay(null); view.open(call) }
  const openSearch = () => { setOverlay(null); setNavOpen(false); view.openSearch() }
  const goPage = (to: PageRoute) => { setOverlay(null); nav.go(to) }
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

  const callHandlers = {
    markDone: actions.markDone, markNotDone: actions.markNotDone, toggleUnread: actions.toggleUnread,
    remove: actions.remove, clearReminder: actions.clearReminder, undo: actions.undo, openRemind,
  }
  useKeyboard({
    ...callHandlers, overlay, setOverlay, navOpen, setNavOpen, onInbox: view.onInbox, tab, searching: search !== null, target,
    step: view.step, setTab: view.setTab, openSearch, closeSearch: view.closeSearch, open, isCallOpen: !!openCall, back: view.back,
    goChord: key => {
      if (key === 'a') goPage('assistant')
      else if (chordTabs[key]) view.setTab(chordTabs[key])
      return key === 'a' || !!chordTabs[key]
    },
  }, toaster.via)

  const { rejection, clearRejection } = useRejection()
  useEffect(() => {
    if (!rejection) return
    toaster.show(`Could not ${rejection.action}: ${rejection.error}`)
    clearRejection()
  }, [rejection, clearRejection, toaster.show])

  const commands = commandGroups({
    ...callHandlers, target, targetName: target ? callerName(target, target.contact_id ? view.contacts.get(target.contact_id) : undefined) : '',
    goInbox: view.setTab, goPage, openSearch, signOut: () => void signOut(),
    openHelp: () => setOverlay('help'), openNav: () => setNavOpen(true),
  })
  function runCommand(command: Command, via: SelectVia) {
    setOverlay(null)
    setTimeout(() => toaster.via(via === 'key' ? 'menu-key' : 'mouse', command.run), 0) // after the palette has closed
  }

  const menu = <MenuButton open={navOpen} onOpen={() => setNavOpen(true)} />
  return (
    <div className={cx('app', navOpen && 'nav-open')}>
      <Nav open={navOpen} route={nav.route} tab={tab} unreadCount={view.calls.filter(c => c.unread && !c.deleted_at).length} reminderCount={view.counts.reminders}
        workspaceName={me.workspace!.name} onInbox={view.setTab} onPage={goPage} onHelp={() => setOverlay('help')}
        onSignOut={() => void signOut()} onClose={() => setNavOpen(false)} />
      <button type="button" className="scrim" aria-label="Close menu" tabIndex={-1} onClick={() => setNavOpen(false)} />
      <main className="main">
        {nav.route !== 'calls' ? (
          <>
            <div className="pagebar">{menu}<b>{pages[nav.route].title}</b></div>
            <ErrorBoundary key={nav.route} fallback={<div className="page"><div className="empty"><b>This page could not be shown</b><span>Reload the app, or go back to the inbox with G I.</span></div></div>}>
              {pages[nav.route].render({ toast: toaster.show, canEditSettings: me.permissions.includes('settings:write') })}
            </ErrorBoundary>
          </>
        ) : openCall ? (
          <CallView key={openCall.id} call={openCall} segments={view.segments.get(openCall.id) ?? []} index={list.indexOf(openCall)} count={list.length} search={search} menu={menu}
            onBack={view.back} onStep={view.step} onDone={actions.markDone} onNotDone={actions.markNotDone}
            onRemind={openRemind} onClearReminder={actions.clearReminder}
            side={<CustomerSide call={openCall} onOpen={open} toast={toaster.show} />} />
        ) : (
          <Inbox list={list} segments={view.segments} cursor={target?.id ?? null} leaving={actions.leaving} entering={actions.entering} menu={menu}
            tab={tab} setTab={view.setTab} counts={view.counts} liveCall={view.liveCall} onOpen={open}
            search={search} onSearch={openSearch} onSearchChange={view.changeSearch} onSearchClose={view.closeSearch}
            onHover={c => view.setCursor(c.id)} onToggleDone={toggleDone} onToggleUnread={actions.toggleUnread}
            onRemind={openRemind} onClearReminder={actions.clearReminder}
            onCommands={c => { view.setCursor(c.id); setOverlay('commands') }} />
        )}
      </main>
      <Overlays overlay={overlay} commands={commands} onClose={() => setOverlay(null)} onCommand={runCommand} onReminder={pickReminder} />
      {toaster.toast && <Toast toast={toaster.toast} onUndo={actions.undo} />}
    </div>
  )
}
