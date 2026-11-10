// Onboarding, from the first sign-in to the first answered call. Progress lives on the workspace
// (`onboarding.setStep`), so a reload resumes at the same step.
import { useEffect, useState } from 'react'
import type { Me, OnboardingState } from '../auth.ts'
import { callHash } from '../shell/useRoute.ts'
import { useAssistantName, useRejection, useRows, useRun } from '../store.tsx'
import { BusinessStep } from './BusinessStep.tsx'
import { Foot, Frame, useStepKeys } from './Frame.tsx'
import { formatNumber, nextStep, previousStep, type OnboardingStep } from './flow.ts'
import { PhoneStep } from './PhoneStep.tsx'
import { TestCallStep } from './TestCallStep.tsx'
import './onboarding.css'

export function Onboarding({ me, state, onDone }: { me: Me; state: OnboardingState; onDone: () => void }) {
  const run = useRun()
  const [step, setStep] = useState<OnboardingStep>(state.step)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [otherError, setOtherError] = useState<string | null>(null)
  const hasNumber = useRows('phone_numbers').length > 0

  const { rejection, clearRejection } = useRejection()
  useEffect(() => {
    if (!rejection) return
    if (rejection.action === 'phoneNumber.setup') setSetupError(rejection.error)
    else setOtherError(`Could not ${rejection.action}: ${rejection.error}`)
    clearRejection()
  }, [rejection, clearRejection])

  function go(to: OnboardingStep) {
    setStep(to)
    setOtherError(null)
    void run('onboarding.setStep', { step: to })
  }
  const back = () => { const to = previousStep(step); if (to) go(to) }
  // Without a number there is nothing to call: the phone step's skip goes straight to the end.
  const forward = () => go(step === 'phone' && !hasNumber ? 'done' : nextStep(step))
  function skip() {
    void run('onboarding.setStep', { step: 'skipped' })
    onDone()
  }
  function openCall(callId: string) {
    void run('onboarding.setStep', { step: 'done' })
    window.history.replaceState(null, '', callHash(callId))
    onDone()
  }

  return (
    <Frame step={step} complete={step === 'done' || (step === 'phone' && hasNumber)} onSkip={step === 'done' ? undefined : skip}>
      {step === 'business' && <BusinessStep businessName={me.workspace!.name} onNext={forward} />}
      {step === 'phone' && <PhoneStep status={state.phone} setupError={setupError} clearError={() => setSetupError(null)} onBack={back} onNext={forward} />}
      {step === 'test_call' && <TestCallStep showSimulator={import.meta.env.DEV || state.phone.provider === 'dev'} onBack={back} onNext={forward} onOpenCall={openCall} />}
      {step === 'done' && <Done onBack={back} onDone={onDone} />}
      {otherError && <p className="ob-error" role="alert">{otherError}</p>}
    </Frame>
  )
}

function Done({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const name = useAssistantName()
  const number = useRows('phone_numbers')[0]
  useStepKeys({ onEnter: onDone, onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <h1>{number ? "You're live." : "You're set up."}</h1>
        <p className="ob-lede">
          {number
            ? `${name} answers ${formatNumber(number.e164)}. Every call lands in your inbox with a summary and the next step.`
            : `${name} starts answering once a number is connected. Calls then land in your inbox.`}
        </p>
      </div>
      <Foot onBack={onBack} onContinue={onDone} canContinue label="Open my calls" />
    </>
  )
}
