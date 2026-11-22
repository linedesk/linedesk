// The onboarding page around each step: the shared setup top bar (SetupTopBar.tsx) with its progress line, the shared
// footer (SetupFoot.tsx, as `Foot`), and the keys (Enter continues, Esc goes back, Shift+Esc leaves). The same frame
// holds the steps when they are gone through again from the settings ("Step by step", StepByStep.tsx).
import { useT } from '@linedesk/i18n/react'
import { type ReactNode, useEffect, useState } from 'react'
import { brandName, installBrandName } from '../brand.ts'
import { Button } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { useClientWord } from './clientWords.tsx'
import { type OnboardingStep, onboardingSteps, stepLabelKeys } from './flow.ts'
import { SetupFoot, type SetupFootProps, StepModeContext } from './SetupFoot.tsx'
import { SetupPage, SetupTopBar } from './SetupTopBar.tsx'

/** The step's footer: the shared setup footer (SetupFoot.tsx), Back, Later and the primary. */
export { SetupFoot as Foot, useStepMode } from './SetupFoot.tsx'

/**
 * A step whose data is not there yet: its heading, the loading placeholder (or the error with Retry) and its footer with
 * the primary off, the same on every step. `foot`: the step's own Back and Later, never a working primary.
 */
export function StepLoading({
  title,
  what,
  fields = 3,
  error,
  onRetry,
  foot,
}: {
  title: string
  /** What is loading, for screen readers and the error line. */
  what: string
  fields?: number
  error?: string | boolean | null
  onRetry?: () => void
  foot?: Omit<SetupFootProps, 'canContinue'>
}) {
  return (
    <>
      <div className="ob-body">
        <h1>{title}</h1>
        <Loading what={what} loading error={error} onRetry={onRetry} skeleton={<SkeletonFields fields={fields} />} />
      </div>
      <SetupFoot {...foot} canContinue={false} />
    </>
  )
}

export function Frame({
  step,
  complete,
  onSkip,
  steps = onboardingSteps,
  counted = steps,
  edit = false,
  planOnly = false,
  onAgentSetup,
  exitTitle,
  brand = 'app',
  closes = false,
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
   * Set up by hand after all: "Set up with AI" in the top bar, back to the agent setup page, which goes on from
   * what is saved (setup-choice.ts, `agentSetupWayBack`). Only for someone that page is for.
   */
  onAgentSetup?: () => void
  /** The way out's tooltip where it leads somewhere else than the go-live checklist (a client draft: the partner's setup). */
  exitTitle?: string
  /**
   * `install`: the install's own brand, never a white-label one: a partner's team setting up a client workspace is doing
   * the partner's own work, as on the partner's setup pages (its account menu lists every workspace, this one too).
   */
  brand?: 'app' | 'install'
  /** The last step ends the steps where they were opened (a client draft back to the partner's setup): Done, no Later. */
  closes?: boolean
  children: ReactNode
}) {
  const t = useT()
  const word = useClientWord()
  const index = steps.indexOf(step)
  const install = brand === 'install'
  const name = step === 'activate' && planOnly ? t('onboarding.steps.activatePlan') : t(word(stepLabelKeys[step]))
  return (
    <StepModeContext.Provider value={{ edit, last: index === steps.length - 1, closes }}>
      <SetupPage
        className={install && 'k-install-brand'}
        label={t('onboarding.frame.title', { brand: install ? installBrandName() : brandName() })}
        bar={
          <SetupTopBar
            step={{ n: counted.indexOf(step) + 1, m: counted.length, name }}
            ahead={complete}
            agentPath={onAgentSetup}
            exit={onSkip ? { kind: edit ? 'close' : 'finish-later', onExit: onSkip, title: exitTitle } : null}
            brand={brand}
            away={install}
          />
        }
      >
        {children}
      </SetupPage>
    </StepModeContext.Provider>
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
