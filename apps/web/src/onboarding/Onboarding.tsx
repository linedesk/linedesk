// Onboarding, from the first sign-in to the first answered call. Progress lives on the workspace
// (`onboarding.setStep`), so a reload resumes at the same step.
import { formatStarCount, offersSampleCalls, offersTour, STAR_REPO_URL } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { T, useT } from '@linedesk/i18n/react'
import { useEffect, useRef, useState } from 'react'
import { AdminMode } from '../admin/AdminMode.tsx'
import type { Me, OnboardingState, PhoneSetupStatus, WebsiteImport } from '../auth.ts'
import { brandName, useBrand } from '../brand.ts'
import { ConfirmEmail } from '../ConfirmEmail.tsx'
import { i18n } from '../i18n/index.tsx'
import { preloadWorkspaceSettings, useWriteAction } from '../settings/settings-api.ts'
import { usePresence } from '../shell/presence.ts'
import { rejectionReason } from '../shell/rejections.ts'
import { queueTour } from '../shell/tour.ts'
import { useAssistantName, useRejection, useRows, useRun } from '../store.tsx'
import { Button, Icon, Note } from '../ui/kit.tsx'
import { ActivatedStep, ActivateStep } from './ActivateStep.tsx'
import { AssistantStep } from './AssistantStep.tsx'
import { BusinessStep } from './BusinessStep.tsx'
import { ForClient, useClientWord } from './clientWords.tsx'
import { Foot, Frame } from './Frame.tsx'
import {
  billedExtraNumberCents,
  type DoneLeft,
  doneState,
  draftOpenedFrom,
  mobileErrorText,
  NO_PICKUP_MEMORY,
  nextStep,
  type OnboardingStep,
  onboardingSteps,
  type PickupMemory,
  partnerDraftSteps,
  phoneSetupErrorText,
  previousStep,
  rejectionStep,
  stepLabelKeys,
  stepsFor,
  URGENT_CONTACT_ID,
} from './flow.ts'
import { InstanceSetupNotice, isInstanceAdmin, useHash } from './InstanceSetup.tsx'
import { NotifyStep } from './NotifyStep.tsx'
import { PhoneStep } from './PhoneStep.tsx'
import { PickupStep } from './PickupStep.tsx'
import { PARTNER_CLIENTS_HASH } from './setup-choice.ts'
import './onboarding.css'
import { useSetupKeys } from './setup-keys.ts'

