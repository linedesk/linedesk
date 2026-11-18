// Agent-first setup (LIN-125): the first thing an instance admin sees while the install or their business is not set
// up. An AI agent (Claude Code, Claude, ChatGPT, Codex, Cursor, any MCP client) connects to the setup MCP with a
// setup key and does the setup with them; this page makes the key, says how to connect each agent, gives the prompt,
// and shows the agent's progress as it works. Setting up by hand stays one small link away.
// The page is part of Server admin, so it opens only after the admin's passkey check (App.tsx, SecondFactorPrompt):
// the passkey is no step here. Every step the admin does themselves is finished here, never sent into the app: the
// call forwarding and the test call (SetupRowActions.tsx). The agent ends its own access at the end; the page then says when.
// The server's steps are once per install; the workspace steps below them belong to the workspace picked in the
// dropdown that heads them (one per business or location, LIN-237). Picking one makes it the app's active workspace, so
// the forwarding and the test call always act on the workspace shown.
// Once everything is set up the page stays the way to change things: a new link for the agent, or the install
// walkthrough step by step (Server admin › Providers on Cloud, where the walkthrough is off).
// `scope="workspace"`: the same page for a workspace owner who is no server admin (a Linedesk Cloud customer). Their
// link is for the active workspace only (agentSetup.createWorkspaceKey, GET /v1/workspace/agent-setup): the page shows
// only that workspace's steps, no server part, no workspace dropdown and nothing of Server admin; setting up by hand
// leads into the step-by-step onboarding.
// `scope="partner"`: a white-label partner owner's page (#partner/agent, partner/PartnerAgentSetup.tsx): a link for the
// partner and its client workspaces only (agentSetup.createPartnerKey, GET /v1/partner/agent-setup); the partner's
// steps, then the client workspace picked in the dropdown. The owner's own rows: adding a client workspace (a seat on
// the partner bill, the partner area's New client dialog), a number, the call forwarding and the test call.
import {
  AGENT_SETUP_HASH,
  type AgentClient,
  type AgentSetupKeyCreated,
  type AgentSetupState,
  type MyPartner,
  agentClientLabels,
  agentClients,
  cloudClients,
  SETUP_KEY_HOURS,
  HOSTING_GUIDE_URL,
  installPlace,
  type SetupChange,
  type SetupScope,
  type SetupWorkspaceSummary,
  setupStepGroups,
  setupStepNames,
  startPlan,
  stepsByGroup,
} from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { loadAgentSetup, loadInstallSetup, runAdmin, watchAdminSignIn } from '../admin/api.ts'
import { ADMIN_INSTALL_SETUP } from '../admin/Providers.tsx'
import { SecondFactorPrompt } from '../admin/SecondFactorPrompt.tsx'
import type { AdminSecondFactor, Me } from '../auth.ts'
import { brandName, installBrandName } from '../brand.ts'
import { useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { SETUP_LINK_KEY, signInAgain as signOutAndSignIn } from '../localData.ts'
import { callAction } from '../settings/settings-api.ts'
import { dateTimeLabel, untilLabel } from '../time.ts'
import { HelpTip } from '../ui/HelpTip.tsx'
import { LoadProblem, Skeleton, SkeletonChecklist, SkeletonPart, useLoading } from '../ui/LoadStates.tsx'
import { Button, cx, Icon, Note, Spinner } from '../ui/kit.tsx'
import { MarkGlyph } from '../ui/StatusMark.tsx'
import { AgentPicker } from './AgentPicker.tsx'
import { installPartsMissing } from './agent-setup-passkey.ts'
import { NewWorkspaceDialog } from '../shell/NewWorkspace.tsx'
import { microphoneAllowed } from '../call/microphone.ts'
import { switchToWorkspace } from '../shell/invitations.ts'
import { Select } from '../ui/controls.tsx'
import { CopyButton } from './Frame.tsx'
import { SetupFoot } from './SetupFoot.tsx'
import { SetupTopBar } from './SetupTopBar.tsx'
import { openInstallSetup } from './InstallSetup.tsx'
import { clearResume, peekResume, type ResumeAction, saveResume } from './resume-after-switch.ts'
import {
  SetupActivatePartner,
  type SetupWorkspace,
  SetupForwarding,
  SetupStartTrial,
  SetupTestCall,
} from './SetupRowActions.tsx'
import { PARTNER_AGENT_HASH, rememberManual } from './setup-choice.ts'
import { loadPartnerAgentSetup, loadWorkspaceAgentSetup } from './workspace-agent-setup.ts'
import { NewClientDialog } from '../partner/PartnerArea.tsx'
import { loadPartner, PARTNER_QUERY } from '../partner/partner-api.ts'
import { tabWorkspace } from '../tabWorkspace.ts'
import './agent-setup.css'

export { choseManualSetup, rememberManual } from './setup-choice.ts'

const CLIENT_KEY = 'linedesk.setup.client'

function savedClient(): AgentClient {
  try {
    const saved = localStorage.getItem(CLIENT_KEY)
    return (agentClients as readonly string[]).includes(saved ?? '') ? (saved as AgentClient) : 'claude_code'
  } catch {
    return 'claude_code'
  }
}

/** The address of the setup page (#setup-agent): opened from Server admin › Overview, or after choosing the manual way. */
export { AGENT_SETUP_HASH, isAgentSetupHash } from '@linedesk/actions'
export const openAgentSetup = () => {
  rememberManual(false)
  window.location.hash = AGENT_SETUP_HASH
}

const POLL_MS = 3000

/**
 * The setup link made in this browser, kept until it ends: it expires, a new one is made, the admin ends agent access
 * or signs out (localData.ts). So a reload, another tab or picking another agent still shows the link and how to
 * start with it. The page shows it only while the server says this admin's working link is this one (AgentSetup).
 * In memory too, for private windows without storage. One slot per link: the install link, and each workspace
 * owner's link under its workspace's id (setupLinkSlot), so one workspace's page never holds another's link.
 */
const shownKeys = new Map<string, AgentSetupKeyCreated>()
const unexpired = (link: AgentSetupKeyCreated | null) => (link && Date.parse(link.expiresAt) > Date.now() ? link : null)
/** Where a link is kept: the install link at SETUP_LINK_KEY, a workspace owner's link under that workspace. */
export const setupLinkSlot = (scope: SetupScope, workspaceId: string | null, partnerId: string | null = null) =>
  scope === 'workspace'
    ? `${SETUP_LINK_KEY}.workspace.${workspaceId ?? 'none'}`
    : scope === 'partner'
      ? `${SETUP_LINK_KEY}.partner.${partnerId ?? 'none'}`
      : SETUP_LINK_KEY
function stillShown(slot: string): AgentSetupKeyCreated | null {
  const inMemory = unexpired(shownKeys.get(slot) ?? null)
  if (inMemory) return inMemory
  shownKeys.delete(slot)
  try {
    const saved = unexpired(JSON.parse(localStorage.getItem(slot) ?? 'null') as AgentSetupKeyCreated | null)
    if (!saved) localStorage.removeItem(slot)
    return saved
  } catch {
    return null
  }
}
function keepShown(slot: string, link: AgentSetupKeyCreated | null) {
  if (link) shownKeys.set(slot, link)
  else shownKeys.delete(slot)
  try {
    if (link) localStorage.setItem(slot, JSON.stringify(link))
    else localStorage.removeItem(slot)
  } catch {
    // Private windows: the link lasts while this page is open.
  }
}

type Props = {
  /**
   * Set up by hand. `installFirst`: the install is not set up yet, so the setup checklist (Server admin › Overview) comes
   * first; otherwise the business onboarding (or "Name your business" before there is a workspace).
   */
  onManual: (installFirst: boolean) => void
  /** The agent is done (or the admin wants to look): open the app as it is now. */
  onDone: () => void
  /** Called once the agent has created the admin's business (the page around this one needs a workspace to go on). */
  onWorkspaceReady?: () => void
  /**
   * The app's active workspace in this tab, once there is one: the page shows its steps (when the admin is owner or
   * admin there), and the test call and the forwarding check run in it. Picking another workspace switches it.
   */
  active?: SetupWorkspace
  /**
   * `workspace`: a workspace owner's page for the active workspace (`active` is required then): their own link and
   * that workspace's steps only, the title naming the software (brandName), never the business. Default `install`: an
   * instance admin's.
   */
  scope?: SetupScope
  /**
   * With `scope="workspace"`: change some settings of a workspace that is set up (Workspace or Assistant settings ›
   * "Change with an AI agent"): the title and the prompt name the workspace (and the assistant), and the way back is
   * "Back to settings" (`onManual`) in place of setting up by hand.
   */
  change?: SetupChange
  /**
   * The owner's onboarding: "Finish later" in the top bar (and Shift+Esc), as on the admin's install walkthrough and
   * the business onboarding: what is left waits in the go-live checklist.
   */
  onLater?: () => void
  /**
   * With `scope="workspace"` while the workspace waits for its trial: the owner starts it on its row (the onboarding's
   * activation step, in a dialog). `onTermsChanged`: the terms changed meanwhile, /v1/me is read again.
   */
  trial?: StartTrialProps
  /** With `scope="partner"` (required then): the partner this page sets up; its owner is the one here. */
  partner?: MyPartner
  /** With `scope="partner"` in no workspace yet: the first client workspace was made, the session loads again. */
  onFirstWorkspace?: () => void
}

type StartTrialProps = { me: Me; onTermsChanged: () => void }

export function AgentSetup({
  onManual,
  onDone,
  onWorkspaceReady,
  active,
  scope = 'install',
  change,
  onLater,
  trial,
  partner,
  onFirstWorkspace,
}: Props) {
  const t = useT()
  const owner = scope === 'workspace'
  // A partner's owner: no Server admin (no passkey check, no server part, no hosting note), as a workspace owner.
  const partnerId = scope === 'partner' ? (partner?.id ?? null) : null
  const personal = owner || partnerId !== null
  // A partner's own setup shows the install's brand, never its white-label one (brand.ts), even with a client open.
  const product = scope === 'partner' ? installBrandName() : brandName()
  const [state, setState] = useState<AgentSetupState | null>(null)
  const activeId = active?.id ?? null
  const [loadError, setLoadError] = useState<string | null>(null)
  const slot = setupLinkSlot(scope, owner ? activeId : null, partnerId)
  const [created, setShown] = useState<AgentSetupKeyCreated | null>(() => stillShown(slot))
  // When the link on the page was set (0: kept from before), and when the shown state was asked for: only a state
  // asked for after the link was set can say it ended.
  const linkSetAt = useRef(0)
  const stateAskedAt = useRef(0)
  const setCreated = useCallback(
    (key: AgentSetupKeyCreated | null) => {
      keepShown(slot, key)
      linkSetAt.current = Date.now()
      setShown(key)
    },
    [slot],
  )
  // Another workspace in this tab: its own link (or none), never the one before.
  const shownSlot = useRef(slot)
  useEffect(() => {
    if (shownSlot.current === slot) return
    shownSlot.current = slot
    linkSetAt.current = 0
    setShown(stillShown(slot))
  }, [slot])

  const [client, setClient] = useState<AgentClient>(savedClient)
  const [busy, setBusy] = useState<'create' | 'end' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A workspace owner's link needs a sign-in from the last 10 minutes (the server's SIGN_IN_AGAIN).
  const [signInFirst, setSignInFirst] = useState(false)
  // The passkey check ran out (12 hours): the page turns into the passkey prompt, never an error line.
  const [signInAgain, setSignInAgain] = useState<AdminSecondFactor | null>(null)
  // Server admin's passkey check: not the owner's page, which is no part of Server admin.
  useEffect(() => (personal ? undefined : watchAdminSignIn(setSignInAgain)), [personal])
  const load = useCallback(async () => {
    try {
      const asked = Date.now()
      const next = partnerId
        ? await loadPartnerAgentSetup(partnerId, activeId)
        : owner
          ? await loadWorkspaceAgentSetup()
          : await loadAgentSetup(activeId)
      if (asked < stateAskedAt.current) return // an older answer that arrived late
      stateAskedAt.current = asked
      setState(next)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('onboarding.agentSetup.error.read'))
    }
  }, [activeId, owner, partnerId, t])
  // The agent works in another window: show its progress as it goes (only while this tab is visible).
  useEffect(() => {
    void load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  // There is a workspace once the progress has one (the business row stays open until its profile is saved too).
  const workspaceReady = Boolean(state?.progress.workspace)
  const told = useRef(false)
  useEffect(() => {
    if (!workspaceReady || told.current) return
    told.current = true
    onWorkspaceReady?.()
  }, [workspaceReady, onWorkspaceReady])

  const pick = (next: AgentClient) => {
    setClient(next)
    try {
      localStorage.setItem(CLIENT_KEY, next)
    } catch {
      // Not remembered in private windows.
    }
  }
  const createKey = async () => {
    setBusy('create')
    setError(null)
    setSignInFirst(false)
    try {
      setCreated(
        partnerId
          ? await callAction<AgentSetupKeyCreated>('agentSetup.createPartnerKey', { partnerId })
          : owner
            ? await callAction<AgentSetupKeyCreated>('agentSetup.createWorkspaceKey')
            : ((await runAdmin('agentSetup.createKey', {})) as AgentSetupKeyCreated),
      )
      await load()
    } catch (e) {
      if ((e as { code?: unknown }).code === 'SIGN_IN_AGAIN') return setSignInFirst(true)
      setError(e instanceof Error ? e.message : t('onboarding.agentSetup.error.create'))
    } finally {
      setBusy(null)
    }
  }
  const endAccess = async () => {
    setBusy('end')
    setError(null)
    try {
      if (partnerId) await callAction('agentSetup.revokePartner', { partnerId })
      else if (owner) await callAction('agentSetup.revokeWorkspace')
      else await runAdmin('agentSetup.revoke', {})
      setCreated(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('onboarding.agentSetup.error.end'))
    } finally {
      setBusy(null)
    }
  }
  const manual = () => {
    // The owner's choice is kept by the page around this one (setup-choice.ts, per workspace or partner).
    if (personal) return onManual(false)
    rememberManual(true)
    onManual(state ? installPartsMissing(state.progress.steps) : false)
  }
  // Everything is set up: the page offers to change it, with the agent or the install walkthrough (opens at its
  // first part, nothing saved is reset; off on Cloud, where Server admin › Providers is the way by hand).
  const allDone = state?.progress.allDone ?? false
  const install = useQuery(personal ? null : ADMIN_INSTALL_SETUP, () => loadInstallSetup()).data
  const stepByStep = () => {
    if (install?.enabled === false) window.location.hash = '#admin/providers'
    else openInstallSetup({ from: 'start' })
  }

  const connected = Boolean(state?.key?.lastUsedAt)
  // One setup link at a time: while one is active the page offers only to end it, otherwise only to create one.
  // The link ended elsewhere (expired, replaced in another browser, agent access ended): it goes from the page too.
  useEffect(() => {
    if (!state || !created || stateAskedAt.current < linkSetAt.current) return
    if (state.key?.prefix !== created.prefix || !unexpired(created)) setCreated(null)
  }, [state, created, setCreated])
  const hasLink = state ? Boolean(state.key) : Boolean(created)
  const cloudBlocked = state !== null && !state.reachableFromCloud && cloudClients.includes(client)
  // Until the first read of the setup state, everything on the page that depends on it is a skeleton of its shape
  // (docs/design-principles.md rule 15): the title, the link step's button, the checklist and the way by hand. A
  // failed or endless first read turns the checklist into the load problem; the rest shows as for a new install.
  const view = useLoading(state === null && !loadError)
  const skeleton = state === null && (view.phase === 'reserve' || view.phase === 'skeleton')
  const reserved = view.phase === 'reserve'
  // The line under the top bar: how much of the checklist is done.
  const checklist = state?.progress.steps ?? []
  const checklistDone = checklist.length
    ? Math.round((checklist.filter(s => s.state === 'done').length / checklist.length) * 100)
    : 0
  // Open the app once there is a workspace to open (the agent connected, or all done); not while the workspace waits
  // for its trial (the app would only show the card step) and not on a partner's page (its way is the partner area).
  const openApp = (allDone || connected) && Boolean(state?.progress.workspace) && !trial && partnerId === null
  // The quiet way in the footer's back slot: by hand, or step by step once everything is set up. Changing settings
  // has none: the top bar's Close goes back to them.
  const foot =
    change || (allDone && owner) || (allDone && partnerId)
      ? {}
      : allDone
        ? {
            onBack: stepByStep,
            backLabel: t('onboarding.agentSetup.stepByStep'),
            backTitle: t('onboarding.agentSetup.stepByStepTitle'),
            backIcon: false,
          }
        : {
            onBack: manual,
            backLabel: t(partnerId ? 'onboarding.agentSetup.partner.byHand' : 'onboarding.agentSetup.manual'),
            backTitle: t(partnerId ? 'onboarding.agentSetup.partner.byHandTitle' : 'onboarding.agentSetup.manualTitle'),
            backIcon: false,
          }
  // After signing in, the page loads again at the same address (SecondFactorPrompt).
  if (signInAgain) return <SecondFactorPrompt state={signInAgain} onExit={onDone} />
  return (
    <div
      className={cx('ob as', scope === 'partner' && 'k-install-brand')}
      role="main"
      aria-label={t('onboarding.agentSetup.ariaLabel', { brand: product })}
      aria-busy={skeleton || undefined}
    >
      {skeleton && (
        <span className="sr-only" role="status">
          {t('onboarding.agentSetup.loading')}
        </span>
      )}
      <SetupTopBar
        label={t('team.partner.setup.way.agent')}
        progress={change ? 0 : checklistDone}
        exit={
          change
            ? { kind: 'close', onExit: () => onManual(false), title: t('onboarding.agentSetup.change.backTitle') }
            : onLater
              ? {
                  kind: 'finish-later',
                  onExit: onLater,
                  // A partner's setup waits in the partner area, not in a go-live checklist.
                  title: partnerId ? t('team.partner.setup.finishLaterTitle') : undefined,
                }
              : null
        }
        brand={scope === 'partner' ? 'install' : 'app'}
        workspaceId={active?.id}
        away={scope === 'partner'}
      />
      <div className="ob-main as-main">
        <div className={cx('ob-body', view.fadeIn && 'ld-in')}>
          <span className="as-kicker">
            <Icon name="spark" size={14} /> {t('onboarding.agentSetup.kicker')}
          </span>
          {skeleton ? (
            <SkeletonPart reserved={reserved}>
              <Skeleton className="as-sk-h1" width="74%" />
              <span className="ob-lede as-sk-lede">
                <Skeleton shape="text" width="100%" />
                <Skeleton shape="text" width="98%" />
                <Skeleton shape="text" width="94%" />
                <Skeleton shape="text" width="18%" />
              </span>
            </SkeletonPart>
          ) : change ? (
            <>
              <h1>
                {change.assistant
                  ? t('onboarding.agentSetup.change.assistantTitle', { name: change.assistant.name })
                  : t('onboarding.agentSetup.change.workspaceTitle')}
              </h1>
              <p className="ob-lede">{t('onboarding.agentSetup.change.lede', { workspace: change.workspaceName })}</p>
            </>
          ) : partnerId ? (
            <>
              <h1>
                {allDone
                  ? t('onboarding.agentSetup.partner.changeTitle', { partner: partner?.name ?? '' })
                  : t('onboarding.agentSetup.partner.title', { partner: partner?.name ?? '' })}
              </h1>
              <p className="ob-lede">
                <T k="onboarding.agentSetup.partner.lede" values={{ b: chunks => <b>{chunks}</b> }} />
              </p>
            </>
          ) : allDone ? (
            <>
              <h1>{t('onboarding.agentSetup.changeTitle', { brand: brandName() })}</h1>
              <p className="ob-lede">{t('onboarding.agentSetup.changeLede')}</p>
            </>
          ) : (
            <>
              <h1>{t('onboarding.agentSetup.title', { brand: brandName() })}</h1>
              <p className="ob-lede">
                <T
                  k={owner ? 'onboarding.agentSetup.owner.lede' : 'onboarding.agentSetup.lede'}
                  values={{ b: chunks => <b>{chunks}</b> }}
                />
              </p>
            </>
          )}
        </div>

        {/* Before the state is read, this page's own address stands for the server's: the note shows at once. Where
            the server runs is its admin's business, not a workspace owner's. */}
        {!personal && <HostingNote address={state?.mcpUrl ?? `${globalThis.location?.origin ?? ''}/mcp/setup`} />}

        <section className="as-card" aria-label={t('onboarding.agentSetup.yourAgent')}>
          <div className="as-link-step">
            <b className="as-step-title">
              {t('onboarding.agentSetup.link.title')}
              <HelpTip
                label={t('onboarding.agentSetup.link.helpLabel')}
                text={t(
                  partnerId
                    ? 'onboarding.agentSetup.partner.linkHelp'
                    : owner
                      ? 'onboarding.agentSetup.owner.linkHelp'
                      : 'onboarding.agentSetup.link.help',
                  { hours: SETUP_KEY_HOURS },
                )}
              />
            </b>
            <AgentPicker client={client} onPick={pick} />
            {cloudBlocked && (
              <Note
                tone="warning"
                title={t('onboarding.agentSetup.cloudBlocked.title', { agent: agentClientLabels[client] })}
              >
                {t('onboarding.agentSetup.cloudBlocked.body', {
                  agent: agentClientLabels[client],
                  address: state?.mcpUrl.replace(/\/mcp\/setup$/, '') ?? '',
                  brand: product,
                })}
              </Note>
            )}
            {hasLink ? (
              <>
                <div className="as-link">
                  <span className="as-small">
                    {t('onboarding.agentSetup.link.ready', {
                      until: timeOf(created?.expiresAt ?? state?.key?.expiresAt ?? ''),
                    })}
                  </span>
                  <Button
                    size="sm"
                    busy={busy === 'end'}
                    onClick={() => void endAccess()}
                    title={t('onboarding.agentSetup.link.endTitle')}
                  >
                    {t('onboarding.agentSetup.link.end')}
                  </Button>
                </div>
                {created ? (
                  <StartAgent client={client} url={created.url} scope={scope} change={change} />
                ) : (
                  <span className="as-small">{t('onboarding.agentSetup.link.otherBrowser')}</span>
                )}
              </>
            ) : skeleton ? (
              <div className="as-step">
                <SkeletonPart reserved={reserved}>
                  <Skeleton width={148} height={32} />
                </SkeletonPart>
              </div>
            ) : (
              <div className="as-step">
                {state?.endedByAgentAt && <AgentEndedNote at={state.endedByAgentAt} />}
                <div>
                  <Button
                    variant={allDone ? 'secondary' : 'primary'}
                    busy={busy === 'create'}
                    onClick={() => void createKey()}
                  >
                    {t('onboarding.agentSetup.link.create')}
                  </Button>
                </div>
              </div>
            )}
          </div>
          {signInFirst && (
            <Note
              tone="warning"
              title={t('onboarding.agentSetup.owner.signInFirst.title')}
              action={
                <Button size="sm" title={t('account.signInAgain.title')} onClick={() => void signOutAndSignIn()}>
                  {t('account.signInAgain.button')}
                </Button>
              }
            >
              {partnerId
                ? t('onboarding.agentSetup.partner.signInFirst', { hours: SETUP_KEY_HOURS })
                : t('onboarding.agentSetup.owner.signInFirst.text')}
            </Note>
          )}
          {error && <Note tone="danger">{error}</Note>}
        </section>

        {state ? (
          <Progress
            state={state}
            connected={connected}
            change={Boolean(change)}
            active={active ?? null}
            reload={load}
            fadeIn={view.fadeIn}
            single={owner}
            trial={trial}
            partner={partner ?? null}
            partnerScope={partnerId !== null}
            onFirstWorkspace={onFirstWorkspace}
          />
        ) : skeleton ? (
          <ProgressSkeleton reserved={reserved} single={owner} scope={scope} />
        ) : (
          <LoadProblem
            what={t('onboarding.agentSetup.progressWhat')}
            message={loadError ?? undefined}
            onRetry={() => void load()}
          />
        )}

        {skeleton ? (
          <div className="ob-foot">
            <SkeletonPart reserved={reserved}>
              <Skeleton width={148} height={36} />
            </SkeletonPart>
          </div>
        ) : (
          <SetupFoot
            {...foot}
            primary={
              openApp ? (
                <Button variant={allDone && !hasLink ? 'primary' : 'secondary'} onClick={onDone}>
                  {allDone
                    ? t('onboarding.agentSetup.open', { brand: brandName() })
                    : t('onboarding.agentSetup.openNow', { brand: brandName() })}
                </Button>
              ) : partnerId && allDone ? (
                <Button
                  variant={hasLink ? 'secondary' : 'primary'}
                  onClick={onDone}
                  title={t('onboarding.agentSetup.partner.areaTitle')}
                >
                  {t('onboarding.agentSetup.partner.area')}
                </Button>
              ) : null
            }
          />
        )}
      </div>
    </div>
  )
}

const timeOf = (iso: string) => untilLabel(new Date(iso))

/** The dropdown's item that opens "New workspace" instead of picking one. */
export const NEW_WORKSPACE = '__new'
/** Its value while the admin has no workspace yet. */
const NO_WORKSPACE = ''

/**
 * The steps the setup checklist shows while its first state is read, in the server's order (setup-mcp.ts): the
 * server's, then a workspace's. The rows with a button on this page (forwarding, the test call) are as tall as it.
 */
const SKELETON_GROUPS: Record<(typeof setupStepGroups)[number]['id'], readonly string[]> = {
  partner: ['company', 'brand', 'team', 'clients', 'plan'],
  server: ['answering', 'telephony', 'email', 'call-audio'],
  business: ['business', 'assistant', 'pickup', 'notify', 'phone', 'forwarding', 'test_call'],
}
const SKELETON_ACTIONS: Record<string, number> = { forwarding: 124, test_call: 132, clients: 104, plan: 178 }

/** A step's row width: its name (13px) and, after " · ", its hint (12px), about as long as the words. */
export function stepSkeletonRow(id: string): { label: number; action?: number } {
  const name = setupStepNames[id] ?? { label: id }
  const label = Math.round(name.label.length * 7 + (name.hint ? 12 + name.hint.length * 6 : 0))
  return SKELETON_ACTIONS[id] ? { label, action: SKELETON_ACTIONS[id] } : { label }
}

/** The setup checklist while its first state is read: its card, head, group headings, dropdown and rows. */
export function ProgressSkeleton({
  reserved,
  single = false,
  scope = 'install',
}: {
  reserved: boolean
  single?: boolean
  scope?: SetupScope
}) {
  const t = useT()
  // A workspace owner's page: the workspace's part only; a partner's: the partner's and a client workspace's; an
  // instance admin's: the server's and a workspace's.
  const groups = setupStepGroups.filter(g =>
    single ? g.id === 'business' : scope === 'partner' ? g.id !== 'server' : g.id !== 'partner',
  )
  return (
    <section className="as-card as-progress" aria-label={t('onboarding.agentSetup.progress.label')}>
      <SkeletonPart reserved={reserved}>
        <div className="as-progress-head">
          <Skeleton shape="text" width={176} />
          <Skeleton shape="text" width={72} />
        </div>
        {groups.map(group => (
          <div key={group.id} className={cx('as-group', group.id === 'business' && 'as-group-ws')}>
            {group.id === 'business' ? (
              <div className="as-ws-head">
                <span className="as-group-label">{t('onboarding.agentSetup.workspace.label')}</span>
                <Skeleton width={184} height={28} />
              </div>
            ) : (
              <h3 className="as-group-label">{groupLabel(group, t)}</h3>
            )}
            <SkeletonChecklist
              rows={SKELETON_GROUPS[group.id].map(stepSkeletonRow)}
              listClassName="as-list"
              rowClassName="as-item"
            />
          </div>
        ))}
      </SkeletonPart>
    </section>
  )
}

/** What the agent has set up so far, live. */
function Progress({
  state,
  connected,
  change = false,
  active,
  reload,
  fadeIn,
  single = false,
  trial,
  partner = null,
  partnerScope = false,
  onFirstWorkspace,
}: {
  state: AgentSetupState
  connected: boolean
  /** Changing settings (AgentSetup's `change`): what the agent can change, with no "set up" words and no count. */
  change?: boolean
  active: SetupWorkspace | null
  reload: () => Promise<void>
  /** The state just arrived after the skeleton: the card fades in. */
  fadeIn: boolean
  /** A workspace owner's page: one workspace, named, with no dropdown (no switching, no new workspace). */
  single?: boolean
  /** Waiting for the trial: the owner starts it on the Start your trial row. */
  trial?: StartTrialProps
  /** A partner owner's page: its client workspaces in the dropdown; "New client" in place of "New workspace". */
  partner?: MyPartner | null
  partnerScope?: boolean
  onFirstWorkspace?: () => void
}) {
  const t = useT()
  // The assistant answered a test call made here: the row shows done at once; the next read of the progress agrees.
  const [calledHere, setCalledHere] = useState(false)
  const onCalled = useCallback(() => {
    setCalledHere(true)
    void reload()
  }, [reload])
  const [newWorkspace, setNewWorkspace] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  // The row button whose click is switching the tab: busy until the page reloads into the workspace.
  const [switchingFor, setSwitchingFor] = useState<ResumeAction | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  // A row button clicked before the reload into this workspace: it carries on here, once.
  const [resume] = useState(() => peekResume(active?.id ?? null))
  useEffect(() => {
    if (resume) clearResume()
  }, [resume])
  // Picking a workspace makes it the app's active one (the page reloads into it), so its rows' buttons act on it.
  const switchTo = useCallback(
    (id: string) => {
      setSwitching(id)
      setSwitchError(null)
      switchToWorkspace(id, null).catch(e => {
        setSwitching(null)
        setSwitchError(e instanceof Error ? e.message : t('onboarding.agentSetup.error.switch'))
      })
    },
    [t],
  )
  // One click is enough: a row button for another workspace switches to it and carries on there after the reload.
  // The test call asks for the microphone inside this click, before the switch: the call after the reload then
  // finds it allowed, and a refusal is said here and switches nothing.
  const switchAndDo = useCallback(
    async (id: string, action: ResumeAction) => {
      setSwitchingFor(action)
      setSwitchError(null)
      if (action === 'test_call') {
        const blocked = await microphoneAllowed()
        if (blocked) {
          setSwitchingFor(null)
          setSwitchError(blocked)
          return
        }
      }
      saveResume(id, action)
      try {
        await switchToWorkspace(id, null)
      } catch (e) {
        clearResume()
        setSwitchingFor(null)
        setSwitchError(e instanceof Error ? e.message : t('onboarding.agentSetup.error.switch'))
      }
    },
    [t],
  )
  const { allDone } = state.progress
  const steps = withTestCallMade(state.progress.steps, calledHere)
  // The workspace the rows are about; its buttons work right here once it is the app's active workspace.
  const selected = state.progress.workspace ?? null
  const here = selected && active?.id === selected.id ? active : null
  const done = steps.filter(s => s.state === 'done').length
  return (
    <section
      className={cx('as-card', 'as-progress', fadeIn && 'ld-in')}
      aria-label={t('onboarding.agentSetup.progress.label')}
      aria-live="polite"
    >
      {change && !connected && !state.key ? null : (
        <div className="as-progress-head">
          {change ? null : allDone ? (
            <b>{t('onboarding.agentSetup.progress.allDone')}</b>
          ) : connected ? (
            <b>
              <span className="as-dot" aria-hidden /> {t('onboarding.agentSetup.progress.connected')}
            </b>
          ) : state.key ? (
            <b className="as-waiting">
              <Spinner /> {t('onboarding.agentSetup.progress.waiting')}
            </b>
          ) : (
            <b>{t('onboarding.agentSetup.progress.willSetUp')}</b>
          )}
          {!change && (
            <span className="as-small">{t('onboarding.agentSetup.progress.count', { done, total: steps.length })}</span>
          )}
        </div>
      )}
      {/* By part of the setup: the admin's own, the server's (once per install), then the picked workspace's. */}
      {stepsByGroup(steps).map(group => (
        <div key={group.id} className={cx('as-group', group.id === 'business' && 'as-group-ws')}>
          {group.id === 'business' && single ? (
            <WorkspaceHeading name={selected?.name ?? ''} />
          ) : group.id === 'business' ? (
            <WorkspacePicker
              workspaces={state.progress.workspaces ?? []}
              selectedId={selected?.id ?? null}
              busy={switching ?? (switchingFor && selected ? selected.id : null)}
              onPick={id => (id === NEW_WORKSPACE ? setNewWorkspace(true) : switchTo(id))}
              clients={partnerScope}
            />
          ) : (
            <h3 className="as-group-label" id={`as-group-${group.id}`}>
              {groupLabel(group, t)}
            </h3>
          )}
          <ul className="as-list" aria-labelledby={`as-group-${group.id}`}>
            {group.steps.map(step => (
              <Fragment key={step.id}>
                <li className={cx('as-item', step.state)}>
                  <span className="as-mark" aria-hidden>
                    {step.state === 'done' ? (
                      <MarkGlyph kind="works" size={12} />
                    ) : step.state === 'failing' ? (
                      <MarkGlyph kind="partly" size={12} />
                    ) : null}
                  </span>
                  <span className="as-item-label">
                    {step.id === 'activate'
                      ? t(
                          trial?.me.workspace?.activation?.trialDays === null
                            ? 'onboarding.steps.activatePlan'
                            : 'onboarding.steps.activate',
                        )
                      : step.label}
                    {step.hint && <span className="as-hint"> · {step.hint}</span>}
                  </span>
                  {step.state === 'failing' && (
                    <span className="as-small">{t('onboarding.agentSetup.progress.failing')}</span>
                  )}
                  <StepAction
                    step={step}
                    workspace={here}
                    onSwitch={selected && !here ? action => void switchAndDo(selected.id, action) : null}
                    switching={switchingFor ?? (switching ? 'workspace' : null)}
                    resume={here ? resume : null}
                    assistantName={selected?.assistantName ?? t('onboarding.agentSetup.yourAssistant')}
                    onCalled={onCalled}
                    reload={reload}
                    trial={trial}
                    onAddClient={partnerScope ? () => setNewWorkspace(true) : undefined}
                    activatePartnerId={partnerScope ? (partner?.id ?? null) : null}
                    onAddNumber={
                      partnerScope && selected
                        ? () => {
                            // The client workspace's Phone number page (Workspace settings), in that workspace.
                            if (here) window.location.hash = '#workspace/phone'
                            else void switchToWorkspace(selected.id, '#workspace/phone')
                          }
                        : undefined
                    }
                  />
                </li>
              </Fragment>
            ))}
          </ul>
        </div>
      ))}
      {switchError && <Note tone="danger">{switchError}</Note>}
      {newWorkspace && partnerScope && partner ? (
        <NewClient
          partner={partner}
          onClose={() => setNewWorkspace(false)}
          onFirstWorkspace={onFirstWorkspace}
          onMade={id => {
            setNewWorkspace(false)
            // The page shows the new client workspace's steps next: it becomes the tab's workspace.
            switchTo(id)
          }}
        />
      ) : newWorkspace ? (
        <NewWorkspaceDialog onClose={() => setNewWorkspace(false)} returnTo={AGENT_SETUP_HASH} />
      ) : null}
    </section>
  )
}

/** A group's heading: the server's from the steps' groups; the partner's in this page's language. */
function groupLabel(group: { id: string; label: string }, t: ReturnType<typeof useT>) {
  return group.id === 'partner' ? t('onboarding.agentSetup.partner.group') : group.label
}

/**
 * "Add client" on a partner owner's page: the partner area's New client dialog (a client workspace is a seat on the
 * partner bill, so only the owner adds one, never the agent). Waits for the partner to load first.
 */
function NewClient({
  partner,
  onClose,
  onFirstWorkspace,
  onMade,
}: {
  partner: MyPartner
  onClose: () => void
  onFirstWorkspace?: () => void
  onMade: (id: string) => void
}) {
  const data = useQuery(PARTNER_QUERY(partner.id), () => loadPartner(partner.id)).data
  if (!data) return null
  return (
    <NewClientDialog
      data={data}
      returnHash={PARTNER_AGENT_HASH}
      onFirstWorkspace={tabWorkspace() ? undefined : onFirstWorkspace}
      onOpen={id => onMade(id)}
      onInvite={onClose}
      onClose={onClose}
      onMade={workspace => onMade(workspace.id)}
    />
  )
}

/**
 * The workspace dropdown's items: each workspace the admin can set up with how far it got (or that there is none yet),
 * then "New workspace…".
 */
export function workspaceOptions(workspaces: readonly SetupWorkspaceSummary[], clients = false) {
  const { t } = i18n()
  return [
    ...(workspaces.length
      ? workspaces.map(w => ({
          value: w.id,
          label: w.name,
          description:
            w.done >= w.total
              ? t('onboarding.agentSetup.workspace.setUp')
              : t('onboarding.agentSetup.progress.count', { done: w.done, total: w.total }),
        }))
      : [
          {
            value: NO_WORKSPACE,
            label: t('onboarding.agentSetup.workspace.none'),
            description: t('onboarding.agentSetup.workspace.noneDescription'),
          },
        ]),
    clients
      ? {
          value: NEW_WORKSPACE,
          label: t('onboarding.agentSetup.partner.newClient'),
          description: t('onboarding.agentSetup.partner.newClientDescription'),
        }
      : {
          value: NEW_WORKSPACE,
          label: t('onboarding.agentSetup.workspace.new'),
          description: t('onboarding.agentSetup.workspace.newDescription'),
        },
  ]
}

/**
 * The heading of the workspace steps: which workspace they show. Lists every workspace the admin can set up (owner or
 * admin there) with how far it got, and "New workspace…". The server above is one; workspaces can be many.
 */
export function WorkspacePicker({
  workspaces,
  selectedId,
  busy,
  onPick,
  clients = false,
}: {
  workspaces: readonly SetupWorkspaceSummary[]
  selectedId: string | null
  /** The workspace being switched to: the dropdown waits for the page to reload into it. */
  busy: string | null
  onPick: (id: string) => void
  /** A partner owner's page: its client workspaces, and "New client workspace…". */
  clients?: boolean
}) {
  const t = useT()
  const options = workspaceOptions(workspaces, clients)
  return (
    <div className="as-ws-head" id="as-group-business">
      <span className="as-group-label">
        {t(clients ? 'onboarding.agentSetup.partner.client' : 'onboarding.agentSetup.workspace.label')}
      </span>
      <Select
        label={t('onboarding.agentSetup.workspace.select')}
        value={busy ?? selectedId ?? NO_WORKSPACE}
        options={options}
        disabled={Boolean(busy)}
        size="sm"
        onChange={onPick}
      />
      <HelpTip text={t('onboarding.agentSetup.workspace.help')} />
    </div>
  )
}

/** The heading of the workspace steps on a workspace owner's page: their one workspace, by name. */
export function WorkspaceHeading({ name }: { name: string }) {
  const t = useT()
  return (
    <div className="as-ws-head" id="as-group-business">
      <span className="as-group-label">{t('onboarding.agentSetup.workspace.label')}</span>
      <b className="as-ws-name">{name}</b>
    </div>
  )
}

/** The agent ended its own access at the end of the setup (setup_endAccess): when, in this browser's time. */
export function AgentEndedNote({ at }: { at: string }) {
  const t = useT()
  return (
    <span className="as-small" role="status">
      {t('onboarding.agentSetup.agentEnded', { when: dateTimeLabel(new Date(at)) })}
    </span>
  )
}

/** A test call answered here a moment ago: the step is done before the next read of the progress says so. */
export function withTestCallMade<S extends { id: string; state: string }>(
  steps: readonly S[],
  calledHere: boolean,
): S[] {
  return steps.map(s => (calledHere && s.id === 'test_call' ? { ...s, state: 'done' } : s))
}

/**
 * How the admin finishes a step on this page (never "do this in the app"): the call forwarding (the
 * agent can also run it) and the test call, always for the workspace shown. Steps the agent does have none.
 */
export function StepAction({
  step,
  workspace,
  onSwitch,
  switching = null,
  resume = null,
  assistantName,
  onCalled,
  reload,
  trial,
  onAddClient,
  onAddNumber,
  activatePartnerId = null,
}: {
  step: AgentSetupState['progress']['steps'][number]
  /** The workspace shown, when it is the app's active workspace in this tab: the buttons act in it right here. */
  workspace: SetupWorkspace | null
  /**
   * The workspace shown is not the active one (or this tab has none): its buttons make it active first, then carry on
   * with what was clicked (one click, resume-after-switch.ts).
   */
  onSwitch: ((action: ResumeAction) => void) | null
  /** A switch is under way: the button that started it is busy, the other one waits. */
  switching?: ResumeAction | 'workspace' | null
  /** Clicked before the reload into this workspace: start the call or open the dialog at once. */
  resume?: ResumeAction | null
  assistantName: string
  onCalled: () => void
  reload: () => Promise<void>
  /** Waiting for the trial: "Start free trial" on its row, once the agent's free steps are done (admin_only). */
  trial?: StartTrialProps
  /** A partner owner's page: "Add client" on the Client workspaces row (a seat on the bill: the owner's click). */
  onAddClient?: () => void
  /** A partner owner's page: "Add number" on a client workspace's Phone number row (it costs money). */
  onAddNumber?: () => void
  /** A partner owner's page: the partner whose "Activate White-label Cloud" row opens its Checkout. */
  activatePartnerId?: string | null
}) {
  const t = useT()
  if (step.id === 'plan' && activatePartnerId) {
    if (step.state !== 'admin_only') return null
    return (
      <span className="as-item-action">
        <SetupActivatePartner partnerId={activatePartnerId} />
      </span>
    )
  }
  if (step.id === 'clients' && onAddClient)
    return (
      <span className="as-item-action">
        <Button
          size="sm"
          variant="secondary"
          icon="plus"
          title={t('onboarding.agentSetup.partner.addClientTitle')}
          onClick={onAddClient}
        >
          {t('onboarding.agentSetup.partner.addClient')}
        </Button>
      </span>
    )
  if (step.id === 'phone' && onAddNumber && step.state === 'admin_only')
    return (
      <span className="as-item-action">
        <Button
          size="sm"
          variant="secondary"
          title={t('onboarding.agentSetup.partner.addNumberTitle')}
          onClick={onAddNumber}
        >
          {t('onboarding.agentSetup.partner.addNumber')}
        </Button>
      </span>
    )
  if (step.id === 'activate') {
    if (step.state !== 'admin_only' || !trial) return null
    return (
      <span className="as-item-action">
        <SetupStartTrial me={trial.me} onTermsChanged={trial.onTermsChanged} />
      </span>
    )
  }
  if (step.id === 'test_call') {
    // Also once done ("Call again"), so a call in progress keeps its panel when the row turns done.
    if (workspace)
      return (
        <span className="as-item-action">
          <SetupTestCall
            workspace={workspace}
            assistantName={assistantName}
            done={step.state === 'done'}
            onCalled={onCalled}
            autoStart={resume === 'test_call'}
          />
        </span>
      )
    if (step.state === 'done') return null
    if (onSwitch)
      return (
        <span className="as-item-action">
          <Button
            size="sm"
            variant="secondary"
            icon="phone-in"
            busy={switching === 'test_call'}
            disabled={Boolean(switching)}
            title={t('onboarding.agentSetup.step.callNowTitle')}
            onClick={() => onSwitch('test_call')}
          >
            {t('onboarding.agentSetup.step.callNow', { name: assistantName })}
          </Button>
        </span>
      )
    return <span className="as-small">{t('onboarding.agentSetup.step.onceWorkspaceExists')}</span>
  }
  if (step.id === 'forwarding' && step.state !== 'done') {
    if (workspace)
      return (
        <span className="as-item-action">
          <SetupForwarding workspace={workspace} onClosed={() => void reload()} autoOpen={resume === 'forwarding'} />
        </span>
      )
    if (onSwitch)
      return (
        <span className="as-item-action">
          <Button
            size="sm"
            variant="secondary"
            busy={switching === 'forwarding'}
            disabled={Boolean(switching)}
            title={t('onboarding.agentSetup.step.forwardingTitle')}
            onClick={() => onSwitch('forwarding')}
          >
            {t('onboarding.rowActions.forwarding')}
          </Button>
        </span>
      )
  }
  return null
}

/**
 * How to start the chosen agent with the link. Where one link opens the agent with the prompt filled in (`open`), that
 * button comes first and the command or prompt to copy waits behind a quiet "Or …" (opened on request). Elsewhere the
 * steps are the way: one command or link where the agent connects itself, the prompt to copy where pasting it is.
 */
export function StartAgent({
  client,
  url,
  scope = 'install',
  change,
}: {
  client: AgentClient
  url: string
  scope?: SetupScope
  /** Changing settings (AgentSetup's `change`): the prompt names what to change and reads it first. */
  change?: SetupChange
}) {
  const t = useT()
  const { open, otherWay, steps, prompt, promptFirst } = startPlan(client, url, scope, change)
  const promptToCopy = (primary: boolean) => (
    <>
      <pre className="as-prompt">{prompt}</pre>
      <div>
        <CopyButton
          text={prompt}
          label={t('onboarding.agentSetup.copyPrompt')}
          variant={primary ? 'primary' : 'secondary'}
        />
      </div>
    </>
  )
  // The first copy or link is the main action, unless the open link above already is.
  const lead = (i: number) => !open && i === 0
  const stepList = steps.map((step, i) => (
    <div key={step.text} className="as-step">
      <span>{step.text}</span>
      {step.code && (
        <div className="as-code">
          <code>{step.code}</code>
          <CopyButton text={step.code} variant={lead(i) ? 'primary' : 'secondary'} />
        </div>
      )}
      {step.link && (
        <div>
          <a className={cx('k-btn', 'k-btn-sm', lead(i) ? 'k-btn-primary' : 'k-btn-secondary')} href={step.link.href}>
            {step.link.label}
          </a>
        </div>
      )}
      {step.prompt && promptToCopy(false)}
    </div>
  ))
  if (!open)
    return (
      <>
        {stepList}
        {promptFirst && <div className="as-step">{promptToCopy(true)}</div>}
      </>
    )
  return (
    <div className="as-start">
      <div className="as-open">
        <a className="k-btn k-btn-primary k-btn-md" href={open.href}>
          {open.label}
        </a>
        <span className="as-small">{open.text}</span>
      </div>
      <details className="as-other-way">
        <summary>{otherWay}</summary>
        <div className="as-other-way-body">{stepList}</div>
      </details>
    </div>
  )
}

/**
 * On an install that is not on a public https address (installPlace): what does not work there, and the guide to
 * putting it on a server (docs/hosting.md). Nothing on a public install.
 */
export function HostingNote({ address }: { address: string }) {
  const t = useT()
  const place = installPlace(address)
  if (place === 'public') return null
  const local = place === 'this_computer'
  return (
    <Note
      tone="warning"
      title={t(local ? 'onboarding.agentSetup.hosting.localTitle' : 'onboarding.agentSetup.hosting.noHttpsTitle')}
    >
      {local
        ? t('onboarding.agentSetup.hosting.local', { brand: brandName() })
        : t('onboarding.agentSetup.hosting.noHttps')}{' '}
      <a
        href={local ? HOSTING_GUIDE_URL : `${HOSTING_GUIDE_URL}#your-own-domain`}
        target="_blank"
        rel="noreferrer"
        title={t('onboarding.agentSetup.hosting.guideTitle')}
      >
        {local ? t('onboarding.agentSetup.hosting.putOnServer') : t('onboarding.agentSetup.hosting.addHttps')}
      </a>
    </Note>
  )
}
