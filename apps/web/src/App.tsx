import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { forgetBeyond } from './localData.ts'
import { NoWorkspace } from './NoWorkspace.tsx'
import { Login } from './Login.tsx'
import { backoffMs } from './retry.ts'
import {
  expectSessionChange,
  loadSession,
  rememberedSession,
  renameInSession,
  sameSession,
  type Session,
} from './session.ts'
import { onUnauthorized } from './signedOutWatch.ts'
import { AgentSetup, choseManualSetup, isAgentSetupHash, rememberManual } from './onboarding/AgentSetup.tsx'
import { ownerAgentSetupDue, ownerChoseByHand, rememberOwnerByHand } from './onboarding/setup-choice.ts'
import { mayChangeWithAgent, mayStepThrough, useChangeWithAgent, useStepByStep } from './settings/agentChange.ts'
import { ChangeWithAgent } from './settings/ChangeWithAgent.tsx'
import { INSTALL_SETUP_HASH, InstallSetup } from './onboarding/InstallSetup.tsx'
import { SecondFactorPrompt } from './admin/SecondFactorPrompt.tsx'
import { Onboarding } from './onboarding/Onboarding.tsx'
import { StepByStep } from './onboarding/StepByStep.tsx'
import { ImpersonationFrame } from './shell/ImpersonationBar.tsx'
import { switchToWorkspace } from './shell/invitations.ts'
import { linkNotice, linkWorkspace, linkWorkspaceTarget, withoutLinkWorkspace } from './shell/useRoute.ts'
import { TabWorkspaceGuard } from './shell/TabWorkspaceNotice.tsx'
import { disabledWorkspaceText, StoreProvider, useRun } from './store.tsx'
import { Workspace } from './Workspace.tsx'
import { AcceptInvite, clearInviteId, readInviteId } from './team/AcceptInvite.tsx'
import { BootScreen } from './ui/BootScreen.tsx'
import { AppLink } from './ui/AppLink.tsx'
import { AddPasskeyPage } from './AddPasskey.tsx'
import { ConnectAgent, isConnectAgentHash } from './integrations/ConnectAgent.tsx'
import { SignInLink, takeSignInLinkToken } from './SignInLink.tsx'
import { Signup } from './Signup.tsx'
import { CheckoutReturn } from './CheckoutReturn.tsx'
import { isCheckoutReturnPath, readCheckoutPartner } from './checkout.ts'
import { isSignupPath, signupCameFrom } from './signup.ts'
import { isInstanceAdmin, passkeySupported, type Me } from './auth.ts'
import { setProviderAudience } from './providerAudience.ts'
import { clearSignedIn, passkeyAsk, pausedAt, signedInJustNow } from './passkey-ask.ts'
import { brandName, loadBrand } from './brand.ts'
import { useMemberLocale } from './i18n/user.ts'
import { useT } from '@linedesk/i18n/react'
import { isPartnerHash, partnerInviteToken } from './partner/partner-api.ts'
import { PartnerArea } from './partner/PartnerArea.tsx'
import { PartnerInvite } from './partner/PartnerInvite.tsx'

/** Shown when the server is unreachable and this device has nothing to open offline. It retries on its own. */
function Unreachable() {
  const t = useT()
  return (
    <div className="boot" role="status">
      <b>{t('shell.unreachable.title', { brand: brandName() })}</b>
      <span>{t('shell.unreachable.text')}</span>
    </div>
  )
}

/**
 * On an address the server does not answer for (a white-label partner's address that is not live, or any other name
 * pointed at it): one quiet line, and the way to the install's own address when the server named it.
 */
function HostNotSetUp({ mainOrigin }: { mainOrigin: string | null }) {
  const t = useT()
  return (
    <div className="boot" role="status">
      <b>{t('shell.hostNotSetUp.title')}</b>
      {mainOrigin && <AppLink to={mainOrigin}>{t('shell.hostNotSetUp.link')}</AppLink>}
    </div>
  )
}

/** Whether the "Add a passkey" page comes before the app: right after signing in without one (passkey-ask.ts). */
function passkeyPageDue(me: Me | null): boolean {
  if (!me) return false
  return (
    passkeyAsk({
      hasPasskey: me.hasPasskey,
      supported: passkeySupported(),
      impersonating: Boolean(me.impersonation),
      emailUnconfirmed: Boolean(me.emailUnconfirmed),
      needsEnrolmentCode: Boolean(me.passkeyEnrolment),
      justSignedIn: signedInJustNow(),
      pausedAt: pausedAt(me.actorId),
      now: Date.now(),
    }) === 'prompt'
  )
}

