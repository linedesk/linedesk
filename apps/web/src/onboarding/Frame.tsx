// The onboarding page around each step: the shared setup top bar (SetupTopBar.tsx) with its progress line, the shared
// footer (SetupFoot.tsx, as `Foot`), and the keys (Enter continues, Esc goes back, Shift+Esc leaves). The same frame
// holds the steps when they are gone through again from the settings ("Step by step", StepByStep.tsx).
import { useT } from '@linedesk/i18n/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../ui/kit.tsx'
import { useClientWord } from './clientWords.tsx'
import { onboardingSteps, stepLabelKeys, type OnboardingStep } from './flow.ts'
import { brandName } from '../brand.ts'
import { StepModeContext } from './SetupFoot.tsx'
import { SetupTopBar } from './SetupTopBar.tsx'

type Keys = { onEnter?: () => void; onEscape?: () => void }

/**
 * Enter outside buttons, links and text areas (there ⌘/Ctrl+Enter) runs `onEnter`; Esc runs `onEscape`. Shift+Esc is
 * the top bar's own: Finish later (or Close).
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
      // A focused summary opens its details (the activate step's "See all details"), never the step's primary.
      if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || (tag === 'TEXTAREA' && !(e.metaKey || e.ctrlKey)))
        return
      e.preventDefault()
      onEnter()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export { useStepMode } from './SetupFoot.tsx'
/** The step's footer: the shared setup footer (SetupFoot.tsx), Back, Later and the primary. */
export { SetupFoot as Foot } from './SetupFoot.tsx'

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
  /** The step is done already (a number bought on the phone step): the line under the top bar shows it. */
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
   * through "Start your free trial" to the number and Done, so the count never starts over when the trial begins.
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
  const name = step === 'activate' && planOnly ? t('onboarding.steps.activatePlan') : t(word(stepLabelKeys[step]))
  return (
    <div className="ob" role="main" aria-label={t('onboarding.frame.title', { brand: brandName() })}>
      <SetupTopBar
        step={{ n: counted.indexOf(step) + 1, m: counted.length, name }}
        ahead={complete}
        agentPath={onAgentSetup}
        exit={onSkip ? { kind: edit ? 'close' : 'finish-later', onExit: onSkip } : null}
      />
      <StepModeContext.Provider value={{ edit, last: index === steps.length - 1 }}>
        <div className="ob-main">{children}</div>
      </StepModeContext.Provider>
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
