// The onboarding page around each step: top bar, progress, footer, and the keys (Enter continues, Esc goes back).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Icon } from '../ui/kit.tsx'
import { onboardingSteps, progress, stepLabels, type OnboardingStep } from './flow.ts'

type Keys = { onEnter?: () => void; onEscape?: () => void }

/** Enter outside buttons, links and text areas (there ⌘/Ctrl+Enter) runs `onEnter`; Esc runs `onEscape`. */
export function useStepKeys(keys: Keys) {
  const ref = useRef(keys)
  ref.current = keys
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || e.defaultPrevented) return
      const { onEnter, onEscape } = ref.current
      if (e.key === 'Escape' && onEscape) {
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
  onSkip?: () => void
  children: ReactNode
}) {
  const index = onboardingSteps.indexOf(step)
  return (
    <div className="ob" role="main" aria-label="Set up Linedesk">
      <div className="ob-top">
        <span className="ws-mark">
          <Icon name="spark" size={13} />
        </span>
        <b>Linedesk</b>
        <span className="ob-count">
          Step {index + 1} of {onboardingSteps.length} · {stepLabels[step]}
        </span>
        {onSkip && (
          <Button size="sm" variant="ghost" onClick={onSkip}>
            Skip setup
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
  busy?: boolean
}

export function Foot({ onBack, onContinue, canContinue, label = 'Continue', hint, busy }: FootProps) {
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
        {onContinue && (
          <Button
            variant="primary"
            shortcut={canContinue && !busy ? ['⏎'] : undefined}
            disabled={!canContinue || busy}
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
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
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
      icon={state === 'copied' ? 'check' : undefined}
      onClick={() => void copy()}
      aria-label={`${label} ${text}`}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it instead' : label}
    </Button>
  )
}
