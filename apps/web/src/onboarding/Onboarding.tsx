// Onboarding, from the first sign-in to the first answered call. Progress lives on the workspace
// (`onboarding.setStep`), so a reload resumes at the same step.
import { formatStarCount, offersSampleCalls, offersTour, STAR_REPO_URL } from '@linedesk/actions'
import { useEffect, useRef, useState } from 'react'
import { AdminMode } from '../admin/AdminMode.tsx'
import type { Me, OnboardingState } from '../auth.ts'
import { brandName, useBrand } from '../brand.ts'
import { ConfirmEmail } from '../ConfirmEmail.tsx'
import { preloadWorkspaceSettings, useWriteAction } from '../settings/settings-api.ts'
import { usePresence } from '../shell/presence.ts'
import { rejectionReason } from '../shell/rejections.ts'
import { queueTour } from '../shell/tour.ts'
import { useAssistantName, useRejection, useRows, useRun } from '../store.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import { AssistantStep } from './AssistantStep.tsx'
import { BusinessStep } from './BusinessStep.tsx'
import { Foot, Frame, useStepKeys } from './Frame.tsx'
import {
  doneState,
  mobileErrorText,
  NO_PICKUP_MEMORY,
  nextStep,
  type OnboardingStep,
  type PickupMemory,
  phoneSetupErrorText,
  previousStep,
  rejectionStep,
  stepLabels,
  stepSaves,
  URGENT_CONTACT_ID,
} from './flow.ts'
import { NotifyStep } from './NotifyStep.tsx'
import { InstanceSetupNotice, isInstanceAdmin, useHash } from './InstanceSetup.tsx'
import { PhoneStep } from './PhoneStep.tsx'
import { PickupStep } from './PickupStep.tsx'
import './onboarding.css'

type Props = {
  me: Me
  state: OnboardingState
  onDone: () => void
  /** The business step renamed the workspace. */
  onRenamed: (name: string) => void
}

/** An instance admin can open Admin from here (the setup checklist) and come back to the same step. */
export function Onboarding(props: Props) {
  const hash = useHash()
  if (isInstanceAdmin(props.me) && hash.startsWith('#admin'))
    return (
      <AdminMode
        currentUserId={props.me.actorId}
        onExit={() => {
          window.location.hash = ''
        }}
      />
    )
  return <OnboardingFlow {...props} />
}

