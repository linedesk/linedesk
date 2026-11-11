// The signed-in app: composes the inbox, the pages, the navigation, overlays and toasts.
import type { Call } from '@linedesk/db/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from './cachedQuery.ts'
import { loadReview, REVIEW_KEY } from './call/EvaluationCard.tsx'
import { AdminMode } from './admin/AdminMode.tsx'
import { SecondFactorPrompt } from './admin/SecondFactorPrompt.tsx'
import type { Me } from './auth.ts'
import { CallView } from './call/CallView.tsx'
import { ContactSide } from './call/ContactSide.tsx'
import { toggleContactPanel } from './call/contactPanel.ts'
import { togglePlayback } from './call/playback.ts'
import { Inbox } from './inbox/Inbox.tsx'
import type { ReminderOption } from './inbox/remind.ts'
import { useSelection } from './inbox/selection.ts'
import { useCallActions } from './inbox/useCallActions.ts'
import { useInboxView } from './inbox/useInboxView.ts'
import { callerName, callTitle, type InboxTab } from './inbox-model.ts'
import { commandGroups, type Command } from './shell/commands.ts'
import type { Overlay } from './shell/keys.ts'
import { invitationNotice, unannounced, useMyInvitations } from './shell/invitations.ts'
import { MenuButton, Nav } from './shell/Nav.tsx'
import { Overlays } from './shell/Overlays.tsx'
import { rejectionText } from './shell/rejections.ts'
import { SetupBanner } from './shell/SetupBanner.tsx'
import { SyncBar } from './shell/SyncBar.tsx'
import { pages, type Page, type PageRoute } from './shell/pages.tsx'
import { Toast } from './shell/Toast.tsx'
import { useKeyboard } from './shell/useKeyboard.ts'
import { useRoute } from './shell/useRoute.ts'
import { useSignOut } from './shell/useSignOut.ts'
import { useCallNotifications } from './shell/useCallNotifications.ts'
import { useToast, type Source } from './shell/useToast.ts'
import { preloadWorkspaceSettings } from './settings/settings-api.ts'
import { preloadTeam } from './team/team-api.ts'
import { useAssistantName, useRejection } from './store.tsx'
import type { SelectVia } from './ui/CommandMenu.tsx'
import { ErrorBoundary } from './ui/ErrorBoundary.tsx'
import { cx } from './ui/kit.tsx'
import { useMediaQuery } from './ui/useMediaQuery.ts'

/** From this width the menu is docked: always shown, the content beside it. */
const NAV_DOCKED_QUERY = '(min-width: 1600px)'

/** The not-found toasts (call, page) stay long enough to be read after the jump. */
const NOT_FOUND_TOAST_MS = 4500
const chordTabs: Record<string, InboxTab> = { i: 'you', e: 'done', h: 'reminders', m: 'mine', r: 'review' }
const chordPages: Record<string, PageRoute> = { a: 'assistant', c: 'contacts', t: 'team', s: 'settings' }

