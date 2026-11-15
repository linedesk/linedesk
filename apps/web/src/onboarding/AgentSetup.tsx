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
import {
  AGENT_SETUP_HASH,
  type AgentClient,
  type AgentSetupKeyCreated,
  type AgentSetupState,
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
import type { AdminSecondFactor } from '../auth.ts'
import { brandName } from '../brand.ts'
import { useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { SETUP_LINK_KEY, signInAgain as signOutAndSignIn } from '../localData.ts'
import { callAction } from '../settings/settings-api.ts'
import { dateTimeLabel, untilLabel } from '../time.ts'
import { HelpTip } from '../ui/HelpTip.tsx'
import { LoadProblem, Skeleton, SkeletonChecklist, SkeletonPart, useLoading } from '../ui/LoadStates.tsx'
import { BrandMark, Button, cx, Icon, Note, Spinner } from '../ui/kit.tsx'
import { MarkGlyph } from '../ui/StatusMark.tsx'
import { AgentPicker } from './AgentPicker.tsx'
import { installPartsMissing } from './agent-setup-passkey.ts'
import { NewWorkspaceDialog } from '../shell/NewWorkspace.tsx'
import { microphoneAllowed } from '../call/microphone.ts'
import { switchToWorkspace } from '../shell/invitations.ts'
import { Select } from '../ui/controls.tsx'
import { CopyButton } from './Frame.tsx'
import { openInstallSetup } from './InstallSetup.tsx'
import { clearResume, peekResume, type ResumeAction, saveResume } from './resume-after-switch.ts'
import { type SetupWorkspace, SetupForwarding, SetupTestCall } from './SetupRowActions.tsx'
import { rememberManual } from './setup-choice.ts'
import { loadWorkspaceAgentSetup } from './workspace-agent-setup.ts'
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
export const setupLinkSlot = (scope: SetupScope, workspaceId: string | null) =>
  scope === 'workspace' ? `${SETUP_LINK_KEY}.workspace.${workspaceId ?? 'none'}` : SETUP_LINK_KEY
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
}

export function AgentSetup({ onManual, onDone, onWorkspaceReady, active, scope = 'install', change, onLater }: Props) {
  const t = useT()
  const owner = scope === 'workspace'
  const [state, setState] = useState<AgentSetupState | null>(null)
  const activeId = active?.id ?? null
  const [loadError, setLoadError] = useState<string | null>(null)
  const slot = setupLinkSlot(scope, owner ? activeId : null)
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
  useEffect(() => (owner ? undefined : watchAdminSignIn(setSignInAgain)), [owner])
  // Shift+Esc finishes later, as in the business onboarding (onboarding/Frame.tsx).
  const laterRef = useRef(onLater)
  laterRef.current = onLater
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !e.shiftKey || e.isComposing || !laterRef.current) return
      e.preventDefault()
      laterRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const load = useCallback(async () => {
    try {
      const asked = Date.now()
      const next = owner ? await loadWorkspaceAgentSetup() : await loadAgentSetup(activeId)
      if (asked < stateAskedAt.current) return // an older answer that arrived late
      stateAskedAt.current = asked
      setState(next)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t('onboarding.agentSetup.error.read'))
    }
  }, [activeId, owner, t])
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
        owner
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
      if (owner) await callAction('agentSetup.revokeWorkspace')
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
    // The owner's choice is kept by the page around this one (setup-choice.ts, per workspace).
    if (owner) return onManual(false)
    rememberManual(true)
    onManual(state ? installPartsMissing(state.progress.steps) : false)
  }
  // Everything is set up: the page offers to change it, with the agent or the install walkthrough (opens at its
  // first part, nothing saved is reset; off on Cloud, where Server admin › Providers is the way by hand).
  const allDone = state?.progress.allDone ?? false
  const install = useQuery(owner ? null : ADMIN_INSTALL_SETUP, () => loadInstallSetup()).data
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
  // After signing in, the page loads again at the same address (SecondFactorPrompt).
  if (signInAgain) return <SecondFactorPrompt state={signInAgain} onExit={onDone} />
  return (
    <div
      className="ob as"
      role="main"
      aria-label={t('onboarding.agentSetup.ariaLabel', { brand: brandName() })}
      aria-busy={skeleton || undefined}
    >
      {skeleton && (
        <span className="sr-only" role="status">
          {t('onboarding.agentSetup.loading')}
        </span>
      )}
      <div className="ob-top">
        <BrandMark />
        <b>{brandName()}</b>
        <span className="ob-count">{t('onboarding.agentSetup.setup')}</span>
        {onLater && (
          <Button size="sm" variant="ghost" onClick={onLater} title={t('onboarding.frame.finishLaterTitle')}>
            {t('onboarding.frame.finishLater')}
          </Button>
        )}
      </div>
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
        {!owner && <HostingNote address={state?.mcpUrl ?? `${globalThis.location?.origin ?? ''}/mcp/setup`} />}

        <section className="as-card" aria-label={t('onboarding.agentSetup.yourAgent')}>
          <ol className="as-steps">
            <li>
              <b className="as-step-title">
                {t('onboarding.agentSetup.link.title')}
                <HelpTip
                  label={t('onboarding.agentSetup.link.helpLabel')}
                  text={t(owner ? 'onboarding.agentSetup.owner.linkHelp' : 'onboarding.agentSetup.link.help', {
                    hours: SETUP_KEY_HOURS,
                  })}
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
                    brand: brandName(),
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
                    <Button variant="primary" busy={busy === 'create'} onClick={() => void createKey()}>
                      {t('onboarding.agentSetup.link.create')}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          </ol>
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
              {t('onboarding.agentSetup.owner.signInFirst.text')}
            </Note>
          )}
          {error && <Note tone="danger">{error}</Note>}
        </section>

        {state ? (
          <Progress
            state={state}
            connected={connected}
            onDone={onDone}
            active={active ?? null}
            reload={load}
            fadeIn={view.fadeIn}
            single={owner}
          />
        ) : skeleton ? (
          <ProgressSkeleton reserved={reserved} single={owner} />
        ) : (
          <LoadProblem
            what={t('onboarding.agentSetup.progressWhat')}
            message={loadError ?? undefined}
            onRetry={() => void load()}
          />
        )}

        <div className="as-foot">
          {skeleton ? (
            <SkeletonPart reserved={reserved}>
              <Skeleton shape="text" width={132} />
            </SkeletonPart>
          ) : change ? (
            <button
              type="button"
              className="as-manual"
              onClick={() => onManual(false)}
              title={t('onboarding.agentSetup.change.backTitle')}
            >
              {t('onboarding.agentSetup.change.back')}
            </button>
          ) : allDone && owner ? null : allDone ? (
            <button
              type="button"
              className="as-manual"
              onClick={stepByStep}
              title={t('onboarding.agentSetup.stepByStepTitle')}
            >
              {t('onboarding.agentSetup.stepByStep')}
            </button>
          ) : (
            <button type="button" className="as-manual" onClick={manual} title={t('onboarding.agentSetup.manualTitle')}>
              {t('onboarding.agentSetup.manual')}
            </button>
          )}
        </div>
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
  server: ['answering', 'telephony', 'email', 'call-audio'],
  business: ['business', 'assistant', 'pickup', 'notify', 'phone', 'forwarding', 'test_call'],
}
const SKELETON_ACTIONS: Record<string, number> = { forwarding: 124, test_call: 132 }

