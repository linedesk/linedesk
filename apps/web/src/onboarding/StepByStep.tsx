// "Step by step" on Workspace settings › General and Assistant settings › General (settings/AgentChange.tsx), at
// #step-by-step/workspace or #step-by-step/assistant/<id> (settings/agentChange.ts): the steps the workspace was set up
// with, gone through again. The onboarding's own frame, steps and saves (Onboarding.tsx: StepScreen, useStepSaves),
// never a copy of them: each step starts from what is saved and saves with the same actions as the settings. Nothing
// here moves the onboarding (no `onboarding.setStep`); the steps that are done once are left out (stepByStepSteps).
// Close, or Done on the last step, goes back to the settings page it was opened from.
import { useEffect, useState } from 'react'
import type { Me } from '../auth.ts'
import { type ChangeTarget, settingsHashOf } from '../settings/agentChange.ts'
import { preloadWorkspaceSettings } from '../settings/settings-api.ts'
import { useAssistants } from '../store.tsx'
import { Frame } from './Frame.tsx'
import { NO_PICKUP_MEMORY, type OnboardingStep, type PickupMemory, stepByStepMove, stepByStepSteps } from './flow.ts'
import { SaveErrors, StepScreen, useStepSaves } from './Onboarding.tsx'
import './onboarding.css'

type Props = {
  target: ChangeTarget
  me: Me
  /** The business step renamed the workspace: the menu and the switcher show the new name at once. */
  onRenamed: (name: string) => void
}

/** What a member without a phone setup status sees there; the steps gone through again never ask for a number. */
const NO_PHONE_SETUP = { provider: null, available: false, detail: null, canAttach: false }

export function StepByStep({ target, me, onRenamed }: Props) {
  const assistants = useAssistants()
  const assistantId = target.kind === 'assistant' ? target.assistantId : undefined
  // An assistant that is not (or no longer) in this workspace: back to the settings, which say so.
  const unknown = assistantId !== undefined && assistants.length > 0 && !assistants.some(a => a.id === assistantId)
  const close = () => {
    window.location.hash = settingsHashOf(target)
  }
  useEffect(() => {
    if (unknown) window.location.hash = settingsHashOf(target)
  }, [unknown, target])
  // The pick-up step shows the saved choice and hours: loaded now, so they are there when it opens.
  useEffect(() => {
    void preloadWorkspaceSettings()
  }, [])
  const saves = useStepSaves()
  // What the pick-up step changed here (hours it turned on, the forwarding a number had before): a changed forwarding
  // adds the number's step, with the code to dial.
  const [pickupMemory, setPickupMemory] = useState<PickupMemory>(NO_PICKUP_MEMORY)
  const steps = stepByStepSteps(target.kind, pickupMemory.oldForwarding !== null)
  const [step, setStep] = useState<OnboardingStep>(steps[0]!)
  const move = (way: 'next' | 'back') => {
    const to = stepByStepMove(steps, step, way)
    if (to === 'close') close()
    else setStep(to)
  }
  // Continue saves the step (queued, like the onboarding); after the last one, back to the settings.
  const forward = () => {
    saves.leaving(step)
    move('next')
  }
  const open = (to: OnboardingStep) => {
    if (steps.includes(to)) setStep(to)
  }
  if (unknown || step === 'done') return null
  return (
    <Frame step={step} complete steps={steps} edit onSkip={close}>
      <SaveErrors saves={saves} step={step} steps={steps} onOpen={open} />
      <StepScreen
        step={step}
        me={me}
        emailConfirmed={!me.emailUnconfirmed}
        phone={me.phoneSetup ?? NO_PHONE_SETUP}
        businessLookup={me.businessSetup?.businessLookup ?? false}
        websiteImport={me.businessSetup?.websiteImport}
        assistantId={assistantId}
        saves={saves}
        pickupMemory={pickupMemory}
        onPickupMemory={setPickupMemory}
        onRenamed={onRenamed}
        onBack={() => move('back')}
        onNext={forward}
      />
    </Frame>
  )
}