type Props = {
  me: Me
  state: OnboardingState
  onDone: () => void
  /** The business step renamed the workspace. */
  onRenamed: (name: string) => void
  /** Reads `me` again (the activation step: the terms changed while it was open). */
  onReload?: () => void
  /** Back to the agent setup page (setup-choice.ts, `agentSetupWayBack`): in the top bar of every step but the last. */
  onAgentSetup?: () => void
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

function OnboardingFlow({ me, state, onDone, onRenamed, onReload, onAgentSetup }: Props) {
  const t = useT()
  const run = useRun()
  const firstUse = me.firstUse ?? 'off'
  // Leaving onboarding: the tour (where the install offers it) starts in the inbox.
  const finish = () => {
    if (offersTour(firstUse)) queueTour(me.workspace!.id)
    onDone()
  }
  // Waiting for its trial: the setup, then `activate` (the card); the number only after it. Once
  // it runs, the count goes on over "Start your free trial" as a done step (Step 5 of 7, then 6 of 7, and back again).
  // A white-label partner's draft client workspace (setup before payment): the free steps, then back to where the draft
  // was opened (the partner's setup, the partner area); the number waits for the partner's Checkout.
  const { steps, counted, draft: partnerDraft, activating } = stepsFor(me.workspace)
  const [step, setStep] = useState<OnboardingStep>(() =>
    partnerDraft && !partnerDraftSteps.includes(state.step) ? 'notify' : state.step,
  )
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
  const saves = useStepSaves()
  // What the pick-up step changed this session (hours it turned on, the forwarding a number had before).
  const [pickupMemory, setPickupMemory] = useState<PickupMemory>(NO_PICKUP_MEMORY)
  const hasNumber = useRows('phone_numbers').length > 0
  const toPartnerSetup = () => {
    window.location.hash =
      draftOpenedFrom(workspaceId) ?? (me.partners?.[0]?.role === 'owner' ? PARTNER_CLIENTS_HASH : '#partner')
  }
  // A partner's team doing a client workspace's setup: the partner's own work, in the install's brand (brand.ts).
  const partnerWork = !!me.workspace?.viaPartner

  function go(to: OnboardingStep) {
    setStep(to)
    // Once the trial runs, "Start your free trial" is only shown as done (Back from the number): never saved as where
    // the setup is, the server resumes at the number.
    if (to === 'activate' && !activating) return
    void run('onboarding.setStep', { step: to })
  }
  const back = () => {
    const to = previousStep(step, steps)
    if (to) go(to)
  }
  // Continue saves the step again: its old refusal goes.
  const forward = () => {
    saves.leaving(step)
    // A partner's draft: done with the free steps, the number is next once White-label Cloud runs.
    if (partnerDraft && step === steps.at(-1)) {
      void run('onboarding.setStep', { step: 'phone' })
      return toPartnerSetup()
    }
    go(nextStep(step, steps))
  }
  function skip() {
    void run('onboarding.setStep', { step: 'skipped' })
    finish()
  }

  return (
    // A partner's team setting up a client workspace reads the client's words (clientWords.tsx).
    <ForClient value={!!me.workspace?.viaPartner}>
      <Frame
        step={step}
        steps={steps}
        counted={counted}
        planOnly={me.workspace?.activation?.trialDays === null || (!activating && !me.workspace?.trialEndsAt)}
        complete={step === 'done' || (step === 'phone' && hasNumber) || (step === 'activate' && !activating)}
        // Nothing to finish later before the trial: the app opens only once it runs.
        // A partner's draft: later is its partner's setup, never a skipped onboarding.
        onSkip={partnerDraft ? toPartnerSetup : step === 'done' || activating ? undefined : skip}
        exitTitle={partnerDraft ? t('team.partner.setup.finishLaterTitle') : undefined}
        // The start of the plan ends the setup, as the partner's Activate does: no way off to the agent there.
        onAgentSetup={step === 'done' || step === 'activate' ? undefined : onAgentSetup}
        brand={partnerWork ? 'install' : 'app'}
        closes={partnerDraft}
      >
        <SaveErrors saves={saves} step={step} steps={steps} onOpen={go} />
        {me.emailUnconfirmed && !confirmed && (
          <ConfirmEmail onDone={() => setConfirmed(true)} why={t('onboarding.main.confirmWhy')} />
        )}
        {/* The server's provider setup is for Server admin, never inside a customer's sign-up (billing on). */}
        {isInstanceAdmin(me) && !me.workspace?.billingState && <InstanceSetupNotice />}
        {step === 'activate' &&
          (activating ? (
            <ActivateStep me={me} onBack={back} onTermsChanged={() => onReload?.()} />
          ) : (
            <ActivatedStep trial={!!me.workspace?.trialEndsAt} onBack={back} onNext={forward} />
          ))}
        {step !== 'done' && step !== 'activate' && (
          <StepScreen
            step={step}
            me={me}
            emailConfirmed={!me.emailUnconfirmed || confirmed}
            phone={state.phone}
            businessLookup={!!state.businessLookup}
            websiteImport={state.websiteImport}
            saves={saves}
            pickupMemory={pickupMemory}
            onPickupMemory={setPickupMemory}
            onRenamed={onRenamed}
            onAgentSetup={onAgentSetup}
            onBack={back}
            onNext={forward}
          />
        )}
        {step === 'done' && (
          <Done
            onBack={back}
            onOpenStep={go}
            onDone={finish}
            offerSamples={offersSampleCalls(firstUse)}
            admin={me.permissions.includes('instance:admin')}
            // A paying Linedesk Cloud customer is not asked for a GitHub star; self-hosted installs keep it.
            askForStar={!me.workspace?.billingState}
          />
        )}
      </Frame>
    </ForClient>
  )
}

/** A save the server refused after its step was left; `step` null: not about one step (setup progress). */
type SaveError = { step: OnboardingStep | null; text: string }

/**
 * The refusals of saves queued on steps already left, one per step (a newer refusal replaces an older one of the same
 * step), and of the phone setup: shown above the step (SaveErrors) until dismissed or that step is saved again. The
 * same for the first setup and for the steps gone through again from the settings (StepByStep.tsx).
 */
export function useStepSaves() {
  const [setupError, setSetupError] = useState<string | null>(null)
  const [errors, setErrors] = useState<SaveError[]>([])
  // The step last moved on from: where a refusal that doesn't say otherwise was queued.
  const left = useRef<OnboardingStep | null>(null)
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
      setErrors(all => [...all.filter(e => e.step !== from), error])
    }
    clearRejection()
  }, [rejection, clearRejection])
  return {
    errors,
    setupError,
    clearSetupError: () => setSetupError(null),
    dismiss: (error: SaveError) => setErrors(all => all.filter(e => e !== error)),
    /** Continue on `step`: its saves are queued now, so its old refusal goes. */
    leaving: (step: OnboardingStep) => {
      left.current = step
      setErrors(all => all.filter(e => e.step !== step))
    },
  }
}
type StepSaves = ReturnType<typeof useStepSaves>