/** A step's row width: its name (13px) and, after " · ", its hint (12px), about as long as the words. */
export function stepSkeletonRow(id: string): { label: number; action?: number } {
  const name = setupStepNames[id] ?? { label: id }
  const label = Math.round(name.label.length * 7 + (name.hint ? 12 + name.hint.length * 6 : 0))
  return SKELETON_ACTIONS[id] ? { label, action: SKELETON_ACTIONS[id] } : { label }
}

/** The setup checklist while its first state is read: its card, head, group headings, dropdown and rows. */
export function ProgressSkeleton({ reserved, single = false }: { reserved: boolean; single?: boolean }) {
  const t = useT()
  // A workspace owner's page: the workspace's part only.
  const groups = single ? setupStepGroups.filter(g => g.id === 'business') : setupStepGroups
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
              <h3 className="as-group-label">{group.label}</h3>
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
  onDone,
  active,
  reload,
  fadeIn,
  single = false,
}: {
  state: AgentSetupState
  connected: boolean
  onDone: () => void
  active: SetupWorkspace | null
  reload: () => Promise<void>
  /** The state just arrived after the skeleton: the card fades in. */
  fadeIn: boolean
  /** A workspace owner's page: one workspace, named, with no dropdown (no switching, no new workspace). */
  single?: boolean
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
      <div className="as-progress-head">
        {allDone ? (
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
        <span className="as-small">{t('onboarding.agentSetup.progress.count', { done, total: steps.length })}</span>
      </div>
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
            />
          ) : (
            <h3 className="as-group-label" id={`as-group-${group.id}`}>
              {group.label}
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
                    {step.label}
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
                  />
                </li>
              </Fragment>
            ))}
          </ul>
        </div>
      ))}
      {switchError && <Note tone="danger">{switchError}</Note>}
      {/* Before the agent has created the business there is no workspace to open: the button would bring back this page. */}
      {(allDone || connected) && Boolean(state.progress.workspace) && (
        <div>
          <Button variant={allDone ? 'primary' : 'secondary'} onClick={onDone}>
            {allDone
              ? t('onboarding.agentSetup.open', { brand: brandName() })
              : t('onboarding.agentSetup.openNow', { brand: brandName() })}
          </Button>
        </div>
      )}
      {newWorkspace && <NewWorkspaceDialog onClose={() => setNewWorkspace(false)} returnTo={AGENT_SETUP_HASH} />}
    </section>
  )
}

/**
 * The workspace dropdown's items: each workspace the admin can set up with how far it got (or that there is none yet),
 * then "New workspace…".
 */
export function workspaceOptions(workspaces: readonly SetupWorkspaceSummary[]) {
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
    {
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
}: {
  workspaces: readonly SetupWorkspaceSummary[]
  selectedId: string | null
  /** The workspace being switched to: the dropdown waits for the page to reload into it. */
  busy: string | null
  onPick: (id: string) => void
}) {
  const t = useT()
  const options = workspaceOptions(workspaces)
  return (
    <div className="as-ws-head" id="as-group-business">
      <span className="as-group-label">{t('onboarding.agentSetup.workspace.label')}</span>
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
}) {
  const t = useT()
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
            variant="primary"
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
