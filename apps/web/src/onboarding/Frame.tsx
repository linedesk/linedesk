// The onboarding page around each step: top bar, progress, footer, and the keys (Enter continues, Esc goes back). The
// same frame holds the steps when they are gone through again from the settings ("Step by step", StepByStep.tsx).
import { useT } from '@linedesk/i18n/react'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { BrandMark, Button } from '../ui/kit.tsx'
import { useClientWord } from './clientWords.tsx'
import { onboardingSteps, progress, stepLabelKeys, type OnboardingStep } from './flow.ts'
import { brandName } from '../brand.ts'
import { SetupAccountMenu } from '../shell/SetupAccountMenu.tsx'

type Keys = { onEnter?: () => void; onEscape?: () => void }

/**
 * Enter outside buttons, links and text areas (there ⌘/Ctrl+Enter) runs `onEnter`; Esc runs `onEscape`. Shift+Esc is
 * the frame's own: Finish later.
 */
export function useStepKeys(keys: Keys) {
  const ref = useRef(keys)
  ref.current = keys
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || e.defaultPrevented) return
      const { onEnter, onEscape } = ref.current
      if (e.key === 'Escape' && onEscape && !e.shiftKey) {
        e.preventDefault()
        onEscape()
        return
      }
      if (e.key !== 'Enter' || e.shiftKey || !onEnter) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'BUTTON' || tag === 'A' || (tag === 'TEXTAREA' && !(e.metaKey || e.ctrlKey))) return
      e.preventDefault()
      onEnter()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * How the steps are gone through: the first setup (onboarding), or again from the settings (`edit`, StepByStep.tsx),
 * where the last step's Continue says Done and nothing is put off for "Later" (the settings stay where they are).
 */
type StepMode = { edit: boolean; last: boolean }
const StepModeContext = createContext<StepMode>({ edit: false, last: false })

/** Whether the step shows in the first setup or again from the settings, and whether it is the last one. */
export const useStepMode = (): StepMode => useContext(StepModeContext)

export function Frame({
  step,
  complete,
  onSkip,
  steps = onboardingSteps,
  counted = steps,
  edit = false,
  planOnly = false,
  onAgentSetup,
  children,
}: {
  step: OnboardingStep
  complete: boolean
  /**
   * Leave setup now and finish it later (what is left stays in the go-live checklist); in `edit`, close the steps and
   * go back to the settings.
   */
  onSkip?: () => void
  /** The steps gone through, in order: the onboarding's, or the ones step by step goes through again. */
  steps?: readonly OnboardingStep[]
  /**
   * The steps the counter and the bar count (default: `steps`). A trial sign-up counts its whole way, from the setup
   * through "Start your trial" to the number and Done, so the count never starts over when the trial begins.
   */
  counted?: readonly OnboardingStep[]
  /** Gone through again from the settings ("Step by step"): "Close" in place of "Finish later". */
  edit?: boolean
  /** No free trial for this workspace's bill (the account or the card had one): `activate` starts the plan. */
  planOnly?: boolean
  /**
   * Set up by hand after all: "Set up with an AI agent" in the top bar, back to the agent setup page, which goes on from
   * what is saved (setup-choice.ts, `agentSetupWayBack`). Only for someone that page is for.
   */
  onAgentSetup?: () => void
  children: ReactNode
}) {
  const t = useT()
  const word = useClientWord()
  const index = steps.indexOf(step)
  const skipRef = useRef(onSkip)
  skipRef.current = onSkip
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !e.shiftKey || e.isComposing || !skipRef.current) return
      e.preventDefault()
      skipRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="ob" role="main" aria-label={t('onboarding.frame.title', { brand: brandName() })}>
      <div className="ob-top">
        <BrandMark />
        <b>{brandName()}</b>
        <span className="ob-count">
          {t('onboarding.frame.stepCount', {
            step: counted.indexOf(step) + 1,
            total: counted.length,
            label: step === 'activate' && planOnly ? t('onboarding.steps.activatePlan') : t(word(stepLabelKeys[step])),
          })}
        </span>
        {/* A phone's top bar: the count alone, next to the account menu. */}
        <span className="ob-count-short" aria-hidden="true">
          {t('onboarding.frame.stepShort', { step: counted.indexOf(step) + 1, total: counted.length })}
        </span>
        {onAgentSetup && (
          <Button
            size="sm"
            variant="ghost"
            icon="spark"
            className="ob-agent"
            onClick={onAgentSetup}
            aria-label={t('onboarding.frame.agent')}
            title={t('onboarding.frame.agentTitle')}
          >
            {t('onboarding.frame.agent')}
          </Button>
        )}
        {onSkip && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onSkip}
            title={t(edit ? 'onboarding.frame.closeTitle' : 'onboarding.frame.finishLaterTitle')}
          >
            {t(edit ? 'onboarding.frame.close' : 'onboarding.frame.finishLater')}
          </Button>
        )}
        {/* Sign out or another workspace mid-setup; from the settings ("Step by step") the app's own menu is a Close away. */}
        {!edit && <SetupAccountMenu />}
      </div>
      <div className="ob-bar">
        <span style={{ width: `${progress(step, complete, counted)}%` }} />
      </div>
      <StepModeContext.Provider value={{ edit, last: index === steps.length - 1 }}>
        <div className="ob-main">{children}</div>
      </StepModeContext.Provider>
    </div>
  )
}

