// The onboarding page around each step: top bar, progress, footer, and the keys (Enter continues, Esc goes back).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BrandMark, Button } from '../ui/kit.tsx'
import { onboardingSteps, progress, stepLabels, type OnboardingStep } from './flow.ts'
import { brandName } from '../brand.ts'

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

export function Frame({
  step,
  complete,
  onSkip,
  children,
}: {
  step: OnboardingStep
  complete: boolean
  /** Leave setup now and finish it later (what is left stays in the go-live checklist). */
  onSkip?: () => void
  children: ReactNode
}) {
  const index = onboardingSteps.indexOf(step)
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
    <div className="ob" role="main" aria-label={`Set up ${brandName()}`}>
      <div className="ob-top">
        <BrandMark />
        <b>{brandName()}</b>
        <span className="ob-count">
          Step {index + 1} of {onboardingSteps.length} · {stepLabels[step]}
        </span>
        {onSkip && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onSkip}
            title="Finish setup later: what is left stays in your go-live checklist (Shift+Esc)"
          >
            Finish later
          </Button>
        )}
      </div>
      <div className="ob-bar">
        <span style={{ width: `${progress(step, complete)}%` }} />
      </div>
      <div className="ob-main">{children}</div>
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
  label = 'Continue',
  hint,
  busy,
  onSkipStep,
  laterLabel = 'Later',
  laterTitle = 'Do this later in Assistant settings',
}: FootProps) {
  return (
    <div className="ob-foot">
      {onBack ? (
        <Button variant="ghost" icon="left" onClick={onBack} title="Back (Esc)">
          Back
        </Button>
      ) : (
        <span />
      )}
      <div className="ob2-foot-r">
        {hint && <span className="ob2-hint">{hint}</span>}
        {onSkipStep && (
          <Button variant="ghost" onClick={onSkipStep} disabled={busy} title={laterTitle}>
            {laterLabel}
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
            {label}
          </Button>
        )}
      </div>
    </div>
  )
}

/** A value with a Copy button that says "Copied" for a moment. */
export function CopyButton({
  text,
  label = 'Copy',
  variant,
}: {
  text: string
  label?: string
  variant?: 'primary' | 'secondary'
}) {
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
      aria-label={`${label} ${text}`}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it instead' : label}
    </Button>
  )
}
