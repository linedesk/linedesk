// Onboarding, from the first sign-in to the first answered call. Progress lives on the workspace
// (`onboarding.setStep`), so a reload resumes at the same step.
import { useEffect, useState } from 'react'
import type { Me, OnboardingState } from '../auth.ts'
import { usePresence } from '../shell/presence.ts'
import { rejectionText } from '../shell/rejections.ts'
import { callHash } from '../shell/useRoute.ts'
import { useAssistantName, useRejection, useRows, useRun } from '../store.tsx'
import { Button } from '../ui/kit.tsx'
import { BusinessStep } from './BusinessStep.tsx'
import { Foot, Frame, useStepKeys } from './Frame.tsx'
import { formatNumber, nextStep, phoneSetupErrorText, previousStep, type OnboardingStep } from './flow.ts'
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
    if (rejection.action === 'phoneNumber.setup') setSetupError(phoneSetupErrorText(rejection.error))
    else setOtherError(rejectionText(rejection.action, rejection.error))
    clearRejection()
  }, [rejection, clearRejection])

  function go(to: OnboardingStep) {
    setStep(to)
    setOtherError(null)
    void run('onboarding.setStep', { step: to })
  }
  const back = () => {
    const to = previousStep(step)
    if (to) go(to)
  }
  // Without a number the test call happens in the browser, so every step leads to the next.
  const forward = () => go(nextStep(step))
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
    <Frame
      step={step}
      complete={step === 'done' || (step === 'phone' && hasNumber)}
      onSkip={step === 'done' ? undefined : skip}
    >
      {step === 'business' && <BusinessStep businessName={me.workspace!.name} onNext={forward} />}
      {step === 'phone' && (
        <PhoneStep
          status={state.phone}
          setupError={setupError}
          clearError={() => setSetupError(null)}
          onBack={back}
          onNext={forward}
        />
      )}
      {step === 'test_call' && (
        <TestCallStep
          showSimulator={import.meta.env.DEV || state.phone.provider === 'dev'}
          onBack={back}
          onNext={forward}
          onOpenCall={openCall}
        />
      )}
      {step === 'done' && <Done onBack={back} onDone={onDone} />}
      {otherError && (
        <p className="ob-error" role="alert">
          {otherError}
        </p>
      )}
    </Frame>
  )
}

/** "You're live" only when calls are really answered; otherwise what is left, with the way to it. */
function Done({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const name = useAssistantName()
  const number = useRows('phone_numbers')[0]
  const presence = usePresence()
  useStepKeys({ onEnter: onDone, onEscape: onBack })
  const openPhoneSettings = () => {
    window.history.replaceState(null, '', '#settings')
    onDone()
  }
  const live = number && presence.kind === 'answering'
  return (
    <>
      <div className="ob-body">
        <h1>{live ? "You're live." : 'Almost there.'}</h1>
        <p className="ob-lede">
          {live
            ? `${name} answers ${formatNumber(number.e164)}. Every call lands in your inbox with a summary and the next step.`
            : number
              ? `${formatNumber(number.e164)} is connected. ${name} starts answering once the voice service of this Linedesk is set up; whoever runs it can do that.`
              : `One step left: connect a phone number. ${name} starts answering its calls, and every call lands in your inbox.`}
        </p>
        {!number && (
          <p>
            <Button size="sm" icon="phone" onClick={openPhoneSettings} title="Settings, Phone numbers">
              Connect a number
            </Button>
          </p>
        )}
      </div>
      <Foot onBack={onBack} onContinue={onDone} canContinue label="Open my calls" />
    </>
  )
}
