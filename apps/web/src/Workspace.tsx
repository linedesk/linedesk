// The signed-in app: composes the inbox, the pages, the navigation, overlays and toasts.
import { offersTour } from '@linedesk/actions'
import type { Call } from '@linedesk/db/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useReviewCount } from './review/reviewData.ts'
import { AdminMode } from './admin/AdminMode.tsx'
import { PasskeyStepUpHost } from './admin/PasskeyStepUp.tsx'
import { SecondFactorPrompt } from './admin/SecondFactorPrompt.tsx'
import { isInstanceAdmin, type Me, passkeySupported } from './auth.ts'
import { PasskeyCard } from './AddPasskey.tsx'
import { passkeyAsk, pausedAt } from './passkey-ask.ts'
import { CallView } from './call/CallView.tsx'
import { ContactSide } from './call/ContactSide.tsx'
import { toggleContactPanel } from './call/contactPanel.ts'
import { liveCallKey } from './call/LiveCard.tsx'
import { preloadLiveKit } from './call/livekit.ts'
import { togglePlayback } from './call/playback.ts'
import { assignGroups, assigneeViewGroups } from './inbox/assign.ts'
import { Inbox } from './inbox/Inbox.tsx'
import type { ReminderOption } from './inbox/remind.ts'
import { useSelection } from './inbox/selection.ts'
import { useCallActions } from './inbox/useCallActions.ts'
import { useInboxView } from './inbox/useInboxView.ts'
import { assigneeTabs, callerName, callTitle, type InboxTab, visibleSplits } from './inbox-model.ts'
import { chordTarget } from './shell/chords.ts'
import { commandGroups, type Command } from './shell/commands.ts'
import type { Overlay } from './shell/keys.ts'
import { invitationNotice, unannounced, useMyInvitations } from './shell/invitations.ts'
import { AskName } from './shell/AskName.tsx'
import { MenuButton, Nav } from './shell/Nav.tsx'
import { NewWorkspaceDialog } from './shell/NewWorkspace.tsx'
import { mayCreateWorkspace } from './NoWorkspace.tsx'
import { Overlays, type Picker } from './shell/Overlays.tsx'
import { rejectionText } from './shell/rejections.ts'
import { SetupBanner } from './shell/SetupBanner.tsx'
import { Tour } from './shell/Tour.tsx'
import { finishTour, tourStartsNow } from './shell/tour.ts'
import {
  GoLiveChecklist,
  undoGoLiveRefusal,
  useGoLiveChecklist,
  useGoLiveVisible,
  useHadRealCall,
  useShowGoLive,
} from './inbox/GoLiveChecklist.tsx'
import { firstCallHint } from './inbox/goLive.ts'
import { SampleCallsBar } from './inbox/SampleCallsBar.tsx'
import { StarPrompt } from './shell/StarPrompt.tsx'
import { SyncBar } from './shell/SyncBar.tsx'
import { pages, type Page, type PageRoute } from './shell/pages.tsx'
import { Toast } from './shell/Toast.tsx'
import { useKeyboard } from './shell/useKeyboard.ts'
import { useRoute } from './shell/useRoute.ts'
import { useSignOut } from './shell/useSignOut.ts'
import { useCallNotifications } from './shell/useCallNotifications.ts'
import { useToast, type Source } from './shell/useToast.ts'
import { mayChangeWithAgent } from './settings/agentChange.ts'
import { settingsAccess } from './settings/readOnly.ts'
import { unknownPageText } from './supportAccess.ts'
import { preloadWorkspaceSettings } from './settings/settings-api.ts'
import { memberLabel, useAssignableMembers } from './team/members.ts'
import { preloadTeam } from './team/team-api.ts'
import { takeDeleted } from './session.ts'
import { useAssistantName, useRejection, useRun, useWorkspaceState } from './store.tsx'
import type { SelectVia } from './ui/CommandMenu.tsx'
import { ErrorBoundary } from './ui/ErrorBoundary.tsx'
import { useBrand } from './brand.ts'
import { setProviderAudience } from './providerAudience.ts'
import { cx } from './ui/kit.tsx'
import { useMediaQuery } from './ui/useMediaQuery.ts'
import { useT } from '@linedesk/i18n/react'

