// Agent-first setup (LIN-125): the first thing an instance admin sees while the install or their business is not set
// up. An AI agent (Claude Code, Claude, ChatGPT, Codex, Cursor, any MCP client) connects to the setup MCP with a
// setup key and does the setup with them; this page makes the key, says how to connect each agent, gives the prompt,
// and shows the agent's progress as it works. Setting up by hand stays one small link away.
import {
  type AgentClient,
  type AgentSetupKeyCreated,
  type AgentSetupState,
  agentClientLabels,
  agentClients,
  agentSetupPrompt,
  cloudClients,
  connectSteps,
} from '@linedesk/actions'
import { useCallback, useEffect, useRef, useState } from 'react'
import { loadAgentSetup, runAdmin } from '../admin/api.ts'
import { brandName } from '../brand.ts'
import { BrandMark, Button, cx, Icon, Spinner } from '../ui/kit.tsx'
import { CopyButton } from './Frame.tsx'
import './agent-setup.css'

const MANUAL_KEY = 'linedesk.setup.manual'
const CLIENT_KEY = 'linedesk.setup.client'

/** Whether this admin chose to set up by hand (per browser; the setup page comes back with #setup-agent). */
export function choseManualSetup(): boolean {
  try {
    return localStorage.getItem(MANUAL_KEY) === '1'
  } catch {
    return false
  }
}
function rememberManual(on: boolean) {
  try {
    if (on) localStorage.setItem(MANUAL_KEY, '1')
    else localStorage.removeItem(MANUAL_KEY)
  } catch {
    // Private windows: the choice lasts this page only.
  }
}
function savedClient(): AgentClient {
  try {
    const saved = localStorage.getItem(CLIENT_KEY)
    return (agentClients as readonly string[]).includes(saved ?? '') ? (saved as AgentClient) : 'claude_code'
  } catch {
    return 'claude_code'
  }
}

/** The address of the setup page: opened from Admin › Overview, or after choosing the manual way. */
export const AGENT_SETUP_HASH = '#setup-agent'
export const openAgentSetup = () => {
  rememberManual(false)
  window.location.hash = AGENT_SETUP_HASH
}

const POLL_MS = 3000
/** The install's own steps (setup-mcp.ts): by hand, they are done in Admin › Overview, the setup checklist. */
const INSTALL_STEPS = ['ai', 'telephony', 'email', 'livekit']

/**
 * The setup link made in this page, kept in memory (never in storage) while the page is open: the key is shown once,
 * and the page is mounted again when the agent creates the workspace (the session moves on from "no workspace").
 */
let shownKey: AgentSetupKeyCreated | null = null
const stillShown = () => (shownKey && Date.parse(shownKey.expiresAt) > Date.now() ? shownKey : null)

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
}