function OnboardingFlow({ me, state, onDone, onRenamed }: Props) {
  const run = useRun()
  const firstUse = me.firstUse ?? 'off'
  // Leaving onboarding: the tour (where the install offers it) starts in the inbox.
  const finish = () => {
    if (offersTour(firstUse)) queueTour(me.workspace!.id)
    onDone()
  }
  const [step, setStep] = useState<OnboardingStep>(state.step)
  // The tour is queued as soon as the last step shows: a reload there opens the inbox (onboarding is
  // done on the server), and the tour must still start there.
  const workspaceId = me.workspace!.id
  useEffect(() => {
    if (step === 'done' && offersTour(firstUse)) queueTour(workspaceId)
  }, [step, firstUse, workspaceId])
  // The pick-up step shows the saved choice and hours: loaded now, so they are there when it opens.
  useEffect(() => {
    void preloadWorkspaceSettings()
  }, [])
  // The address was confirmed here: `me` is from the page load and still says otherwise.
  const [confirmed, setConfirmed] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  // Saves the steps queued and moved on from, refused later: each names its step and stays until dismissed or that
  // step is saved again (Continue there). One per step: a newer refusal replaces an older one of the same step.
  const [saveErrors, setSaveErrors] = useState<SaveError[]>([])
  // The step the owner last moved on from: where a refusal that doesn't say otherwise was queued.
  const left = useRef<OnboardingStep | null>(null)
  // What the pick-up step changed this session (hours it turned on, the forwarding a number had before).
  const [pickupMemory, setPickupMemory] = useState<PickupMemory>(NO_PICKUP_MEMORY)
  const hasNumber = useRows('phone_numbers').length > 0

  const { rejection, clearRejection } = useRejection()
  useEffect(() => {
    if (!rejection) return
    if (rejection.action === 'phoneNumber.setup') setSetupError(phoneSetupErrorText(rejection.error))
    else {
      const from = rejectionStep(rejection.action, rejection.input, left.current)
      const error: SaveError = {
        step: from,
        text: saveErrorText(from, rejection.action, rejection.input, rejection.error),
      }
      setSaveErrors(all => [...all.filter(e => e.step !== from), error])
    }
    clearRejection()
  }, [rejection, clearRejection])

  function go(to: OnboardingStep) {
    setStep(to)
    void run('onboarding.setStep', { step: to })
  }
  const back = () => {
    const to = previousStep(step)
    if (to) go(to)
  }
  // Continue saves the step again: its old refusal goes.
  const forward = () => {
    left.current = step
    setSaveErrors(all => all.filter(e => e.step !== step))
    go(nextStep(step))
  }
  function skip() {
    void run('onboarding.setStep', { step: 'skipped' })
    finish()
  }

  return (
    <Frame
      step={step}
      complete={step === 'done' || (step === 'phone' && hasNumber)}
      onSkip={step === 'done' ? undefined : skip}
    >
      <SaveErrors
        errors={saveErrors}
        step={step}
        onOpen={go}
        onDismiss={e => setSaveErrors(all => all.filter(x => x !== e))}
      />
      {me.emailUnconfirmed && !confirmed && (
        <ConfirmEmail
          onDone={() => setConfirmed(true)}
          why="We email you a code to confirm your address. Setting up a phone number, a carrier, API keys, webhooks and invitations waits for it."
        />
      )}
      {isInstanceAdmin(me) && <InstanceSetupNotice />}
      {step === 'business' && (
        <BusinessStep
          businessName={me.workspace!.name}
          lookup={!!state.businessLookup}
          websiteImport={state.websiteImport}
          admin={me.permissions.includes('instance:admin')}
          onRenamed={onRenamed}
          onNext={forward}
        />
      )}
      {step === 'assistant' && (
        <AssistantStep
          onBack={back}
          onNext={forward}
          operator={me.permissions.includes('instance:admin') || Boolean(me.adminSecondFactor)}
        />
      )}
      {step === 'pickup' && (
        <PickupStep onBack={back} onNext={forward} memory={pickupMemory} onMemory={setPickupMemory} />
      )}
      {step === 'notify' && (
        <NotifyStep
          actorId={me.actorId}
          emailConfirmed={!me.emailUnconfirmed || confirmed}
          admin={me.permissions.includes('instance:admin')}
          onBack={back}
          onNext={forward}
        />
      )}
      {step === 'phone' && (
        <PhoneStep
          status={state.phone}
          setupError={setupError}
          clearError={() => setSetupError(null)}
          admin={me.permissions.includes('instance:admin')}
          oldForwarding={pickupMemory.oldForwarding}
          onBack={back}
          onNext={forward}
        />
      )}
      {step === 'done' && (
        <Done
          onBack={back}
          onDone={finish}
          offerSamples={offersSampleCalls(firstUse)}
          admin={me.permissions.includes('instance:admin')}
        />
      )}
    </Frame>
  )
}

/** A save the server refused after its step was left; `step` null: not about one step (setup progress). */
type SaveError = { step: OnboardingStep | null; text: string }

/** "Couldn't save your business details: reason." The step's own words for its refusals (the mobile), else the shared ones. */
function saveErrorText(step: OnboardingStep | null, action: string, input: unknown, error: string): string {
  const what = step ? stepSaves[step] : 'your setup progress'
  if (step === 'notify' && action === 'assistant.update') {
    const transfers = (input as { transfers?: { id: string; name: string }[] }).transfers ?? []
    const name = transfers.find(c => c.id === URGENT_CONTACT_ID)?.name ?? ''
    const own = mobileErrorText(error, name)
    if (own !== error) return `Couldn't save ${what}: ${own}`
  }
  return `Couldn't save ${what}: ${rejectionReason(error)}`
}