export function Workspace({ me, onSignedOut }: { me: Me; onSignedOut: () => void | Promise<void> }) {
  const nav = useRoute()
  const toaster = useToast()
  // Invitations to other workspaces: a dot on the menu, a toast once per invitation, Join in the profile menu.
  const invites = useMyInvitations()
  useEffect(() => {
    const fresh = unannounced(invites.invitations)
    if (fresh.length) toaster.show(invitationNotice(fresh), false, 8000)
  }, [invites.invitations, toaster.show])
  // Owners and admins: the calls whose evaluation needs a person (Needs review, G R).
  const canReview = me.permissions.includes('settings:write')
  const reviewQuery = useQuery(canReview ? REVIEW_KEY : null, loadReview)
  const review = useMemo(() => new Set((reviewQuery.data ?? []).map(e => e.callId)), [reviewQuery.data])
  const view = useInboxView(nav, me.actorId, review)
  // A notification when a call ends while this tab is in the background (Settings, Notifications).
  useCallNotifications(call => callerName(call, call.contact_id ? view.contacts.get(call.contact_id) : undefined))
  const assistantName = useAssistantName()
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [navOpen, setNavOpen] = useState(false)
  // On very wide windows the menu stays open beside the content instead of sliding over it.
  const navDocked = useMediaQuery(NAV_DOCKED_QUERY)
  const remindFor = useRef<{ calls: Call[]; source: Source } | null>(null)
  const signOut = useSignOut({ onSignedOut, toast: toaster.show })
  const { list, tab, search, openCall, target } = view
  const isInstanceAdmin = me.permissions.includes('instance:admin')
  // An instance admin without the passkey sign-in still finds the admin area; it asks for the passkey.
  const canOpenAdmin = isInstanceAdmin || Boolean(me.adminSecondFactor)
  // What is not in the local store loads at start, so Settings, Assistant and Team open with it.
  useEffect(() => {
    void preloadWorkspaceSettings()
    void preloadTeam()
  }, [])

  const actions = useCallActions({
    list,
    tab,
    searching: search !== null,
    openId: openCall?.id ?? null,
    setTab: view.setTabState,
    setCursor: view.setCursor,
    showCall: view.showById,
    toaster,
    me: me.actorId,
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
    toggleSpam: each(actions.toggleSpam, actions.many.toggleSpam),
    toggleBlock: actions.toggleBlock,
    toggleAssign: each(actions.toggleAssign, actions.many.toggleAssign),
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
      navOpen: navOpen && !navDocked,
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
      toggleContactPanel,
      selectionCount: bulk ? selection.count : 0,
      toggleSelect: c => selection.toggle(c.id),
      extendSelect,
      selectAll: selection.all,
      clearSelection: selection.clear,
      goChord: key => {
        if (key === 'd' && canOpenAdmin) goPage('admin')
        else if (chordPages[key]) goPage(chordPages[key])
        else if (chordTabs[key]) view.setTab(chordTabs[key])
        return !!chordPages[key] || !!chordTabs[key] || (key === 'd' && canOpenAdmin)
      },
    },
    toaster.via,
  )

  // A hash that leads nowhere shows the inbox, says so once and is cleaned up.
  const lost = !nav.known ? 'That page does not exist.' : view.missingCall ? 'Call not found.' : null
  useEffect(() => {
    if (!lost) return
    toaster.show(lost, false, NOT_FOUND_TOAST_MS)
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
    mine: 'Assigned to me',
    review: 'Needs review',
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
    toaster.show(rejectionText(rejection.action, rejection.error))
    clearRejection()
  }, [rejection, clearRejection, toaster.show])

  const commands = commandGroups({
    ...callHandlers,
    me: me.actorId,
    isBlocked: call => !!(call.contact_id && view.contacts.get(call.contact_id)?.blocked_at),
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
    canReview,
    goPage,
    isInstanceAdmin: canOpenAdmin,
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
  if (nav.route === 'admin' && me.adminSecondFactor) {
    return <SecondFactorPrompt state={me.adminSecondFactor} onExit={() => { window.location.hash = beforeAdmin.current }} />
  }
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

  const menu = <MenuButton open={navOpen} onOpen={() => setNavOpen(true)} badge={invites.invitations.length > 0} />
  const page: Page | null = nav.route === 'calls' ? null : pages[nav.route]
  return (
    <div className={cx('app', navDocked ? 'nav-docked' : navOpen && 'nav-open')}>
      <Nav
        open={navOpen || navDocked}
        docked={navDocked}
        route={nav.route}
        tab={tab}
        unreadCount={view.unreadNeedsYou}
        reminderCount={view.counts.reminders}
        mineCount={view.counts.mine}
        reviewCount={canReview ? view.counts.review : null}
        workspaceName={me.workspace!.name}
        workspaceId={me.workspace!.id}
        toast={toaster.show}
        invitations={invites.invitations}
        onInvitationsChanged={invites.reload}
        isInstanceAdmin={canOpenAdmin}
        onInbox={view.setTab}
        onPage={goPage}
        onHelp={() => setOverlay('help')}
        onSignOut={() => void signOut()}
        onClose={() => setNavOpen(false)}
      />
      <button type="button" className="scrim" aria-label="Close menu" tabIndex={-1} onClick={() => setNavOpen(false)} />
      <main className="main">
        {nav.route !== 'settings' && (
          <SetupBanner canEdit={me.permissions.includes('settings:write')} onConnect={() => goPage('settings')} />
        )}
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
                phoneSetup: me.phoneSetup,
                runUndoable: actions.runUndoable,
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
            onToggleSpam={callHandlers.toggleSpam}
            canReview={canReview}
            side={
              <ContactSide
                call={openCall}
                onOpen={open}
                toast={toaster.show}
                onToggleBlock={callHandlers.toggleBlock}
              />
            }
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
