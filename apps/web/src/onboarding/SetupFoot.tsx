// The one footer of every setup step (2026-11-18): a row that stays in view at the bottom of the content column. Back
// on the left (a ghost button with a chevron, or another quiet way: "Set up by hand instead", "Back to settings"),
// the step's primary on the right, and "Later" as a ghost left of it where the step can wait. The ⏎ hint on the
// primary only where there is a keyboard (a fine pointer that hovers), never on a touch phone (setup-foot rule in
// styles.css). The onboarding's steps get it as Frame's `Foot`; the install by hand and the agent pages use it as is.
import { useT } from '@linedesk/i18n/react'
import { createContext, type ReactNode, useContext } from 'react'
import { Button } from '../ui/kit.tsx'

/**
 * How the steps are gone through: the first setup (onboarding), or again from the settings (`edit`, StepByStep.tsx),
 * where the last step's Continue says Done and nothing is put off for "Later" (the settings stay where they are).
 * `closes`: the last step ends the steps where they were opened (again from the settings, or a partner's client draft
 * that goes back to the partner's setup): its primary says Done and it offers no "Later".
 */
export type StepMode = { edit: boolean; last: boolean; closes?: boolean }
export const StepModeContext = createContext<StepMode>({ edit: false, last: false })

/** Whether the step shows in the first setup or again from the settings, and whether it is the last one. */
export const useStepMode = (): StepMode => useContext(StepModeContext)

export type SetupFootProps = {
  onBack?: () => void
  /** The back slot's words where it is no plain "Back" ("Set up by hand instead", "Back to settings"). */
  backLabel?: string
  backTitle?: string
  /** The chevron of a way back; off for a way that is no step back ("Set up by hand instead"). */
  backIcon?: boolean
  onContinue?: () => void
  /** Default true. */
  canContinue?: boolean
  label?: string
  /** The primary's look: `secondary` where going on is no recommendation (skipping a part that is not set up). */
  variant?: 'primary' | 'secondary'
  /** A short line left of the buttons. */
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
  /** Something of the page's own in the primary's place (a link that opens Linedesk, a button that switches). */
  primary?: ReactNode
}

export function SetupFoot({
  onBack,
  backLabel,
  backTitle,
  backIcon = true,
  onContinue,
  canContinue = true,
  label,
  variant = 'primary',
  hint,
  busy,
  onSkipStep,
  laterLabel,
  laterTitle,
  primary,
}: SetupFootProps) {
  const t = useT()
  const mode = useStepMode()
  // Again from the settings, or a client draft's last step: its Continue ends there ("Done"), nothing waits for later.
  const closing = mode.last && (mode.edit || !!mode.closes)
  const continueLabel = closing ? t('onboarding.frame.done') : (label ?? t('onboarding.action.continue'))
  const skipStep = mode.edit || closing ? undefined : onSkipStep
  return (
    <div className="ob-foot">
      {onBack ? (
        <Button
          variant="ghost"
          icon={backIcon ? 'left' : undefined}
          onClick={onBack}
          title={backTitle ?? t('onboarding.frame.backTitle')}
        >
          {backLabel ?? t('onboarding.action.back')}
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
        {primary}
        {onContinue && (
          <Button
            variant={variant}
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