/** The one place save errors show, above the step: what failed, a way back to that step, and Dismiss. */
function SaveErrors({
  errors,
  step,
  onOpen,
  onDismiss,
}: {
  errors: SaveError[]
  step: OnboardingStep
  onOpen: (step: OnboardingStep) => void
  onDismiss: (error: SaveError) => void
}) {
  if (!errors.length) return null
  return (
    <div className="ob-save-errors">
      {errors.map(e => (
        <div key={e.step ?? 'progress'} className="ob-error ob-save-error" role="alert">
          <span>{e.text}</span>
          <span className="ob2-row">
            {e.step && e.step !== step && (
              <Button size="sm" onClick={() => onOpen(e.step!)} title="Open that step to fix it">
                Back to {stepLabels[e.step]}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onDismiss(e)}>
              Dismiss
            </Button>
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * The end of onboarding: a quiet word that the product is open source, why a star helps and a thank-you, unless an
 * admin turned the star prompt off.
 */
function StarLine() {
  const { starPrompt, starCount } = useBrand()
  if (!starPrompt) return null
  return (
    <p className="ob-star">
      {brandName()} is open source. A star on GitHub helps other businesses find it and keeps us building. We're really
      grateful for every one{' '}
      <span className="ob-star-heart" aria-hidden="true">
        ♥
      </span>{' '}
      <a href={STAR_REPO_URL} target="_blank" rel="noreferrer">
        Star it on GitHub
      </a>
      {starCount !== null && (
        <span className="ob-star-count">
          <Icon name="star" size={12} />
          {formatStarCount(starCount)}
        </span>
      )}
    </p>
  )
}

/** "You're live" only when calls are really answered; otherwise what is left, with the way to it. */
function Done({
  onBack,
  onDone,
  offerSamples,
  admin,
}: {
  onBack: () => void
  onDone: () => void
  offerSamples: boolean
  admin: boolean
}) {
  const name = useAssistantName()
  const number = useRows('phone_numbers')[0] ?? null
  const presence = usePresence()
  useStepKeys({ onEnter: onDone, onEscape: onBack })
  const write = useWriteAction()
  const hasCalls = useRows('calls').length > 0
  const [adding, setAdding] = useState(false)
  const [sampleError, setSampleError] = useState<string | null>(null)
  const state = doneState({
    number,
    // Not set up, or set up but failing (a used-up quota, LIN-111): either way calls are not answered.
    voiceMissing: presence.kind === 'notAnswering' && presence.reason !== 'number',
    // LIN-85 (#488): read from the go-live checklist's state once it is on main.
    forwardingVerified: false,
    admin,
    assistant: name,
  })
  // Sample calls land in the inbox at once (the answer carries the rows), then the inbox opens.
  async function trySamples() {
    setAdding(true)
    setSampleError(null)
    try {
      await write('sample.add', {})
      window.history.replaceState(null, '', '#calls')
      onDone()
    } catch (e) {
      setSampleError(`Couldn't add the sample calls: ${rejectionReason((e as Error).message)}`)
      setAdding(false)
    }
  }
  // The same places the go-live checklist leads to.
  const open = (href: string) => {
    window.history.replaceState(null, '', href)
    onDone()
  }
  return (
    <>
      <div className="ob-body">
        <h1>{state.title}</h1>
        <p className="ob-lede">{state.lede}</p>
        {state.left.length > 0 && (
          <ul className="ob-left">
            {state.left.map(l => (
              <li key={l.label}>
                {l.href ? (
                  <button type="button" className="ob-link" onClick={() => open(l.href!)}>
                    {l.label}
                  </button>
                ) : (
                  l.label
                )}
              </li>
            ))}
          </ul>
        )}
        {offerSamples && !hasCalls && (
          <p className="ob2-row ob-tight">
            {offerSamples && !hasCalls && (
              <Button
                size="sm"
                icon="spark"
                busy={adding}
                onClick={() => void trySamples()}
                title="Fill the inbox with example calls you can remove in one click"
              >
                Try with sample calls
              </Button>
            )}
          </p>
        )}
        {sampleError && (
          <p className="ob-error" role="alert">
            {sampleError}
          </p>
        )}
        <StarLine />
      </div>
      <Foot onBack={onBack} onContinue={onDone} canContinue label="Open my calls" />
    </>
  )
}
