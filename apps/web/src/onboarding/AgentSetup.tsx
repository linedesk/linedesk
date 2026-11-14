// Agent-first setup (LIN-125): the first thing an instance admin sees while the install or their business is not set
// up. An AI agent (Claude Code, Claude, ChatGPT, Codex, Cursor, any MCP client) connects to the setup MCP with a
// setup key and does the setup with them; this page makes the key, says how to connect each agent, gives the prompt,
// and shows the agent's progress as it works. Setting up by hand stays one small link away.
// Step 1 is the admin's passkey (agent-setup-passkey.ts): only they can add it, on this device, so it comes first.
import {
  AGENT_SETUP_HASH,
  type AgentClient,
  type AgentSetupKeyCreated,
  type AgentSetupState,
  agentClientLabels,
  agentClients,
  allowKeyIdOf,
  cloudClients,
  HOSTING_GUIDE_URL,
  installPlace,
  startPlan,
  stepsByGroup,
} from '@linedesk/actions'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { loadAgentSetup, loadAgentSetupKey, runAdmin, watchAdminSignIn } from '../admin/api.ts'
import { SecondFactorPrompt } from '../admin/SecondFactorPrompt.tsx'
import type { AdminSecondFactor } from '../auth.ts'
import { brandName } from '../brand.ts'
import { SETUP_LINK_KEY } from '../localData.ts'
import { untilLabel } from '../time.ts'
import { HelpTip } from '../ui/HelpTip.tsx'
import { BrandMark, Button, cx, Icon, Note, Spinner } from '../ui/kit.tsx'
import {
  AddPasskeyButton,
  PasskeyFirstStep,
  type PasskeyHere,
  PasskeyProblem,
  usePasskeyHere,
} from './AddPasskeyStep.tsx'
import { AgentPicker } from './AgentPicker.tsx'
import { AllowDialog, AllowedNote, AllowRequestNote, useAllow } from './AllowEmailAndSignIn.tsx'
import { installPartsMissing, passkeyStepOf, withPasskeyAdded } from './agent-setup-passkey.ts'
import { CopyButton } from './Frame.tsx'
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

/**
 * The address of the setup page (#setup-agent): opened from Admin › Overview, or after choosing the manual way. The
 * agent's link adds `?allow=<keyId>` when it needs email and sign-in: Allow is offered only for that key.
 */
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
}

