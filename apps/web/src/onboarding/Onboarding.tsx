// Onboarding, from the first sign-in to the first answered call. Progress lives on the workspace
// (`onboarding.setStep`), so a reload resumes at the same step.
import { offersSampleCalls, offersTour } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import type { Me, OnboardingState } from '../auth.ts'
import { usePresence } from '../shell/presence.ts'
import { queueTour } from '../shell/tour.ts'
import { useWriteAction } from '../settings/settings-api.ts'
import { rejectionText } from '../shell/rejections.ts'
import { callHash } from '../shell/useRoute.ts'
import { useAssistantName, useRejection, useRows, useRun } from '../store.tsx'
import { Button } from '../ui/kit.tsx'
import { BusinessStep } from './BusinessStep.tsx'
import { CalendarStep } from './CalendarStep.tsx'
import { Foot, Frame, useStepKeys } from './Frame.tsx'
import { formatNumber, nextStep, phoneSetupErrorText, previousStep, type OnboardingStep } from './flow.ts'
import { HoursStep } from './HoursStep.tsx'
import { PhoneStep } from './PhoneStep.tsx'
import { TestCallStep } from './TestCallStep.tsx'
import './onboarding.css'

export function Onboarding({ me, state, onDone }: { me: Me; state: OnboardingState; onDone: () => void }) {
  const run = useRun()
  const firstUse = me.firstUse ?? 'off'
  // Leaving onboarding: the tour (where the install offers it) starts in the inbox.
  const finish = () => {
    if (offersTour(firstUse)) queueTour(me.workspace!.id)
    onDone()
  }
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
    finish()
  }
  function openCall(callId: string) {
    void run('onboarding.setStep', { step: 'done' })
    window.history.replaceState(null, '', callHash(callId))
    finish()
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
      {step === 'hours' && <HoursStep onBack={back} onNext={forward} />}
      {step === 'calendar' && <CalendarStep onBack={back} onNext={forward} />}
      {step === 'test_call' && (
        <TestCallStep
          showSimulator={import.meta.env.DEV || state.phone.provider === 'dev'}
          onBack={back}
          onNext={forward}
          onOpenCall={openCall}
        />
      )}
      {step === 'done' && <Done onBack={back} onDone={finish} offerSamples={offersSampleCalls(firstUse)} />}
      {otherError && (
        <p className="ob-error" role="alert">
          {otherError}
        </p>
      )}
    </Frame>
  )
}

/** "You're live" only when calls are really answered; otherwise what is left, with the way to it. */
function Done({ onBack, onDone, offerSamples }: { onBack: () => void; onDone: () => void; offerSamples: boolean }) {
  const name = useAssistantName()
  const number = useRows('phone_numbers')[0]
  const presence = usePresence()
  useStepKeys({ onEnter: onDone, onEscape: onBack })
  const write = useWriteAction()
  const hasCalls = useRows('calls').length > 0
  const [adding, setAdding] = useState(false)
  const [sampleError, setSampleError] = useState<string | null>(null)
  // Sample calls land in the inbox at once (the answer carries the rows), then the inbox opens.
  async function trySamples() {
    setAdding(true)
    setSampleError(null)
    try {
      await write('sample.add', {})
      window.history.replaceState(null, '', '#calls')
      onDone()
    } catch (e) {
      setSampleError((e as Error).message)
      setAdding(false)
    }
  }
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
            ? `${name} answers ${formatNumber(number.e164)}. Calls land in your inbox.`
            : number
              ? `${formatNumber(number.e164)} is connected. ${name} answers once the voice service is set up.`
              : `One step left: connect a phone number in Settings.`}
        </p>
        {(!number || (offerSamples && !hasCalls)) && (
          <p className="ob2-row ob-tight">
            {!number && (
              <Button size="sm" icon="phone" onClick={openPhoneSettings} title="Settings, Phone numbers">
                Connect a number
              </Button>
            )}
            {offerSamples && !hasCalls && (
              <Button
                size="sm"
                icon="spark"
                disabled={adding}
                onClick={() => void trySamples()}
                title="Fill the inbox with example calls you can remove in one click"
              >
                {adding ? 'Adding sample calls…' : 'Try with sample calls'}
              </Button>
            )}
          </p>
        )}
        {sampleError && (
          <p className="ob-error" role="alert">
            {sampleError}
          </p>
        )}
      </div>
      <Foot onBack={onBack} onContinue={onDone} canContinue label="Open my calls" />
    </>
  )
}