/** Whether the address is this hash (#setup-install), or matches it (#setup-agent with ?allow=), followed as it changes. */
function useHashIs(hash: string | ((hash: string) => boolean)): boolean {
  const matches = useCallback(
    (current: string) => (typeof hash === 'string' ? current === hash : hash(current)),
    [hash],
  )
  const [on, setOn] = useState(() => matches(window.location.hash))
  useEffect(() => {
    const follow = () => setOn(matches(window.location.hash))
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [matches])
  return on
}

const isPartnerInviteHash = (hash: string) => partnerInviteToken(hash) !== null

/** Whether the address is in Admin (#admin…), followed as it changes. */
function useAdminHash(): boolean {
  const [admin, setAdmin] = useState(() => window.location.hash.startsWith('#admin'))
  useEffect(() => {
    const follow = () => setAdmin(window.location.hash.startsWith('#admin'))
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  return admin
}

const LINK_SWITCH = 'linedesk.linkSwitch'

/** Whether this tab already switched for the link to `id` (and remembers it now); null forgets it. */
function attemptedSwitch(id: string | null): boolean {
  try {
    const before = sessionStorage.getItem(LINK_SWITCH)
    if (id) sessionStorage.setItem(LINK_SWITCH, id)
    else sessionStorage.removeItem(LINK_SWITCH)
    return !!id && before === id
  } catch {
    return false // private mode: no guard, the switch itself checks membership
  }
}

export function App() {
  // A link from an email names its workspace (`?ws=` in the hash): read once at load, settled before the app opens.
  const [link, setLink] = useState(() => linkWorkspace(window.location.hash))
  // A member this device remembers sees their workspace at once, from local data; /v1/me is asked meanwhile
  // (refresh) and its answer replaces this, so another account or a lost workspace shows no longer than that.
  const [fromDevice] = useState(() => rememberedSession(link))
  const [session, setSession] = useState<Session>(() => fromDevice ?? { state: 'loading' })
  const [inviteId, setInviteId] = useState(readInviteId)
  // The sign-up page (`/signup?plan=…`, Signup.tsx): read once; leaving it goes to the app's own address.
  const [signupPage, setSignupPage] = useState(isSignupPath)
  // Opened from the workspace menu (signup.ts openSignup) and left with the browser's Back: the address decides.
  useEffect(() => {
    const follow = () => setSignupPage(isSignupPath())
    window.addEventListener('popstate', follow)
    return () => window.removeEventListener('popstate', follow)
  }, [])
  // Back from Stripe Checkout (`/billing/return?session_id=…`, CheckoutReturn.tsx): read once, like the sign-up page.
  const [checkoutReturn, setCheckoutReturn] = useState(isCheckoutReturnPath)
  // The sign-in email's button (`#sign-in=<token>`): its page comes first, until Continue or leaving it.
  const [signInLink, setSignInLink] = useState(takeSignInLinkToken)
  useEffect(() => {
    // Also when the link is opened in a tab that has the app open already (only the hash changes).
    const follow = () => {
      const token = takeSignInLinkToken()
      if (token) setSignInLink(token)
    }
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  // Finishing onboarding is a queued command; the app moves on without waiting for it.
  const [onboarded, setOnboarded] = useState(false)
  const adminHash = useAdminHash()
  const agentSetupHash = useHashIs(isAgentSetupHash)
  const installSetupHash = useHashIs(INSTALL_SETUP_HASH)
  // An MCP client's OAuth sign-in (#connect-agent?…, ConnectAgent.tsx): its consent page comes before the app.
  const connectAgentHash = useHashIs(isConnectAgentHash)
  // A white-label partner's area (#partner, docs/white-label.md) and its team invitation link (#partner-invite=…).
  const partnerHash = useHashIs(isPartnerHash)
  const partnerInviteHash = useHashIs(isPartnerInviteHash)
  // Workspace or Assistant settings › "Change with an AI agent" (#change-with-agent/…, agentChange.ts).
  const changeTarget = useChangeWithAgent()
  // Workspace or Assistant settings › "Step by step": the setup steps again (#step-by-step/…, onboarding/StepByStep.tsx).
  const stepTarget = useStepByStep()
  // An instance admin sets up with an AI agent first (AgentSetup.tsx), unless they chose to do it by hand.
  const [manualSetup, setManualSetup] = useState(false)
  // A workspace owner sets up their workspace with an AI agent first too (setup-choice.ts), unless they chose by hand.
  const [ownerByHand, setOwnerByHand] = useState(false)
  // The "Add a passkey" page was answered in this tab (or is not needed): on into the app.
  const [passkeyPageDone, setPasskeyPageDone] = useState(false)
  const shown = useRef(session)
  shown.current = session
  const signedOutHere = useRef(false)
  /** Shows what the server answered, in place of what is on screen (from this device, or an earlier answer). */
  const showAnswer = useCallback(async (next: Session) => {
    const before = shown.current
    // The answer is what is on screen already (a warm start): nothing renders again, only the local data check runs.
    if (sameSession(before, next)) return void forgetBeyond(next)
    // Another account than the one on screen: the page starts over for it, waiting for /v1/me. The open store
    // belongs to the other account and would be reused by the same workspace (storeCache.ts).
    if (before.state === 'ready' && next.state === 'ready' && next.me.actorId !== before.me.actorId) {
      await forgetBeyond(next)
      expectSessionChange()
      return window.location.reload()
    }
    // Signed out while a workspace was open (its sync has stopped): signing in loads the page fresh.
    if (next.state === 'signedOut' && before.state === 'ready') signedOutHere.current = true
    setSession(next)
  }, [])
  const refresh = useCallback(async () => showAnswer(await loadSession()), [showAnswer])
  // Renamed here (Workspace settings, onboarding): the session and the workspace list take the new name. Worked out
  // from the session on screen, outside a state updater: renamedWorkspace updates the cached workspace list, whose
  // subscribers (WorkspaceMenu) must not be updated while App renders.
  const renamed = useCallback((name: string) => {
    const next = renameInSession(shown.current, name)
    if (next) setSession(next)
  }, [])
  const [notice, setNotice] = useState<string | null>(null)
  const target = useMemo(
    () =>
      session.state === 'ready' && link
        ? linkWorkspaceTarget(link, session.me.workspace!.id, session.me.workspaces, session.offline)
        : null,
    [session, link],
  )
  useEffect(() => {
    if (!link || !target) return
    // A workspace the member belongs to: make it the session's and reload into the same page (it keeps the link,
    // which then names this workspace). Could not switch: the inbox says which workspace the link is for.
    if (target.kind === 'switch') {
      const failed = () => {
        window.history.replaceState(null, '', '#calls')
        setNotice(linkNotice({ kind: 'elsewhere', workspace: target.workspace }))
        setLink(null)
      }
      // Once per link and tab: should the reload not land in it, never switch again in a loop.
      if (attemptedSwitch(link)) return failed()
      switchToWorkspace(link, null).catch(failed)
      return
    }
    attemptedSwitch(null)
    // This workspace: the page opens without the parameter. Another one: the inbox, and why.
    window.history.replaceState(
      null,
      '',
      target.kind === 'here' ? withoutLinkWorkspace(window.location.hash) : '#calls',
    )
    setNotice(linkNotice(target))
    setLink(null)
  }, [link, target])
  useEffect(() => {
    void refresh()
  }, [refresh])
  // A member who has a passkey is never asked for one: a sign-in another way just now needs no page.
  const hasPasskey = session.state === 'ready' && session.me.hasPasskey === true
  useEffect(() => {
    if (hasPasskey) clearSignedIn()
  }, [hasPasskey])
  // Signed out anywhere (the API answered 401): ask who is signed in, and show the sign-in page if nobody is. The
  // address stays, so signing in returns to the same page. One check at a time; a 401 on the sign-in page itself
  // (or while loading) needs none.
  const sessionState = useRef(session.state)
  sessionState.current = session.state
  useEffect(() => {
    let checking = false
    return onUnauthorized(() => {
      const state = sessionState.current
      if (checking || (state !== 'ready' && state !== 'needsWorkspace')) return
      checking = true
      loadSession()
        .then(next => {
          if (next.state !== 'signedOut') return
          signedOutHere.current = true
          setSession(next)
        })
        .catch(() => {})
        .finally(() => {
          checking = false
        })
    })
  }, [])
  // Local data the session does not cover (signed out, removed from a workspace) is deleted; known once /v1/me answers.
  useEffect(() => {
    if (session !== fromDevice) void forgetBeyond(session)
  }, [session, fromDevice])

  // While the server cannot be reached, keep asking with growing pauses; also right away when the browser is back online.
  const waiting = session.state === 'unreachable' || (session.state === 'ready' && session.offline)
  useEffect(() => {
    if (!waiting) return
    let attempt = 0
    let timer: ReturnType<typeof setTimeout>
    const tryAgain = async () => {
      const next = await loadSession()
      if (next.state === 'unreachable' || (next.state === 'ready' && next.offline))
        timer = setTimeout(tryAgain, backoffMs(++attempt))
      else await showAnswer(next)
    }
    timer = setTimeout(tryAgain, backoffMs(attempt))
    const now = () => {
      clearTimeout(timer)
      void tryAgain()
    }
    window.addEventListener('online', now)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('online', now)
    }
  }, [waiting, showAnswer])

  // The brand follows the open workspace: a white-label partner's client sees the partner's (brand.ts), and signing
  // out or switching to a workspace of no partner brings the install's back.
  const brandScope =
    session.state === 'ready'
      ? `ws:${session.me.workspace?.id ?? ''}`
      : session.state === 'loading'
        ? null
        : session.state
  useEffect(() => {
    if (brandScope) void loadBrand()
  }, [brandScope])

  // The member's language (Account › Preferences); everything below re-renders when the active one changes.
  useMemberLocale(session.state === 'ready' || session.state === 'needsWorkspace' ? session.me : null)
  const t = useT()

  if (session.state === 'hostNotSetUp') return <HostNotSetUp mainOrigin={session.mainOrigin} />
  if (signInLink) {
    const signedIn = async () => {
      // The account may have changed (another one was signed in here): the page loads fresh for the new one.
      expectSessionChange()
      window.location.reload()
      await new Promise(() => {})
    }
    return <SignInLink token={signInLink} onDone={signedIn} onLeave={() => setSignInLink(null)} />
  }
  if (inviteId) {
    const leaveInvite = () => {
      clearInviteId()
      setInviteId(null)
      void refresh()
    }
    return <AcceptInvite invitationId={inviteId} onDone={leaveInvite} />
  }
  const sessionMe =
    session.state === 'ready'
      ? session.offline
        ? null
        : session.me
      : session.state === 'needsWorkspace'
        ? session.me
        : null
  if (!passkeyPageDone && !connectAgentHash && passkeyPageDue(sessionMe)) {
    const done = () => {
      clearSignedIn()
      setPasskeyPageDone(true)
    }
    return <AddPasskeyPage account={sessionMe!.actorId} onAdded={refresh} onDone={done} />
  }
  if (session.state === 'loading') return <BootScreen line={t('shell.boot.opening', { name: brandName() })} />
  if (session.state === 'unreachable') return <Unreachable />
  const pendingPayment = session.state === 'ready' && session.me.workspace?.billingState === 'pending_payment'
  if (
    signupPage &&
    !pendingPayment &&
    (session.state === 'signedOut' || session.state === 'needsWorkspace' || session.state === 'ready')
  ) {
    // From a workspace (the menu's New workspace…): the new one opens like any switch, with its own local store.
    const fromApp = session.state === 'ready'
    // A partner sign-up goes to Checkout from the page; it comes here only when Checkout could not open: the partner
    // area, whose "Add a card" starts it again.
    const leaveSignup = async (partner: boolean, workspaceId: string | null) => {
      window.history.replaceState(null, '', partner ? '/#partner' : '/')
      if (fromApp && workspaceId) return switchToWorkspace(workspaceId, null)
      if (partner) window.dispatchEvent(new HashChangeEvent('hashchange'))
      setSignupPage(false)
      await refresh()
    }
    const back = () => {
      window.history.replaceState(null, '', signupCameFrom())
      setSignupPage(false)
    }
    return (
      <Signup
        signedIn={session.state !== 'signedOut'}
        fromApp={fromApp ? { onBack: back } : undefined}
        onDone={leaveSignup}
      />
    )
  }
  if (session.state === 'signedOut') {
    // Signed out while the app was open: its sync had stopped for good, so the page loads fresh after signing in
    // (at the same address). The form stays busy until then.
    const reload = async () => {
      window.location.reload()
      await new Promise(() => {})
    }
    return <Login onDone={signedOutHere.current ? reload : refresh} />
  }
  if (connectAgentHash) {
    if (!sessionMe) return <Unreachable />
    return <ConnectAgent onLeave={() => (window.location.hash = '')} />
  }
  if (target)
    return (
      <BootScreen
        line={t('shell.boot.opening', { name: target.kind === 'switch' ? target.workspace.name : brandName() })}
      />
    )
  // A partner team invitation link, once signed in (a new address signs up with an email code on the sign-in page).
  const partnerToken = partnerInviteHash ? partnerInviteToken(window.location.hash) : null
  if (partnerToken && sessionMe && !sessionMe.impersonation) {
    const leavePartnerInvite = (joined: boolean) => {
      window.location.hash = joined ? '#partner' : ''
      void refresh()
    }
    return <PartnerInvite token={partnerToken} onDone={leavePartnerInvite} />
  }
  // The partner area needs no workspace; with one, Back (Esc) returns to it.
  const myPartner = sessionMe?.partners?.[0]
  if (partnerHash && myPartner && session.state === 'ready')
    return <PartnerArea partner={myPartner} onExit={() => (window.location.hash = '')} />
  // Back from Stripe Checkout (docs/billing.md §3.2 step 4): confirmed here, then the app opens as the bill now is. A
  // partner bill's Checkout (`&partner=`) comes back to someone who may be in no workspace yet, and on to #partner.
  if (checkoutReturn && (session.state === 'ready' || (session.state === 'needsWorkspace' && readCheckoutPartner()))) {
    const leaveReturn = async (toBilling: boolean, partner: boolean) => {
      // Minutes bought from Workspace settings › Billing: back there, where the new balance shows.
      window.history.replaceState(
        null,
        '',
        partner ? (toBilling ? '/#partner/billing' : '/#partner') : toBilling ? '/#workspace/billing' : '/',
      )
      // replaceState fires no hashchange: the partner area follows the hash, so it is told.
      if (partner) window.dispatchEvent(new HashChangeEvent('hashchange'))
      // The workspace as it is now first (the trial started): never a moment of the app as it was before Checkout.
      await refresh()
      setCheckoutReturn(false)
    }
    return <CheckoutReturn onDone={leaveReturn} />
  }
  if (session.state === 'needsWorkspace') {
    return (
      <ImpersonationFrame impersonation={session.impersonation}>
        <NoWorkspace
          me={session.me}
          lostWorkspace={session.lostWorkspace}
          onDone={refresh}
          onOpenInvite={setInviteId}
        />
      </ImpersonationFrame>
    )
  }
  // An instance admin by account, also before this session passed the passkey check: the setup pages are part of
  // Server admin, so they open on the passkey check (SecondFactorPrompt) until it is done.
  const instanceAdmin = isInstanceAdmin(session.me) && !session.me.impersonation
  // Onboarding opens before Workspace (which sets it too): its admin-only links need the audience as well.
  setProviderAudience(isInstanceAdmin(session.me) ? 'admin' : 'member')
  const settingUp = session.me.onboarding && !onboarded
  // The install by hand, step by step (InstallSetup.tsx); leaving it goes on to the business setup.
  if (instanceAdmin && installSetupHash) {
    if (session.me.adminSecondFactor)
      return <SecondFactorPrompt state={session.me.adminSecondFactor} onExit={() => (window.location.hash = '')} />
    return (
      <InstallSetup
        onExit={() => {
          // However it was opened, leaving it goes on to the business setup, not back to the agent page.
          rememberManual(true)
          setManualSetup(true)
          if (window.location.hash === INSTALL_SETUP_HASH) window.location.hash = ''
          void refresh()
        }}
      />
    )
  }
  if (instanceAdmin && !adminHash && (agentSetupHash || (settingUp && !choseManualSetup(session.me, manualSetup)))) {
    const leave = () => {
      if (isAgentSetupHash(window.location.hash)) window.location.hash = ''
    }
    // Back from the passkey check goes on by hand, not back to this page; naming the business also waits for the
    // passkey check.
    if (session.me.adminSecondFactor)
      return (
        <SecondFactorPrompt
          state={session.me.adminSecondFactor}
          onExit={() => {
            rememberManual(true)
            setManualSetup(true)
            leave()
          }}
        />
      )
    return (
      <AgentSetup
        onManual={installFirst => {
          setManualSetup(true)
          // The install by hand, step by step (off on Cloud: it opens the setup checklist instead).
          if (installFirst) window.location.hash = INSTALL_SETUP_HASH
          else leave()
        }}
        onDone={() => {
          leave()
          void refresh()
        }}
        active={{ id: session.me.workspace!.id, account: session.me.actorId }}
      />
    )
  }
  // A workspace owner who is no server admin: the agent setup for this one workspace first (AgentSetup, scope
  // "workspace"); by hand opens the step-by-step onboarding. Inside the store: the test call and forwarding need it.
  const ownerSetup = ownerAgentSetupDue(session.me, {
    instanceAdmin: isInstanceAdmin(session.me),
    hashOpen: agentSetupHash,
    byHand: ownerChoseByHand(session.me.workspace!.id, ownerByHand) || onboarded,
  })
  const leaveOwnerSetup = () => {
    if (isAgentSetupHash(window.location.hash)) window.location.hash = ''
  }
  // Another member or workspace than on screen (the answer to a warm start): everything below starts over.
  return (
    <ImpersonationFrame
      key={`${session.me.actorId}/${session.me.workspace!.id}`}
      impersonation={session.me.impersonation ?? null}
    >
      <StoreProvider
        workspaceId={session.me.workspace!.id}
        account={session.me.actorId}
        readOnly={session.me.workspace?.disabled ? disabledWorkspaceText() : undefined}
      >
        <TabWorkspaceGuard me={session.me}>
          {ownerSetup ? (
            <OwnerAgentSetup
              active={{ id: session.me.workspace!.id, account: session.me.actorId }}
              // Waiting for its trial: the owner starts it on the page's Start your trial row.
              trial={
                session.me.workspace?.billingState === 'pending_payment'
                  ? { me: session.me, onTermsChanged: () => void refresh() }
                  : undefined
              }
              // While the onboarding is open: finish it later, as the business onboarding's "Finish later" does. Not
              // while the workspace waits for its trial: nothing to finish later before it (as in Onboarding.tsx).
              onLater={
                settingUp && session.me.workspace?.billingState !== 'pending_payment'
                  ? () => {
                      rememberOwnerByHand(session.me.workspace!.id, true)
                      setOwnerByHand(true)
                      leaveOwnerSetup()
                      setOnboarded(true)
                    }
                  : undefined
              }
              onManual={() => {
                rememberOwnerByHand(session.me.workspace!.id, true)
                setOwnerByHand(true)
                leaveOwnerSetup()
              }}
              onDone={() => {
                // Done with the agent: the app as it is now (onboarding where the agent left it, or the inbox).
                rememberOwnerByHand(session.me.workspace!.id, true)
                setOwnerByHand(true)
                leaveOwnerSetup()
                void refresh()
              }}
            />
          ) : changeTarget && mayChangeWithAgent(session.me) && !settingUp ? (
            <ChangeWithAgent
              target={changeTarget}
              workspace={{ id: session.me.workspace!.id, name: session.me.workspace!.name }}
              account={session.me.actorId}
            />
          ) : stepTarget && mayStepThrough(session.me) && !settingUp ? (
            <StepByStep target={stepTarget} me={session.me} onRenamed={renamed} />
          ) : /* An instance admin can open Admin in the middle of onboarding (the business step links to Providers). */
          session.me.onboarding && !onboarded && !(adminHash && isInstanceAdmin(session.me)) ? (
            <Onboarding
              // Starting the trial changes the steps (activate, then the number): the flow starts again from the server's.
              key={session.me.workspace?.billingState ?? 'off'}
              me={session.me}
              state={session.me.onboarding}
              onDone={() => setOnboarded(true)}
              onRenamed={renamed}
              onReload={() => void refresh()}
            />
          ) : (
            <Workspace
              me={session.me}
              onSignedOut={refresh}
              onSessionStale={refresh}
              notice={notice}
              onRenamed={renamed}
            />
          )}
        </TabWorkspaceGuard>
      </StoreProvider>
    </ImpersonationFrame>
  )
}

/**
 * The owner's agent setup page (AgentSetup, scope "workspace"). `onLater`: "Finish later" in its top bar, as in the
 * business onboarding (Onboarding.tsx): the onboarding is set aside (step "skipped"), what is left waits in the go-live
 * checklist.
 */
function OwnerAgentSetup({
  active,
  onManual,
  onDone,
  onLater,
  trial,
}: {
  active: { id: string; account: string }
  onManual: () => void
  onDone: () => void
  onLater?: () => void
  trial?: ComponentProps<typeof AgentSetup>['trial']
}) {
  const run = useRun()
  return (
    <AgentSetup
      scope="workspace"
      active={active}
      trial={trial}
      onManual={onManual}
      onDone={onDone}
      onLater={
        onLater
          ? () => {
              void run('onboarding.setStep', { step: 'skipped' })
              onLater()
            }
          : undefined
      }
    />
  )
}