type StepScreenProps = {
  step: Exclude<OnboardingStep, 'done' | 'activate'>
  me: Me
  emailConfirmed: boolean
  phone: PhoneSetupStatus
  businessLookup: boolean
  websiteImport?: WebsiteImport
  /** The assistant the steps are about (step by step from its settings); else the workspace's default one. */
  assistantId?: string
  saves: StepSaves
  pickupMemory: PickupMemory
  onPickupMemory: (memory: PickupMemory) => void
  onRenamed: (name: string) => void
  /** Back to the agent setup page (the first setup only): the business step offers it while nothing is filled in yet. */
  onAgentSetup?: () => void
  onBack: () => void
  onNext: () => void
}

/**
 * One step of the setup, the same components with the same saves whether the workspace is set up for the first time
 * (OnboardingFlow) or the steps are gone through again from the settings (StepByStep.tsx): each step starts from what
 * is saved.
 */
export function StepScreen(p: StepScreenProps) {
  const admin = p.me.permissions.includes('instance:admin')
  switch (p.step) {
    case 'business':
      return (
        <BusinessStep
          businessName={p.me.workspace!.unnamed ? '' : p.me.workspace!.name}
          lookup={p.businessLookup}
          websiteImport={p.websiteImport}
          admin={admin}
          assistantId={p.assistantId}
          onRenamed={p.onRenamed}
          onAgentSetup={p.onAgentSetup}
          onNext={p.onNext}
        />
      )
    case 'assistant':
      return (
        <AssistantStep
          assistantId={p.assistantId}
          onBack={p.onBack}
          onNext={p.onNext}
          operator={admin || Boolean(p.me.adminSecondFactor)}
        />
      )
    case 'pickup':
      return <PickupStep onBack={p.onBack} onNext={p.onNext} memory={p.pickupMemory} onMemory={p.onPickupMemory} />
    case 'notify':
      return (
        <NotifyStep
          actorId={p.me.actorId}
          emailConfirmed={p.emailConfirmed}
          assistantId={p.assistantId}
          onBack={p.onBack}
          onNext={p.onNext}
        />
      )
    case 'phone':
      return (
        <PhoneStep
          status={p.phone}
          setupError={p.saves.setupError}
          clearError={p.saves.clearSetupError}
          admin={admin}
          // The bill's price only on the install's carrier account, as in Settings › Phone numbers › Add number.
          extraNumberCents={billedExtraNumberCents(p.me.workspace?.extraNumberCents, p.phone)}
          partnerManaged={p.me.workspace?.partnerManaged === true}
          oldForwarding={p.pickupMemory.oldForwarding}
          onBack={p.onBack}
          onNext={p.onNext}
        />
      )
  }
}

/** "Couldn't save …: reason", one whole sentence per step. */
const SAVE_ERRORS: Record<OnboardingStep, MessageKey> = {
  business: msg('onboarding.main.saveError.business'),
  assistant: msg('onboarding.main.saveError.assistant'),
  pickup: msg('onboarding.main.saveError.pickup'),
  notify: msg('onboarding.main.saveError.notify'),
  activate: msg('onboarding.main.saveError.activate'),
  phone: msg('onboarding.main.saveError.phone'),
  done: msg('onboarding.main.saveError.done'),
}

/** "Couldn't save your business details: reason." The step's own words for its refusals (the mobile), else the shared ones. */
function saveErrorText(step: OnboardingStep | null, action: string, input: unknown, error: string): string {
  const { t } = i18n()
  if (!step) return t('onboarding.main.saveError.progress', { reason: rejectionReason(error) })
  const what = SAVE_ERRORS[step]
  if (step === 'notify' && action === 'assistant.update') {
    const transfers = (input as { transfers?: { id: string; name: string }[] }).transfers ?? []
    const name = transfers.find(c => c.id === URGENT_CONTACT_ID)?.name ?? ''
    const own = mobileErrorText(error, name)
    if (own !== error) return t(what, { reason: own })
  }
  return t(what, { reason: rejectionReason(error) })
}