export function AgentSetup({ onManual, onDone, onWorkspaceReady }: Props) {
  const [state, setState] = useState<AgentSetupState | null>(null)
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
  const [busy, setBusy] = useState<'create' | 'end' | 'withdraw' | null>(null)
  // The key the agent's link asks to allow (#setup-agent?allow=<keyId>), followed as the address changes.
  const [allowKeyId, setAllowKeyId] = useState(() => allowKeyIdOf(window.location.hash))
  useEffect(() => {
    const follow = () => setAllowKeyId(allowKeyIdOf(window.location.hash))
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  // Opened from the agent's Allow link: the key alone is read first (the progress takes longer), so the dialog opens
  // as soon as the key is known.
  const [quickKey, setQuickKey] = useState<AgentSetupState['key'] | undefined>(undefined)
  useEffect(() => {
    if (!allowKeyIdOf(window.location.hash)) return
    loadAgentSetupKey()
      .then(s => setQuickKey(s.key))
      .catch(() => {}) // the full read says what failed
  }, [])
  const [error, setError] = useState<string | null>(null)
  // The admin sign-in ran out (1 hour, 12 with a passkey): the page turns into the sign-in, never an error line.
  const [signInAgain, setSignInAgain] = useState<AdminSecondFactor | null>(null)
  useEffect(() => watchAdminSignIn(setSignInAgain), [])

  const load = useCallback(async () => {
    try {
      const asked = Date.now()
      const next = await loadAgentSetup()
      if (asked < stateAskedAt.current) return // an older answer that arrived late
      stateAskedAt.current = asked
      setState(next)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not read the setup state')
    }
  }, [])
  // An Allow link opened in this tab already: read again at once, so the dialog names what the agent just asked for.
  useEffect(() => {
    if (allowKeyId) void load()
  }, [allowKeyId, load])
  // The agent works in another window: show its progress as it goes (only while this tab is visible).
  useEffect(() => {
    void load()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  // Step 1, the admin's passkey: added here, it shows as done at once; the next read of the progress agrees.
  const [passkeyAddedHere, setPasskeyAddedHere] = useState(false)
  const passkeyStep = passkeyStepOf(state, passkeyAddedHere)
  const passkey = usePasskeyHere(
    useCallback(() => {
      setPasskeyAddedHere(true)
      void load()
    }, [load]),
    load,
  )
  const linkFirst = passkeyStep === 'none' || passkeyStep === 'done'

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
  // Email and sign-in need the admin's passkey, for the agent too: the agent's link (#setup-agent?allow=<keyId>) opens
  // the dialog at once; Allow asks for the passkey, then lets that link (and only that one) do them.
  const [allowedHere, setAllowedHere] = useState<string | null>(null)
  const [allowDialog, setAllowDialog] = useState<'auto' | 'open' | 'closed'>('auto')
  const allow = useAllow(until => {
    setAllowDialog('closed')
    setAllowedHere(until ?? new Date().toISOString())
    // The link's request is answered: a reload or Withdraw later does not open the dialog again.
    if (allowKeyIdOf(window.location.hash)) window.history.replaceState(null, '', AGENT_SETUP_HASH)
    setAllowKeyId(null)
    void load()
  })
  // Lowering the link's rights needs no passkey.
  const withdrawEmailAndSignIn = async () => {
    setBusy('withdraw')
    setError(null)
    try {
      await runAdmin('agentSetup.withdrawPasskey', {})
      setAllowedHere(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not withdraw it')
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

  const connected = Boolean(state?.key?.lastUsedAt)
  // One setup link at a time: while one is active the page offers only to end it, otherwise only to create one.
  // The link ended elsewhere (expired, replaced in another browser, agent access ended): it goes from the page too.
  useEffect(() => {
    if (!state || !created || stateAskedAt.current < linkSetAt.current) return
    if (state.key?.prefix !== created.prefix || !unexpired(created)) setCreated(null)
  }, [state, created, setCreated])
  const hasLink = state ? Boolean(state.key) : Boolean(created)
  // The agent's link names the working key, which may not do email and sign-in yet: ask (dialog, then the note).
  const keyNow = state ? state.key : quickKey
  const allowAsked = keyNow && allowKeyId === keyNow.id && !keyNow.emailAndSignIn && !allowedHere ? keyNow : null
  const cloudBlocked = state !== null && !state.reachableFromCloud && cloudClients.includes(client)
  // After signing in, the page loads again at the same address (SecondFactorPrompt).
  if (signInAgain) return <SecondFactorPrompt state={signInAgain} onExit={onDone} />
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
            business and its number. <b>About 10 minutes.</b> You create the accounts; it asks before anything that
            costs money.
          </p>
        </div>

        {state && <HostingNote address={state.mcpUrl} />}

        <section className="as-card" aria-label="Your agent">
          <ol className="as-steps">
            {passkeyStep !== 'none' && <PasskeyFirstStep step={passkeyStep} passkey={passkey} />}
            <li className={cx(!linkFirst && 'as-later')}>
              <b className="as-step-title">
                Give your agent a setup link
                <HelpTip
                  label="About the setup link"
                  text="It lets your agent set up this server for you, using setup tools only. For security, the link stops working after 24 hours. You can end it here at any time."
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
                      {created
                        ? `Ready, valid until ${timeOf(created.expiresAt)}. It lets an agent act as you, so keep it to yourself.`
                        : `Your agent has a setup link (${state?.key?.prefix}…), valid until ${timeOf(state?.key?.expiresAt ?? '')}.`}
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
                  {state?.key &&
                    (allowAsked ? (
                      <AllowRequestNote linkKey={allowAsked} onOpen={() => setAllowDialog('open')} />
                    ) : (
                      <EmailAndSignIn
                        linkKey={state.key}
                        allowedHere={allowedHere}
                        busy={busy}
                        onWithdraw={() => void withdrawEmailAndSignIn()}
                      />
                    ))}
                  {created ? (
                    <StartAgent client={client} url={created.url} />
                  ) : (
                    <span className="as-small">
                      This link was created in another browser and is shown only there. To start an agent here, end
                      access and create a new link.
                    </span>
                  )}
                </>
              ) : (
                <div className="as-step">
                  <div>
                    <Button
                      variant={linkFirst ? 'primary' : 'secondary'}
                      busy={busy === 'create'}
                      onClick={() => void createKey()}
                    >
                      Create a setup link
                    </Button>
                  </div>
                </div>
              )}
            </li>
          </ol>
          {state && allowKeyId && state.key?.id !== allowKeyId && (
            <Note tone="warning" title="Nothing to allow">
              The link you opened asks to allow a setup link that ended or is not yours. If your agent needs email and
              sign-in, ask it for a new link.
            </Note>
          )}
          {error && <Note tone="danger">{error}</Note>}
        </section>
        {allowAsked && allowDialog !== 'closed' && (
          <AllowDialog
            linkKey={allowAsked}
            allow={allow}
            passkeyMissing={passkeyStep === 'todo'}
            onClose={() => setAllowDialog('closed')}
          />
        )}

        <Progress
          state={
            state && {
              ...state,
              progress: { ...state.progress, steps: withPasskeyAdded(state.progress.steps, passkeyAddedHere) },
            }
          }
          loadError={loadError}
          connected={connected}
          onDone={onDone}
          passkey={passkey}
        />

        <div className="as-foot">
          <button type="button" className="as-manual" onClick={manual} title="Go through the setup steps yourself">
            Set up by hand instead
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Whether the working link may change email and sign-in, when the agent's link does not ask for it right now
 * (AllowRequestNote): while a passkey confirmation lasts, until when, with Withdraw; a moment after Allow, said as the
 * result. Otherwise how it works: the agent gives a link to allow it when it needs it.
 */
function EmailAndSignIn({
  linkKey,
  allowedHere,
  busy,
  onWithdraw,
}: {
  linkKey: NonNullable<AgentSetupState['key']>
  /** Allowed on this page a moment ago: until when (the server's answer, before the next read agrees). */
  allowedHere: string | null
  busy: string | null
  onWithdraw: () => void
}) {
  const until = linkKey.emailAndSignInUntil ?? allowedHere
  if (until)
    return (
      <AllowedNote until={until} justNow={Boolean(allowedHere)} busy={busy === 'withdraw'} onWithdraw={onWithdraw} />
    )
  if (linkKey.emailAndSignIn) return null
  return (
    <div className="as-link">
      <span className="as-small">
        Email and sign-in decide who can sign in, so your agent needs your passkey for them. When it does, it gives you
        a link to allow it here.
      </span>
    </div>
  )
}

const timeOf = (iso: string) => untilLabel(new Date(iso))

/** What the agent has set up so far, live. */
function Progress({
  state,
  loadError,
  connected,
  onDone,
  passkey,
}: {
  state: AgentSetupState | null
  loadError: string | null
  connected: boolean
  onDone: () => void
  passkey: PasskeyHere
}) {
  if (!state) return loadError ? <Note tone="danger">{loadError}</Note> : null
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
      {/* By part of the setup: the admin's own, the server's (once per install), the first business. */}
      {stepsByGroup(steps).map(group => (
        <div key={group.id} className="as-group">
          <h3 className="as-group-label" id={`as-group-${group.id}`}>
            {group.label}
          </h3>
          {group.id === 'business' && <FirstWorkspace others={state.progress.otherWorkspaces ?? []} />}
          <ul className="as-list" aria-labelledby={`as-group-${group.id}`}>
            {group.steps.map(step => (
              <Fragment key={step.id}>
                <li className={cx('as-item', step.state)}>
                  <span className="as-mark" aria-hidden>
                    {step.state === 'done' ? <Icon name="check" size={12} /> : step.state === 'failing' ? '!' : null}
                  </span>
                  <span>
                    {step.label}
                    {step.hint && <span className="as-hint"> · {step.hint}</span>}
                  </span>
                  {step.state === 'failing' && <span className="as-small">failing</span>}
                  {step.id === 'passkey' && step.state !== 'done' ? (
                    <span className="as-item-action">
                      <AddPasskeyButton passkey={passkey} from="list" size="sm" />
                    </span>
                  ) : (
                    step.state === 'admin_only' && <span className="as-small">do this in the app</span>
                  )}
                </li>
                {step.id === 'passkey' && step.state !== 'done' && <PasskeyProblem passkey={passkey} from="list" />}
              </Fragment>
            ))}
          </ul>
        </div>
      ))}
      {/* Before the agent has created the business there is no workspace to open: the button would bring back this page. */}
      {(allDone || connected) && steps.some(s => s.id === 'workspace' && s.state === 'done') && (
        <div>
          <Button variant={allDone ? 'primary' : 'secondary'} onClick={onDone}>
            {allDone ? `Open ${brandName()}` : `Open ${brandName()} now`}
          </Button>
        </div>
      )}
    </section>
  )
}

/** One command or link per agent where it can connect itself (it carries the prompt); the prompt to copy where pasting it is the way in. */
function StartAgent({ client, url }: { client: AgentClient; url: string }) {
  const { steps, prompt, promptFirst } = startPlan(client, url)
  const promptBlock = (
    <div className="as-step">
      <pre className="as-prompt">{prompt}</pre>
      <div>
        <CopyButton text={prompt} label="Copy prompt" variant={promptFirst ? 'primary' : 'secondary'} />
      </div>
    </div>
  )
  return (
    <>
      {steps.map((step, i) => (
        <div key={step.text} className="as-step">
          <span>{step.text}</span>
          {step.code && (
            <div className="as-code">
              <code>{step.code}</code>
              <CopyButton text={step.code} variant={i === 0 ? 'primary' : undefined} />
            </div>
          )}
          {step.link && (
            <div>
              <a
                className={cx('k-btn', 'k-btn-sm', i === 0 ? 'k-btn-primary' : 'k-btn-secondary')}
                href={step.link.href}
              >
                {step.link.label}
              </a>
            </div>
          )}
        </div>
      ))}
      {promptFirst && promptBlock}
    </>
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

/**
 * Under "Your business": the steps are for the first workspace; more (one per business or location) come later, and
 * the ones there already are named.
 */
function FirstWorkspace({ others }: { others: readonly string[] }) {
  return (
    <p className="as-small as-group-note">
      {others.length > 0
        ? `For your first workspace. Also set up: ${others.join(', ')}.`
        : 'Your first workspace. You can add more later, one per business or location.'}
      <HelpTip text="A workspace is one business or location, with its own assistant, phone number, calls and team. Your agent sets up the first one with you; add the others afterwards from the workspace menu (New workspace), and each one opens its own setup." />
    </p>
  )
}
