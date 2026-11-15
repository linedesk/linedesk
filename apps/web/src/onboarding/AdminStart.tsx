// The start page (#start) of an instance admin without a workspace who chose the way by hand before (NoWorkspace.tsx):
// still AI agent first (the agent setup page, behind Server admin's passkey check); setting up by hand stays the clear, secondary alternative below: naming the business here, or
// the server's parts first when they are not set up (as AgentSetup's "Set up by hand instead").
import type { AgentSetupState } from '@linedesk/actions'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { loadAgentSetup } from '../admin/api.ts'
import { brandName } from '../brand.ts'
import { CreateWorkspace, LostWorkspace } from '../CreateWorkspace.tsx'
import { signOutAndForget } from '../localData.ts'
import { AuthPage, Button } from '../ui/kit.tsx'
import { openAgentSetup } from './AgentSetup.tsx'
import { installPartsMissing } from './agent-setup-passkey.ts'

type Props = {
  onDone: () => void
  lostWorkspace: string | null
  /** The admin chose the way by hand before: that part shows open; the agent still comes first. */
  byHandFirst: boolean
  /** The server's parts are not set up: by hand starts with them (the install walkthrough). */
  onInstallByHand: () => void
  /** Invitations and Open Server admin. */
  children?: ReactNode
}

export function AdminStart({ onDone, lostWorkspace, byHandFirst, onInstallByHand, children }: Props) {
  const [state, setState] = useState<AgentSetupState | null>(null)
  const load = useCallback(async () => {
    try {
      setState(await loadAgentSetup())
    } catch {
      // Without it (no passkey check yet): by hand opens the business form (the walkthrough is in Admin too).
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const [byHand, setByHand] = useState(byHandFirst)
  const installFirst = state ? installPartsMissing(state.progress.steps) : false

  return (
    <AuthPage>
      <div className="auth-card as-start">
        {lostWorkspace && <LostWorkspace name={lostWorkspace} />}
        <h1>Set up {brandName()}</h1>
        <section className="as-card">
          <ol className="as-steps">
            <li>
              <b>Set up with your AI agent</b>
              <span className="as-small">
                Your agent does the setup with you: the AI, a phone carrier, email, your business and its number. About
                10 minutes.
              </span>
              <div>
                <Button
                  variant="primary"
                  onClick={openAgentSetup}
                  title="Let Claude, ChatGPT or another agent set up this server with you"
                >
                  Set up with an AI agent
                </Button>
              </div>
            </li>
          </ol>
        </section>
        {byHand ? (
          installFirst ? (
            <div className="as-byhand">
              <h2 className="as-byhand-title">Or set up by hand</h2>
              <p>The server’s parts come first: email, answering calls, phone carrier and call audio.</p>
              <div>
                <Button onClick={onInstallByHand} title="Go through the server’s setup steps yourself">
                  Set up the server by hand
                </Button>
              </div>
            </div>
          ) : (
            <div className="as-byhand">
              <h2 className="as-byhand-title">Or set up by hand</h2>
              <CreateWorkspace onDone={onDone} embedded />
            </div>
          )
        ) : (
          <button
            type="button"
            className="as-manual as-manual-center"
            onClick={() => setByHand(true)}
            title="Go through the setup steps yourself"
          >
            Set up by hand instead
          </button>
        )}
        {children}
        <button type="button" className="auth-switch" onClick={() => void signOutAndForget().then(onDone)}>
          Use a different account
        </button>
      </div>
    </AuthPage>
  )
}