/**
 * The one place save errors show, above the step: what failed, a way back to that step (when it is one of the `steps`
 * gone through), and Dismiss.
 */
export function SaveErrors({
  saves,
  step,
  steps = onboardingSteps,
  onOpen,
}: {
  saves: StepSaves
  step: OnboardingStep
  steps?: readonly OnboardingStep[]
  onOpen: (step: OnboardingStep) => void
}) {
  const t = useT()
  const word = useClientWord()
  if (!saves.errors.length) return null
  return (
    <div className="ob-save-errors">
      {saves.errors.map(e => (
        <Note
          key={e.step ?? 'progress'}
          tone="danger"
          action={
            <>
              {e.step && e.step !== step && steps.includes(e.step) && (
                <Button size="sm" onClick={() => onOpen(e.step!)} title={t('onboarding.main.openStepTip')}>
                  {t('onboarding.main.backTo', { step: t(word(stepLabelKeys[e.step])) })}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => saves.dismiss(e)}>
                {t('onboarding.main.dismiss')}
              </Button>
            </>
          }
        >
          {e.text}
        </Note>
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
      <T
        k="onboarding.main.star"
        values={{
          brand: brandName(),
          heart: () => (
            <span className="ob-star-heart" aria-hidden="true">
              ♥
            </span>
          ),
          link: chunks => (
            <a href={STAR_REPO_URL} target="_blank" rel="noreferrer">
              {chunks}
            </a>
          ),
        }}
      />
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
  onOpenStep,
  onDone,
  offerSamples,
  admin,
  askForStar,
}: {
  onBack: () => void
  /** Back to a step of the walkthrough (the number, its forwarding codes), in place. */
  onOpenStep: (step: OnboardingStep) => void
  onDone: () => void
  offerSamples: boolean
  admin: boolean
  /** Off a bill (self-hosted): the quiet GitHub star line. Not for a workspace on a bill (Linedesk Cloud). */
  askForStar: boolean
}) {
  const t = useT()
  const word = useClientWord()
  const name = useAssistantName()
  const number = useRows('phone_numbers')[0] ?? null
  const presence = usePresence()
  // The inbox, whatever page the address still named (one from before signing up).
  const openCalls = () => open('#calls')
  const write = useWriteAction()
  const hasCalls = useRows('calls').length > 0
  const [adding, setAdding] = useState(false)
  const [sampleError, setSampleError] = useState<string | null>(null)
  const state = doneState(
    {
      number,
      // Not set up, or set up but failing (a used-up quota, LIN-111): either way calls are not answered.
      voiceMissing: presence.kind === 'notAnswering' && presence.reason !== 'number',
      // LIN-85 (#488): read from the go-live checklist's state once it is on main.
      forwardingVerified: false,
      admin,
      assistant: name,
    },
    word,
  )
  // One way in (Janik, 2026-11-22): the sample calls are the tour's material, added with it, never a choice. They land in
  // the inbox at once (the answer carries the rows); the tour's end removes them again (Workspace.tsx).
  async function openApp() {
    if (!offerSamples || hasCalls) return openCalls()
    setAdding(true)
    setSampleError(null)
    try {
      await write('sample.add', {})
      open('#calls')
    } catch (e) {
      setSampleError(t('onboarding.main.samplesFailed', { reason: rejectionReason((e as Error).message) }))
      setAdding(false)
    }
  }
  function open(href: string) {
    window.history.replaceState(null, '', href)
    onDone()
  }
  useSetupKeys({ onEnter: () => void openApp(), onEscape: onBack })
  // What is left opens in place (design-principles.md rule 14): the phone step, or Server admin, which comes back here.
  function follow(to: NonNullable<DoneLeft['to']>) {
    if ('step' in to) onOpenStep(to.step)
    else window.location.hash = to.admin
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
                <span>{l.label}</span>
                {l.to && l.action && (
                  <Button size="sm" variant="secondary" onClick={() => follow(l.to!)}>
                    {l.action}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {sampleError && <Note tone="danger">{sampleError}</Note>}
        {askForStar && <StarLine />}
      </div>
      <Foot
        onBack={onBack}
        onContinue={() => void openApp()}
        busy={adding}
        canContinue={!adding}
        label={t('onboarding.main.openApp', { brand: brandName() })}
      />
    </>
  )
}
