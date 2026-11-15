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
  type SetupWorkspaceSummary,
  setupStepGroups,
  setupStepNames,
  startPlan,
  stepsByGroup,
} from '@linedesk/actions'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { loadAgentSetup, loadInstallSetup, runAdmin, watchAdminSignIn } from '../admin/api.ts'
import { ADMIN_INSTALL_SETUP } from '../admin/Providers.tsx'
import { SecondFactorPrompt } from '../admin/SecondFactorPrompt.tsx'
import type { AdminSecondFactor } from '../auth.ts'
import { brandName } from '../brand.ts'
import { useQuery } from '../cachedQuery.ts'
import { SETUP_LINK_KEY } from '../localData.ts'
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

/** The address of the setup page (#setup-agent): opened from Admin › Overview, or after choosing the manual way. */
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
 * In memory too, for private windows without storage.
 */
let shownKey: AgentSetupKeyCreated | null = null
const unexpired = (link: AgentSetupKeyCreated | null) => (link && Date.parse(link.expiresAt) > Date.now() ? link : null)
function stillShown(): AgentSetupKeyCreated | null {
  if (unexpired(shownKey)) return shownKey
  try {
    const saved = unexpired(JSON.parse(localStorage.getItem(SETUP_LINK_KEY) ?? 'null') as AgentSetupKeyCreated | null)
    if (!saved) localStorage.removeItem(SETUP_LINK_KEY)
    return saved
  } catch {
    return null
  }
}
function keepShown(link: AgentSetupKeyCreated | null) {
  shownKey = link
  try {
    if (link) localStorage.setItem(SETUP_LINK_KEY, JSON.stringify(link))
    else localStorage.removeItem(SETUP_LINK_KEY)
  } catch {
    // Private windows: the link lasts while this page is open.
  }
}