export function AgentSetup({ onManual, onDone, onWorkspaceReady }: Props) {
  const [state, setState] = useState<AgentSetupState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [created, setShown] = useState<AgentSetupKeyCreated | null>(stillShown)
  const setCreated = (key: AgentSetupKeyCreated | null) => {
    shownKey = key
    setShown(key)
  }
  const [client, setClient] = useState<AgentClient>(savedClient)
  const [busy, setBusy] = useState<'create' | 'end' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await loadAgentSetup())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not read the setup state')
    }
  }, [])
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
      setError(e instanceof Error ? e.message : 'Could not make a setup link')
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
    onManual(state?.progress.steps.some(s => INSTALL_STEPS.includes(s.id) && s.state !== 'done') ?? false)
  }

  const connected = Boolean(state?.key?.lastUsedAt)
  const cloudBlocked = state !== null && !state.reachableFromCloud && cloudClients.includes(client)
  return (
    <div className="ob as" role="main" aria-label={`Set up ${brandName()} with an AI agent`}>
      <div className="ob-top">
        <BrandMark />
        <b>{brandName()}</b>
        <span className="ob-count">Setup</span>
      </div>
      <div className="ob-main as-main">
        <div className="ob-body">
          <span className="as-kicker">
            <Icon name="spark" size={14} /> Recommended
          </span>
          <h1>Set up {brandName()} with your AI agent</h1>
          <p className="ob-lede">
            Your agent connects to this server and does the whole setup with you: the AI, a phone carrier, email, your
            business and its number. About 15 minutes. You create the accounts; it asks before anything that costs
            money.
          </p>
        </div>

        <section className="as-card" aria-label="Your agent">
          <div className="as-agents" role="radiogroup" aria-label="Which agent">
            {agentClients.map(id => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={client === id}
                className={cx('as-agent', client === id && 'on')}
                onClick={() => pick(id)}
                title={`Show the steps for ${agentClientLabels[id]}`}
              >
                {agentClientLabels[id]}
                {id === 'claude_code' && <span className="as-tag">Best</span>}
              </button>
            ))}
          </div>
          {client === 'claude_code' && (
            <p className="as-why">
              Claude Code can also run commands on this server, so it can check and fix the install itself.
            </p>
          )}
          {cloudBlocked && (
            <p className="as-note" role="note">
              {agentClientLabels[client]} runs in the cloud and can only reach a public https address. This server is at{' '}
              {state?.mcpUrl.replace(/\/mcp\/setup$/, '')}: use Claude Code, Codex or Cursor on this computer, or open{' '}
              {brandName()} on its public address.
            </p>
          )}

          <ol className="as-steps">
            <li>
              <b>Connect your agent</b>
              {created ? (
                connectSteps(client, created.url).map(step => (
                  <div key={step.text} className="as-step">
                    <span>{step.text}</span>
                    {step.code && (
                      <div className="as-code">
                        <code>{step.code}</code>
                        <CopyButton text={step.code} />
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="as-step">
                  <span>
                    A setup link lets your agent set up this server as you, with setup tools only, for 24 hours. You can
                    end it here at any time.
                  </span>
                  <div>
                    <Button variant="primary" busy={busy === 'create'} onClick={() => void createKey()}>
                      {state?.key ? 'Make a new setup link' : 'Make a setup link'}
                    </Button>
                  </div>
                  {state?.key && (
                    <span className="as-small">
                      Your agent has a link ({state.key.prefix}…, until {timeOf(state.key.expiresAt)}). A new one ends
                      it.
                    </span>
                  )}
                </div>
              )}
            </li>
            <li className={cx(!created && 'as-later')}>
              <b>Paste this prompt</b>
              {created ? (
                <div className="as-step">
                  <pre className="as-prompt">{agentSetupPrompt(created.url)}</pre>
                  <div>
                    <CopyButton text={agentSetupPrompt(created.url)} label="Copy prompt" variant="primary" />
                  </div>
                </div>
              ) : (
                <span className="as-small">After you make the setup link.</span>
              )}
            </li>
          </ol>
          {error && (
            <p className="ob-error" role="alert">
              {error}
            </p>
          )}
        </section>

        <Progress state={state} loadError={loadError} connected={connected} onDone={onDone} />

        <div className="as-foot">
          <button type="button" className="as-manual" onClick={manual} title="Go through the setup steps yourself">
            Set up by hand instead
          </button>
          {state?.key && (
            <button
              type="button"
              className="as-manual"
              onClick={() => void endAccess()}
              disabled={busy === 'end'}
              title="The setup link stops working at once"
            >
              End agent access
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const timeOf = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

/** What the agent has set up so far, live. */
function Progress({
  state,
  loadError,
  connected,
  onDone,
}: {
  state: AgentSetupState | null
  loadError: string | null
  connected: boolean
  onDone: () => void
}) {
  if (!state) return loadError ? <p className="ob-error">{loadError}</p> : null
  const { steps, allDone } = state.progress
  const done = steps.filter(s => s.state === 'done').length
  return (
    <section className="as-card as-progress" aria-label="Setup progress" aria-live="polite">
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
      <ul className="as-list">
        {steps.map(step => (
          <li key={step.id} className={cx('as-item', step.state)}>
            <span className="as-mark" aria-hidden>
              {step.state === 'done' ? <Icon name="check" size={12} /> : step.state === 'failing' ? '!' : null}
            </span>
            <span>{step.label}</span>
            {step.state === 'failing' && <span className="as-small">failing</span>}
            {step.state === 'admin_only' && <span className="as-small">you, in the app</span>}
          </li>
        ))}
      </ul>
      {(allDone || connected) && (
        <div>
          <Button variant={allDone ? 'primary' : 'secondary'} onClick={onDone}>
            {allDone ? `Open ${brandName()}` : `Look at ${brandName()} now`}
          </Button>
        </div>
      )}
    </section>
  )
}