/** Whether the passkey card is due for this member: no passkey, not paused with "Not now" (passkey-ask.ts). */
function usePasskeyCard(me: Me): boolean {
  const { actorId, hasPasskey, impersonation, emailUnconfirmed } = me
  return useMemo(
    () =>
      passkeyAsk({
        hasPasskey,
        supported: passkeySupported(),
        impersonating: Boolean(impersonation),
        emailUnconfirmed: Boolean(emailUnconfirmed),
        needsEnrolmentCode: false,
        justSignedIn: false,
        pausedAt: pausedAt(actorId),
        now: Date.now(),
      }) !== null,
    [actorId, hasPasskey, impersonation, emailUnconfirmed],
  )
}

/** From this width the menu is docked: always shown, the content beside it. */
const NAV_DOCKED_QUERY = '(min-width: 1600px)'

/** The not-found toasts (call, page) stay long enough to be read after the jump. */
const NOT_FOUND_TOAST_MS = 4500

type Props = {
  me: Me
  onSignedOut: () => void | Promise<void>
  /** `me` is out of date (the workspace was disabled or enabled meanwhile): load it again, in place. */
  onSessionStale: () => void | Promise<void>
  /** Said once when the app opens: why a link did not open here (App, linkNotice). */
  notice?: string | null
  /** The workspace was renamed here (Workspace settings › General): the session and the menu take the new name. */
  onRenamed: (name: string) => void
}