type Props = {
  /**
   * Set up by hand. `installFirst`: the install is not set up yet, so the setup checklist (Admin › Overview) comes
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
}

export function AgentSetup({ onManual, onDone, onWorkspaceReady, active }: Props) {
  const [state, setState] = useState<AgentSetupState | null>(null)
  const activeId = active?.id ?? null
  const [loadError, setLoadError] = useState<string | null>(null)
  const [created, setShown] = useState<AgentSetupKeyCreated | null>(stillShown)
  // When the link on the page was set (0: kept from before), and when the shown state was asked for: only a state
  // asked for after the link was set can say it ended.
  const linkSetAt = useRef(0)
  const stateAskedAt = useRef(0)
  const setCreated = useCallback((key: AgentSetupKeyCreated | null) => {
    keepShown(key)
    linkSetAt.current = Date.now()
    setShown(key)
  }, [])

  const [client, setClient] = useState<AgentClient>(savedClient)
  const [busy, setBusy] = useState<'create' | 'end' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The passkey check ran out (12 hours): the page turns into the passkey prompt, never an error line.
  const [signInAgain, setSignInAgain] = useState<AdminSecondFactor | null>(null)
  useEffect(() => watchAdminSignIn(setSignInAgain), [])

  const load = useCallback(async () => {
    try {
      const asked = Date.now()
      const next = await loadAgentSetup(activeId)
      if (asked < stateAskedAt.current) return // an older answer that arrived late
      stateAskedAt.current = asked
      setState(next)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not read the setup state')
    }
  }, [activeId])
  // The agent works in another window: show its progress as it goes (only while this tab is visible).
  useEffect(() => {
    void load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const workspaceReady = state?.progress.steps.some(s => s.id === 'workspace' && s.state === 'done') ?? false
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
    try {
      setCreated((await runAdmin('agentSetup.createKey', {})) as AgentSetupKeyCreated)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a setup link')
    } finally {
      setBusy(null)
    }
  }
  const endAccess = async () => {
    setBusy('end')
    setError(null)
    try {
      await runAdmin('agentSetup.revoke', {})
      setCreated(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not end agent access')
    } finally {
      setBusy(null)
    }
  }
  const manual = () => {
    rememberManual(true)
    onManual(state ? installPartsMissing(state.progress.steps) : false)
  }
  // Everything is set up: the page offers to change it, with the agent or the install walkthrough (opens at its
  // first part, nothing saved is reset; off on Cloud, where Server admin › Providers is the way by hand).
  const allDone = state?.progress.allDone ?? false
  const install = useQuery(ADMIN_INSTALL_SETUP, () => loadInstallSetup()).data
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
      aria-label={`Set up ${brandName()} with an AI agent`}
      aria-busy={skeleton || undefined}
    >
      {skeleton && (
        <span className="sr-only" role="status">
          Loading the setup
        </span>
      )}
      <div className="ob-top">
        <BrandMark />
        <b>{brandName()}</b>
        <span className="ob-count">Setup</span>
      </div>
      <div className="ob-main as-main">
        <div className={cx('ob-body', view.fadeIn && 'ld-in')}>
          <span className="as-kicker">
            <Icon name="spark" size={14} /> Recommended
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
          ) : allDone ? (
            <>
              <h1>Change {brandName()} with your AI agent</h1>
              <p className="ob-lede">Everything is set up. Want to change something? Give your agent a new link.</p>
            </>
          ) : (
            <>
              <h1>Set up {brandName()} with your AI agent</h1>
              <p className="ob-lede">
                Your agent connects to this server and does the whole setup with you: the AI, a phone carrier, email,
                your business and its number. <b>About 10 minutes.</b> You create the accounts; it asks before anything
                that costs money.
              </p>
            </>
          )}
        </div>

        {/* Before the state is read, this page's own address stands for the server's: the note shows at once. */}
        <HostingNote address={state?.mcpUrl ?? `${globalThis.location?.origin ?? ''}/mcp/setup`} />

        <section className="as-card" aria-label="Your agent">
          <ol className="as-steps">
            <li>
              <b className="as-step-title">
                Give your agent a setup link
                <HelpTip
                  label="About the setup link"
                  text={`It lets your agent set up this server for you, using setup tools only, email and sign-in included. For security, the link stops working after ${SETUP_KEY_HOURS} hours. You can end it here at any time.`}
                />
              </b>
              <AgentPicker client={client} onPick={pick} />
              {cloudBlocked && (
                <Note tone="warning" title={`${agentClientLabels[client]} can’t reach this server`}>
                  {agentClientLabels[client]} runs in the cloud and can only reach a public https address. This server
                  is at {state?.mcpUrl.replace(/\/mcp\/setup$/, '')}: use Claude Code, Codex or Cursor on this computer,
                  or open {brandName()} on its public address.
                </Note>
              )}
              {hasLink ? (
                <>
                  <div className="as-link">
                    <span className="as-small">
                      Ready, valid until {timeOf(created?.expiresAt ?? state?.key?.expiresAt ?? '')}.
                    </span>
                    <Button
                      size="sm"
                      busy={busy === 'end'}
                      onClick={() => void endAccess()}
                      title="The setup link stops working at once"
                    >
                      End access
                    </Button>
                  </div>
                  {created ? (
                    <StartAgent client={client} url={created.url} />
                  ) : (
                    <span className="as-small">
                      This link was created in another browser and is shown only there. To start an agent here, end
                      access and create a new link.
                    </span>
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
                      Create a setup link
                    </Button>
                  </div>
                </div>
              )}
            </li>
          </ol>
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
          />
        ) : skeleton ? (
          <ProgressSkeleton reserved={reserved} />
        ) : (
          <LoadProblem what="The setup progress" message={loadError ?? undefined} onRetry={() => void load()} />
        )}

        <div className="as-foot">
          {skeleton ? (
            <SkeletonPart reserved={reserved}>
              <Skeleton shape="text" width={132} />
            </SkeletonPart>
          ) : allDone ? (
            <button
              type="button"
              className="as-manual"
              onClick={stepByStep}
              title="Go through the server’s setup steps yourself; what is set up stays"
            >
              Step by step
            </button>
          ) : (
            <button type="button" className="as-manual" onClick={manual} title="Go through the setup steps yourself">
              Set up by hand instead
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
  business: ['workspace', 'business', 'assistant', 'pickup', 'notify', 'phone', 'forwarding', 'test_call'],
}
const SKELETON_ACTIONS: Record<string, number> = { forwarding: 124, test_call: 132 }

/** A step's row width: its name (13px) and, after " · ", its hint (12px), about as long as the words. */
export function stepSkeletonRow(id: string): { label: number; action?: number } {
  const name = setupStepNames[id] ?? { label: id }
  const label = Math.round(name.label.length * 7 + (name.hint ? 12 + name.hint.length * 6 : 0))
  return SKELETON_ACTIONS[id] ? { label, action: SKELETON_ACTIONS[id] } : { label }
}

/** The setup checklist while its first state is read: its card, head, group headings, dropdown and rows. */
export function ProgressSkeleton({ reserved }: { reserved: boolean }) {
  return (
    <section className="as-card as-progress" aria-label="Setup progress">
      <SkeletonPart reserved={reserved}>
        <div className="as-progress-head">
          <Skeleton shape="text" width={176} />
          <Skeleton shape="text" width={72} />
        </div>
        {setupStepGroups.map(group => (
          <div key={group.id} className={cx('as-group', group.id === 'business' && 'as-group-ws')}>
            {group.id === 'business' ? (
              <div className="as-ws-head">
                <span className="as-group-label">Workspace</span>
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
}: {
  state: AgentSetupState
  connected: boolean
  onDone: () => void
  active: SetupWorkspace | null
  reload: () => Promise<void>
  /** The state just arrived after the skeleton: the card fades in. */
  fadeIn: boolean
}) {
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
  const switchTo = useCallback((id: string) => {
    setSwitching(id)
    setSwitchError(null)
    switchToWorkspace(id, null).catch(e => {
      setSwitching(null)
      setSwitchError(e instanceof Error ? e.message : 'Could not switch the workspace')
    })
  }, [])
  // One click is enough: a row button for another workspace switches to it and carries on there after the reload.
  // The test call asks for the microphone inside this click, before the switch: the call after the reload then
  // finds it allowed, and a refusal is said here and switches nothing.
  const switchAndDo = useCallback(async (id: string, action: ResumeAction) => {
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
      setSwitchError(e instanceof Error ? e.message : 'Could not switch the workspace')
    }
  }, [])
  const { allDone } = state.progress
  const steps = withTestCallMade(state.progress.steps, calledHere)
  // The workspace the rows are about; its buttons work right here once it is the app's active workspace.
  const selected = state.progress.workspace ?? null
  const here = selected && active?.id === selected.id ? active : null
  const done = steps.filter(s => s.state === 'done').length
  return (
    <section className={cx('as-card', 'as-progress', fadeIn && 'ld-in')} aria-label="Setup progress" aria-live="polite">
      <div className="as-progress-head">
        {allDone ? (
          <b>Everything is set up</b>
        ) : connected ? (
          <b>
            <span className="as-dot" aria-hidden /> Your agent is connected
          </b>
        ) : state.key ? (
          <b className="as-waiting">
            <Spinner /> Waiting for your agent
          </b>
        ) : (
          <b>What your agent will set up</b>
        )}
        <span className="as-small">
          {done} of {steps.length} done
        </span>
      </div>
      {/* By part of the setup: the admin's own, the server's (once per install), then the picked workspace's. */}
      {stepsByGroup(steps).map(group => (
        <div key={group.id} className={cx('as-group', group.id === 'business' && 'as-group-ws')}>
          {group.id === 'business' ? (
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
                  {step.state === 'failing' && <span className="as-small">failing</span>}
                  <StepAction
                    step={step}
                    workspace={here}
                    onSwitch={selected && !here ? action => void switchAndDo(selected.id, action) : null}
                    switching={switchingFor ?? (switching ? 'workspace' : null)}
                    resume={here ? resume : null}
                    assistantName={selected?.assistantName ?? 'your assistant'}
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
      {(allDone || connected) && steps.some(s => s.id === 'workspace' && s.state === 'done') && (
        <div>
          <Button variant={allDone ? 'primary' : 'secondary'} onClick={onDone}>
            {allDone ? `Open ${brandName()}` : `Open ${brandName()} now`}
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
  return [
    ...(workspaces.length
      ? workspaces.map(w => ({
          value: w.id,
          label: w.name,
          description: w.done >= w.total ? 'Set up' : `${w.done} of ${w.total} done`,
        }))
      : [{ value: NO_WORKSPACE, label: 'No workspace yet', description: 'Your agent creates it, or add one here' }]),
    { value: NEW_WORKSPACE, label: 'New workspace…', description: 'Another business or location' },
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
  const options = workspaceOptions(workspaces)
  return (
    <div className="as-ws-head" id="as-group-business">
      <span className="as-group-label">Workspace</span>
      <Select
        label="Workspace whose steps are shown"
        value={busy ?? selectedId ?? NO_WORKSPACE}
        options={options}
        disabled={Boolean(busy)}
        size="sm"
        onChange={onPick}
      />
      <HelpTip text="This server is set up once. A workspace is one business or location, with its own assistant, phone number, calls and team; you can have several. Pick one to see its steps and finish them here." />
    </div>
  )
}

/** The agent ended its own access at the end of the setup (setup_endAccess): when, in this browser's time. */
export function AgentEndedNote({ at }: { at: string }) {
  return (
    <span className="as-small" role="status">
      Your agent ended its access at {dateTimeLabel(new Date(at))}. Create a new link any time to let it in again.
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
            title="Opens this workspace in this tab, then calls"
            onClick={() => onSwitch('test_call')}
          >
            Call {assistantName} now
          </Button>
        </span>
      )
    return <span className="as-small">here, once the workspace exists</span>
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
            title="Opens this workspace in this tab, then its forwarding settings"
            onClick={() => onSwitch('forwarding')}
          >
            Set up forwarding
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
export function StartAgent({ client, url }: { client: AgentClient; url: string }) {
  const { open, otherWay, steps, prompt, promptFirst } = startPlan(client, url)
  const promptToCopy = (primary: boolean) => (
    <>
      <pre className="as-prompt">{prompt}</pre>
      <div>
        <CopyButton text={prompt} label="Copy prompt" variant={primary ? 'primary' : 'secondary'} />
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
  const place = installPlace(address)
  if (place === 'public') return null
  const local = place === 'this_computer'
  return (
    <Note tone="warning" title={local ? 'Real phone calls can’t reach this copy' : 'This server has no https address'}>
      {local
        ? `${brandName()} is running on this computer. You can set it up and try it here, but callers can only reach it on a server with a public address.`
        : 'Browsers block the microphone for test calls, and Claude or ChatGPT on the web cannot connect.'}{' '}
      <a
        href={local ? HOSTING_GUIDE_URL : `${HOSTING_GUIDE_URL}#your-own-domain`}
        target="_blank"
        rel="noreferrer"
        title="How to put it on a server: providers, one-command install, ports"
      >
        {local ? 'Put it on a server' : 'Add an https address'}
      </a>
    </Note>
  )
}
