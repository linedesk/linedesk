// "Step by step" on Workspace settings › General and Assistant settings › General (settings/AgentChange.tsx), at
// #step-by-step/workspace or #step-by-step/assistant/<id> (settings/agentChange.ts): the steps the workspace was set up
// with, gone through again. The onboarding's own frame, steps and saves (Onboarding.tsx: StepScreen, useStepSaves),
// never a copy of them: each step starts from what is saved and saves with the same actions as the settings. Nothing
// here moves the onboarding (no `onboarding.setStep`); the steps that are done once are left out (stepByStepSteps).
// Close, or Done on the last step, goes back to the settings page it was opened from; the account menu is in the top bar
// as on every setup page (SetupTopBar.tsx).
import { useEffect, useState } from 'react'
import type { Me } from '../auth.ts'
import { type ChangeTarget, settingsHashOf } from '../settings/agentChange.ts'
import { preloadWorkspaceSettings, useWorkspaceSettings } from '../settings/settings-api.ts'
import { useGoLiveChecklist } from '../inbox/GoLiveChecklist.tsx'
import { useAssistantOf, useAssistants, useRows } from '../store.tsx'
import { Frame } from './Frame.tsx'
import {
  firstOpenStep,
  NO_PICKUP_MEMORY,
  type OnboardingStep,
  type PickupMemory,
  stepByStepMove,
  stepByStepSteps,
} from './flow.ts'
import { profileSaved } from './business.ts'
import { SaveErrors, StepScreen, useStepSaves } from './Onboarding.tsx'
import './onboarding.css'
import { readStored, writeStored } from '../safeStorage.ts'

type Props = {
  target: ChangeTarget
  me: Me
  /** The business step renamed the workspace: the menu and the switcher show the new name at once. */
  onRenamed: (name: string) => void
}

const STEP_KEY = 'linedesk.stepByStep.'

/** The step this tab last showed for these steps (this tab only, gone when it closes). */
const keptStep = (key: string) => readStored('session', key) as OnboardingStep | null
const keepStep = (key: string, step: OnboardingStep | null) => writeStored('session', key, step)

/** What a member without a phone setup status sees on the number's step. */
const NO_PHONE_SETUP = { provider: null, available: false, detail: null, canAttach: false }

export function StepByStep({ target, me, onRenamed }: Props) {
  const assistants = useAssistants()
  const assistantId = target.kind === 'assistant' ? target.assistantId : undefined
  // An assistant that is not (or no longer) in this workspace: back to the settings, which say so.
  const unknown = assistantId !== undefined && assistants.length > 0 && !assistants.some(a => a.id === assistantId)
  // The step gone to is kept in this tab, so a reload opens it again; Close (or Done) forgets it.
  const stepKey = STEP_KEY + settingsHashOf(target)
  const close = () => {
    keepStep(stepKey, null)
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
  // Not live yet (no number, or forwarding never verified and no real call): the number is one of the steps.
  const assistant = useAssistantOf(assistantId)
  const numbers = useRows('phone_numbers')
  const checklist = useGoLiveChecklist(me.permissions.includes('settings:write'), me.workspace!.id)
  const settings = useWorkspaceSettings().data
  const numberOpen =
    target.kind === 'workspace' &&
    (numbers.length === 0 || (!!checklist && !checklist.forwardingVerified && !checklist.firstRealCall))
  const steps = stepByStepSteps(target.kind, pickupMemory.oldForwarding !== null, numberOpen)
  // Opens where it was in this tab, else at the first step still open (Janik, 2026-11-22); what is not loaded yet
  // counts as done.
  const [step, setStepNow] = useState<OnboardingStep>(() => {
    const kept = keptStep(stepKey)
    if (kept && steps.includes(kept)) return kept
    return firstOpenStep(steps, {
      business: !!assistant && !profileSaved(assistant.business_profile),
      pickup: !!settings && !settings.pickupMode,
      phone: numberOpen,
    })
  })
  const setStep = (to: OnboardingStep) => {
    setStepNow(to)
    keepStep(stepKey, to)
  }
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
  if (unknown || step === 'done' || step === 'activate') return null
  return (
    <Frame step={step} complete={false} steps={steps} edit onSkip={close}>
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