export function Workspace({ me, onSignedOut, onSessionStale, notice = null, onRenamed }: Props) {
  const t = useT()
  const nav = useRoute()
  // Disabled or enabled by an instance admin while this tab is open: the banner follows the server's
  // latest answer, and the member's permissions are loaded again.
  const liveState = useWorkspaceState()
  const workspaceDisabled = liveState ? liveState === 'disabled' : Boolean(me.workspace?.disabled)
  useEffect(() => {
    if (liveState && (liveState === 'disabled') !== Boolean(me.workspace?.disabled)) void onSessionStale()
  }, [liveState, me.workspace?.disabled, onSessionStale])
  // The call code (LiveKit) loads after the first screen, before anyone opens a live call.
  useEffect(preloadLiveKit, [])
  const toaster = useToast()
  // Invitations to other workspaces: a dot on the menu, a toast once per invitation, Join in the workspace menu.
  const invites = useMyInvitations(!!me.impersonation)
  useEffect(() => {
    const fresh = unannounced(invites.invitations)
    if (fresh.length) toaster.show(invitationNotice(fresh), false, 8000)
  }, [invites.invitations, toaster.show])
  // Owners and admins: How <assistant> did (Assistant area, G R); its open items are the count on Assistant.
  const canReview = me.permissions.includes('settings:write')
  const reviewCount = useReviewCount(canReview)
  const view = useInboxView(nav, me.actorId, !!me.impersonation)
  // A notification when a call ends while this tab is in the background (Account settings, Notifications).
  useCallNotifications(call => callerName(call, call.contact_id ? view.contacts.get(call.contact_id) : undefined))
  const assistantName = useAssistantName()
  // During support access the settings are read-only, API keys aside (settingsAccess, settings/readOnly.ts).
  const { canEdit: canEditSettings, canManageKeys } = settingsAccess(me)
  // Until the first real call, the inbox says what happens when one comes in (goLive.ts).
  const hadRealCall = useHadRealCall(useGoLiveChecklist(canEditSettings, me.workspace!.id))
  const showGoLive = useShowGoLive(canEditSettings, me.workspace!.id)
  // The checklist's first step is connecting the number: while it is on screen, the banner saying so stays away.
  const goLiveVisible = useGoLiveVisible()
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [navOpen, setNavOpen] = useState(false)
  // On very wide windows the menu stays open beside the content instead of sliding over it.
  const navDocked = useMediaQuery(NAV_DOCKED_QUERY)
  const remindFor = useRef<{ calls: Call[]; source: Source } | null>(null)
  const [picker, setPicker] = useState<Picker | null>(null)
  // Assigning exists once the workspace has a second member (members.ts useCanAssign).
  const members = useAssignableMembers()
  const canAssign = members.length > 1
  const signOut = useSignOut({ onSignedOut, toast: toaster.show })
  const { list, tab, search, openCall, target } = view
  // An instance admin who must sign in again counts (auth.ts): the admin area asks them to sign in first.
  const instanceAdmin = isInstanceAdmin(me)
  // Error texts built without `me` (refusals, toasts) send admins to Server admin › Providers, others to whoever runs it.
  setProviderAudience(instanceAdmin ? 'admin' : 'member')
  // First-use tour (FIRST_USE): queued when onboarding ends in this browser, started once the inbox shows a
  // call (the go-live checklist comes first; never in an empty inbox), and from ⌘K any time.
  const tourOffered = offersTour(me.firstUse ?? 'off')
  const [tourOpen, setTourOpen] = useState(false)
  const closeTour = () => {
    finishTour()
    setTourOpen(false)
  }
  const inboxCalls = nav.route === 'calls' && !openCall ? list.length : 0
  useEffect(() => {
    if (!tourOffered || tourOpen || !tourStartsNow(me.workspace!.id, inboxCalls)) return
    finishTour() // once: a reload during the tour does not start it again
    setTourOpen(true)
  }, [tourOffered, tourOpen, inboxCalls, me.workspace])
  // An instance admin who must sign in again still finds the admin area; it asks them to sign in.
  const canOpenAdmin = instanceAdmin
  // The same rule as the screen without a workspace: only server admins create workspaces.
  const canCreateWorkspace = mayCreateWorkspace(me)
  const [newWorkspace, setNewWorkspace] = useState(false)
  // Members without a passkey: a quiet card asks for one (passkey-ask.ts), not at the same time as the star prompt.
  const [passkeyCardClosed, setPasskeyCardClosed] = useState(false)
  const askForPasskey = usePasskeyCard(me) && !passkeyCardClosed
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
  const goPage = (to: PageRoute, section?: string) => {
    setOverlay(null)
    nav.go(to, section)
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
  /** The member picker (A, a row's or the call's assign button): for the selection, else the call (and its repeats). */
  function openAssign(call: Call, anchor?: DOMRect) {
    if (!canAssign) return
    const wasBulk = bulk
    const calls = wasBulk ? selection.calls.flatMap(view.groupOf) : view.groupOf(call)
    const source = toaster.currentSource()
    const pick = (userId: string | null, name: string) => {
      toaster.via(source, () =>
        calls.length > 1 ? actions.many.assign(calls, userId, name) : actions.assign(calls[0]!, userId, name),
      )
      if (wasBulk) selection.clear()
    }
    const groups = assignGroups(members, me.actorId, calls).map(g => ({
      label: g.label,
      items: g.items.map(item => ({
        ...item,
        run: () => pick(item.userId, item.label),
      })),
    }))
    setPicker({ label: t('inbox.assign.label'), placeholder: t('inbox.assign.placeholder'), groups, anchor })
    setOverlay('pick')
  }
  /** Switch between the assignee views (the title of one, as a menu). */
  function openAssigneeViews(anchor: DOMRect) {
    const groups = assigneeViewGroups(members, me.actorId).map(g => ({
      label: g.label,
      items: g.items.map(item => ({
        ...item,
        run: () => view.setTab(item.tab, item.member),
      })),
    }))
    setPicker({
      label: t('inbox.assigneeViews.label'),
      placeholder: t('inbox.assigneeViews.placeholder'),
      groups,
      anchor,
    })
    setOverlay('pick')
  }
  // The last teammate left: the assignee views are gone, back to Needs you.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when assigning comes or goes, or the view changes
  useEffect(() => {
    if (!canAssign && members.length > 0 && assigneeTabs.includes(view.tab)) view.setTabState('you')
  }, [canAssign, view.tab])
  const memberName = view.member ? memberLabel(members.find(m => m.user_id === view.member)) : undefined
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
    openAssign: (call: Call) => openAssign(call),
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
      canAssign,
      tab,
      views: visibleSplits(view.counts, tab),
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
      liveCallKey,
      selectionCount: bulk ? selection.count : 0,
      toggleSelect: c => selection.toggle(c.id),
      extendSelect,
      selectAll: selection.all,
      clearSelection: selection.clear,
      goChord: key => {
        const to = chordTarget(key, { instanceAdmin, review: canReview, assign: canAssign })
        if (!to) return false
        if (to.kind === 'page') goPage(to.route, to.section)
        else view.setTab(to.tab)
        return true
      },
    },
    toaster.via,
  )

  // A hash that leads nowhere shows the inbox, says so once and is cleaned up.
  // During support access the agent setup links say why they did not open (supportAccess.ts).
  const lost = !nav.known
    ? unknownPageText(window.location.hash, !!me.impersonation)
    : view.missingCall
      ? t('shell.lost.call')
      : null
  useEffect(() => {
    if (!lost) return
    toaster.show(lost, false, NOT_FOUND_TOAST_MS)
    nav.backToInbox()
  }, [lost, toaster.show, nav.backToInbox])

  useEffect(() => {
    if (notice) toaster.show(notice, false, NOT_FOUND_TOAST_MS)
  }, [notice, toaster.show])

  // Deleted a workspace from Workspace settings and landed in this one: say so once. One whose account went with
  // it (the sign-in page said so) is only forgotten here.
  useEffect(() => {
    const deleted = takeDeleted()
    if (deleted && !deleted.accountDeleted)
      toaster.show(t('shell.workspaceDeleted', { name: deleted.name }), false, NOT_FOUND_TOAST_MS)
  }, [toaster.show, t])

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
    you: t('inbox.view.you'),
    ai: t('inbox.view.ai', { assistant: assistantName }),
    spam: t('inbox.view.spam'),
    reminders: t('inbox.view.reminders'),
    done: t('inbox.view.done'),
    mine: t('inbox.view.mine'),
    member: memberName ? t('inbox.view.member', { name: memberName }) : t('inbox.view.assigned'),
    unassigned: t('inbox.view.unassigned'),
  }
  const where =
    nav.route !== 'calls'
      ? pages[nav.route].title
      : openCall
        ? callTitle(openCall)
        : search !== null
          ? t('shell.where.search')
          : viewTitles[tab]
  const brand = useBrand()
  useEffect(() => {
    document.title = `${where} · ${brand.name}`
  }, [where, brand.name])

  const { rejection, clearRejection } = useRejection()
  useEffect(() => {
    // A refusal a screen claimed is shown there (useClaimedRejection), not again as a toast.
    if (!rejection || rejection.claimed) return
    toaster.show(rejectionText(rejection.action, rejection.error))
    undoGoLiveRefusal(me.workspace!.id, rejection.action)
    clearRejection()
  }, [rejection, clearRejection, toaster.show, me.workspace])

  const runAction = useRun()
  const commands = commandGroups({
    ...callHandlers,
    setUrgent: (call, urgent) =>
      void runAction('call.setUrgency', {
        callId: call.id,
        urgency: urgent ? 'urgent' : 'normal',
      }),
    me: me.actorId,
    assign: canAssign
      ? {
          members,
          open: call => openAssign(call),
          to: (call, userId, name) =>
            each(
              c => actions.assign(c, userId, name),
              list => actions.many.assign(list, userId, name),
            )(call),
          showMember: userId => view.setTab('member', userId),
        }
      : null,
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
    assistantName,
    goPage,
    isInstanceAdmin: instanceAdmin,
    isOwner: me.role === 'owner',
    openSearch,
    signOut: () => void signOut(),
    openHelp: () => setOverlay('help'),
    showTour: tourOffered ? () => setTourOpen(true) : undefined,
    newWorkspace: canCreateWorkspace ? () => setNewWorkspace(true) : undefined,
    openNav: () => setNavOpen(true),
    showGoLive: showGoLive
      ? () => {
          if (nav.route !== 'calls' || openCall) view.setTab('you')
          showGoLive()
        }
      : undefined,
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
    return (
      <SecondFactorPrompt
        state={me.adminSecondFactor}
        onExit={() => {
          window.location.hash = beforeAdmin.current
        }}
      />
    )
  }
  if (nav.route === 'admin' && instanceAdmin) {
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
        mineCount={canAssign ? view.counts.mine : null}
        unassignedCount={canAssign ? view.counts.unassigned : null}
        reviewCount={reviewCount}
        workspaceName={me.workspace!.name}
        workspaceId={me.workspace!.id}
        avatarUrl={me.avatarUrl}
        toast={toaster.show}
        invitations={invites.invitations}
        onInvitationsChanged={invites.reload}
        isInstanceAdmin={instanceAdmin}
        onNewWorkspace={canCreateWorkspace ? () => setNewWorkspace(true) : undefined}
        onInbox={view.setTab}
        onPage={goPage}
        onHelp={() => setOverlay('help')}
        onSignOut={() => void signOut()}
        onClose={() => setNavOpen(false)}
      />
      <button type="button" className="scrim" aria-label={t('shell.nav.closeMenu')} tabIndex={-1} onClick={() => setNavOpen(false)} />
      <main className="main">
        {nav.route !== 'workspace' && !goLiveVisible && <SetupBanner canEdit={canManageKeys} />}
        {!page && !openCall && <SampleCallsBar canEdit={canEditSettings} canAssign={canAssign} toast={toaster.show} />}
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
                    <b>{t('shell.pageFailed.title')}</b>
                    <span>{t('shell.pageFailed.text', { keys: 'G I' })}</span>
                  </div>
                </div>
              }
            >
              {page.render({
                toast: toaster.show,
                canEditSettings,
                canManageKeys,
                agentChange: mayChangeWithAgent(me),
                isInstanceAdmin: instanceAdmin,
                userId: me.actorId,
                menu,
                openCall: open,
                phoneSetup: me.phoneSetup,
                workspaceName: me.workspace!.name,
                onRenamed,
                runUndoable: actions.runUndoable,
                undoable: actions.undoable,
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
            onClearReminder={callHandlers.clearReminder}
            onCommands={() => setOverlay('commands')}
            onToggleSpam={callHandlers.toggleSpam}
            onAssign={canAssign ? openAssign : undefined}
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
            aside={
              <GoLiveChecklist
                canEdit={canEditSettings}
                workspaceId={me.workspace!.id}
                toaster={toaster}
                undoable={actions.undoable}
                quiet={tourOpen}
                canFixVoice={instanceAdmin}
              />
            }
            firstCallHint={hadRealCall ? null : firstCallHint(assistantName)}
            onSelect={(c, range) => (range ? selection.range(c.id) : selection.toggle(c.id))}
            bulk={{
              count: selection.count,
              inDone: tab === 'done',
              onDone: () => (tab === 'done' ? callHandlers.markNotDone : callHandlers.markDone)(selection.calls[0]!),
              onRemind: () => openRemind(selection.calls[0]!),
              onToggleRead: () => callHandlers.toggleUnread(selection.calls[0]!),
              onAssign: canAssign ? anchor => openAssign(selection.calls[0]!, anchor) : undefined,
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
            canFixVoice={instanceAdmin}
            search={search}
            onSearch={openSearch}
            onSearchChange={view.changeSearch}
            onSearchClose={view.closeSearch}
            onHover={c => view.setCursor(c.id)}
            onToggleDone={toggleDone}
            onToggleUnread={callHandlers.toggleUnread}
            onRemind={openRemind}
            onClearReminder={callHandlers.clearReminder}
            onAssign={canAssign ? openAssign : undefined}
            memberName={memberName}
            onAssigneeViews={canAssign ? openAssigneeViews : undefined}
            onCommands={c => {
              view.setCursor(c.id)
              setOverlay('commands')
            }}
          />
        )}
        {workspaceDisabled && (
          <div className="sync-bar" role="status">
            {t('shell.disabledWorkspace.bar')}
          </div>
        )}
        <SyncBar />
        <AskName impersonating={!!me.impersonation} />
      </main>
      <Overlays
        overlay={overlay}
        commands={commands}
        picker={picker}
        onClose={() => setOverlay(null)}
        onCommand={runCommand}
        onReminder={pickReminder}
      />
      {tourOpen && !page && <Tour onClose={closeTour} canAssign={canAssign} />}
      {askForPasskey && !(tourOpen || !!page || !!openCall || overlay !== null || newWorkspace) && (
        <PasskeyCard account={me.actorId} needsEnrolmentCode={Boolean(me.passkeyEnrolment)} onAdded={() => {
            toaster.show(t('account.passkey.added'))
            setPasskeyCardClosed(true)
            return onSessionStale()
          }}
          onClose={() => setPasskeyCardClosed(true)} />
      )}
      <StarPrompt
        prompt={me.starPrompt ?? null}
        quiet={askForPasskey || tourOpen || !!page || !!openCall || overlay !== null || newWorkspace}
      />
      {newWorkspace && <NewWorkspaceDialog onClose={() => setNewWorkspace(false)} />}
      {toaster.toast && <Toast toast={toaster.toast} onUndo={actions.undo} />}
      {/* Last, so the passkey a delete asks for (Workspace settings › Danger zone) opens over its dialog. */}
      <PasskeyStepUpHost />
    </div>
  )
}