type FootProps = {
  onBack?: () => void
  onContinue?: () => void
  canContinue: boolean
  label?: string
  hint?: string
  /** Waiting for something that must finish first: the primary button shows a spinner (never a text-only "…ing"). */
  busy?: boolean
  /**
   * This step can be done later, next to its own action. Nothing in setup is skipped for good: the label says
   * "Later" (or `laterLabel`) and the tooltip says where it waits (`laterTitle`).
   */
  onSkipStep?: () => void
  laterLabel?: string
  laterTitle?: string
}

export function Foot({
  onBack,
  onContinue,
  canContinue,
  label,
  hint,
  busy,
  onSkipStep,
  laterLabel,
  laterTitle,
}: FootProps) {
  const t = useT()
  const mode = useStepMode()
  // Again from the settings: the last step's Continue ends there ("Done"), and nothing is put off for later.
  const continueLabel = mode.edit && mode.last ? t('onboarding.frame.done') : (label ?? t('onboarding.action.continue'))
  const skipStep = mode.edit ? undefined : onSkipStep
  return (
    <div className="ob-foot">
      {onBack ? (
        <Button variant="ghost" icon="left" onClick={onBack} title={t('onboarding.frame.backTitle')}>
          {t('onboarding.action.back')}
        </Button>
      ) : (
        <span />
      )}
      <div className="ob2-foot-r">
        {hint && <span className="ob2-hint">{hint}</span>}
        {skipStep && (
          <Button
            variant="ghost"
            onClick={skipStep}
            disabled={busy}
            title={laterTitle ?? t('onboarding.frame.laterTitle')}
          >
            {laterLabel ?? t('onboarding.action.later')}
          </Button>
        )}
        {onContinue && (
          <Button
            variant="primary"
            shortcut={canContinue && !busy ? ['⏎'] : undefined}
            disabled={!canContinue}
            busy={busy}
            onClick={onContinue}
          >
            {continueLabel}
          </Button>
        )}
      </div>
    </div>
  )
}

/** A value with a Copy button that says "Copied" for a moment. */
export function CopyButton({
  text,
  label,
  variant,
}: {
  text: string
  label?: string
  variant?: 'primary' | 'secondary'
}) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const id = setTimeout(() => setState('idle'), 1600)
    return () => clearTimeout(id)
  }, [state])
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => setState('copied'),
      () => setState('failed'),
    )
  return (
    <Button
      size="sm"
      variant={variant}
      icon={state === 'copied' ? 'check' : undefined}
      onClick={() => void copy()}
      aria-label={label ? t('onboarding.frame.copyLabel', { label, text }) : t('common.copy.copyThis', { text })}
    >
      {state === 'copied'
        ? t('common.copy.copied')
        : state === 'failed'
          ? t('onboarding.frame.selectInstead')
          : (label ?? t('common.copy.copy'))}
    </Button>
  )
}
