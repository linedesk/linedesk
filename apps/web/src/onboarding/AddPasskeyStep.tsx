// The admin's passkey as step 1 of every first-run setup page (the agent setup page, the setup by hand, the start
// page): only they can add it, on this device, so it comes before anything an agent or the walkthrough does. The same
// registration as Account › Sign-in & security (settings/account/add-passkey.ts), with its words and errors.
import { useState } from 'react'
import { passkeySupported } from '../auth.ts'
import { signInAgain as startSignInAgain } from '../localData.ts'
import { ConfirmWithPasskey, SignInAgain } from '../settings/account/account-api.ts'
import { passkeyAddCancelled, useAddPasskey } from '../settings/account/add-passkey.ts'
import { TextInput } from '../settings/fields.tsx'
import { HelpTip } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { Skeleton } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import type { PasskeyStep } from './agent-setup-passkey.ts'
import './agent-setup.css'

/** Where an "Add passkey" was clicked: step 1, or the passkey row of the progress. Its message shows there. */
type PasskeyPlace = 'step' | 'list'
type PasskeyProblemState = { text: string; cancelled: boolean; signInAgain: boolean; from: PasskeyPlace }

/**
 * Adding the admin's passkey on this page: the same registration as Account › Sign-in & security (add-passkey.ts),
 * with its device name, enrolment code and errors. `onAdded` shows it at once; after any failure the progress is read
 * again (a passkey added in another tab makes the step done).
 */
export function usePasskeyHere(onAdded: () => void, reload: () => Promise<void>) {
  const add = useAddPasskey()
  const [busy, setBusy] = useState<PasskeyPlace | null>(null)
  const [problem, setProblem] = useState<PasskeyProblemState | null>(null)
  // The code field shows only where it is needed and did not come with the setup (filled in), or a try failed; never
  // hidden again while it is typed in.
  const [codeFromSetup] = useState(() => Boolean(add.enrolmentCode))
  const [askCode, setAskCode] = useState(false)
  const run = async (from: PasskeyPlace) => {
    setBusy(from)
    setProblem(null)
    try {
      await add.addThisDevice()
      onAdded()
    } catch (e) {
      const cancelled = passkeyAddCancelled(e)
      if (!cancelled) setAskCode(true)
      setProblem({
        text: e instanceof Error ? e.message : String(e),
        cancelled,
        signInAgain: e instanceof SignInAgain && !(e instanceof ConfirmWithPasskey),
        from,
      })
      void reload()
    } finally {
      setBusy(null)
    }
  }
  return {
    supported: passkeySupported(),
    busy,
    problem,
    showCode: add.needsCode && (askCode || !codeFromSetup),
    code: add.enrolmentCode,
    setCode: add.setEnrolmentCode,
    run,
  }
}
export type PasskeyHere = ReturnType<typeof usePasskeyHere>

/** Step 1: add your passkey, or (once added) one done line with its mark. */
export function PasskeyFirstStep({ step, passkey }: { step: Exclude<PasskeyStep, 'none'>; passkey: PasskeyHere }) {
  if (step === 'loading')
    return (
      <li className="as-later" aria-busy="true" aria-label="Checking your passkey">
        <Skeleton className="as-skel" />
      </li>
    )
  if (step === 'done')
    return (
      <li className="as-passed">
        <StatusMark state="works" label="Done" className="as-passed-mark" />
        <span>Passkey added</span>
      </li>
    )
  return (
    <li>
      <b>Add your passkey</b>
      <div className="as-step">
        <span className="as-why">
          So only you can sign in to this server.
          <HelpTip text="A passkey is your fingerprint, face or device PIN. Email and sign-in decide who can sign in, so changing them needs your passkey, also when your agent does it. Your agent can’t add one for you: only you can, on your device. It can start without it meanwhile." />
        </span>
        {passkey.supported && passkey.showCode && (
          <div className="as-code-field">
            <TextInput
              label="Enrolment code"
              placeholder="Enrolment code"
              value={passkey.code}
              onChange={passkey.setCode}
            />
            <HelpTip text="Because you are a server admin, your first passkey needs a one-time code. The admin who made you a server admin has it." />
          </div>
        )}
        {passkey.supported ? (
          <div>
            <AddPasskeyButton passkey={passkey} from="step" />
          </div>
        ) : (
          <Note>
            This browser can’t add a passkey here. Your agent can start without it; try another browser, or add it later
            in <AccountSecurityLink />.
          </Note>
        )}
        <PasskeyProblem passkey={passkey} from="step" />
      </div>
    </li>
  )
}

export function AddPasskeyButton({ passkey, from, size }: { passkey: PasskeyHere; from: PasskeyPlace; size?: 'sm' }) {
  if (!passkey.supported) return null
  const busy = passkey.busy === from
  return (
    <Button
      variant={from === 'step' ? 'primary' : 'secondary'}
      size={size}
      disabled={passkey.busy !== null}
      onClick={() => void passkey.run(from)}
      title="Create a passkey on this device for your account"
    >
      {busy ? 'Waiting for your device…' : 'Add passkey'}
    </Button>
  )
}

/** Why the passkey was not added, where it was clicked: calm when the prompt was only closed, with a retry. */
export function PasskeyProblem({ passkey, from }: { passkey: PasskeyHere; from: PasskeyPlace }) {
  const { problem } = passkey
  if (!problem || problem.from !== from) return null
  return (
    <Note
      tone={problem.cancelled ? 'neutral' : 'danger'}
      className="as-passkey-note"
      action={
        <>
          {problem.signInAgain ? (
            <Button
              size="sm"
              onClick={() => void startSignInAgain()}
              title="Sign out and sign in again, then come back here"
            >
              Sign in again
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={passkey.busy !== null}
              onClick={() => void passkey.run(from)}
              title="Add your passkey again"
            >
              Try again
            </Button>
          )}
          <AccountSecurityLink />
        </>
      }
    >
      {problem.cancelled ? 'No passkey was added. You can try again whenever you are ready.' : problem.text}
    </Note>
  )
}

/** Account › Sign-in & security in a new tab, so the setup stays where it is (design principle 14). */
function AccountSecurityLink() {
  return (
    <a
      className="as-quiet-link"
      href="#account/security"
      target="_blank"
      rel="noreferrer"
      title="Your passkeys in Account › Sign-in & security, in a new tab"
    >
      Account › Security
    </a>
  )
}
