// The first-use tour: a small card at the bottom right, five steps, the thing each one explains outlined.
// → next, ← back, Esc closes; every other key still works, so the shortcuts it names can be tried at once.
import { useEffect, useState } from 'react'
import { useAssistantName } from '../store.tsx'
import { Button } from '../ui/kit.tsx'
import { tourKey, tourSteps } from './tour.ts'

export function Tour({ onClose }: { onClose: () => void }) {
  const steps = tourSteps(useAssistantName())
  const [at, setAt] = useState(0)
  const step = steps[at]!
  const last = at === steps.length - 1

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return // arrows move the caret there
      const next = tourKey(e.key, at, steps.length)
      if (next === null) return
      e.preventDefault()
      e.stopPropagation()
      if (next === 'close') onClose()
      else setAt(next)
    }
    window.addEventListener('keydown', onKey, true) // before the app's own shortcuts (Esc there closes a call)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [at, steps.length, onClose])

  // Outlines what the step explains, while it shows.
  useEffect(() => {
    const target = step.target ? document.querySelector(step.target) : null
    target?.classList.add('tour-target')
    return () => target?.classList.remove('tour-target')
  }, [step.target])

  return (
    <section className="tour" role="dialog" aria-label="Tour" aria-live="polite">
      <h2>{step.title}</h2>
      <p>{step.text}</p>
      <div className="tour-foot">
        <span className="tour-count">
          {at + 1} of {steps.length}
        </span>
        <Button size="sm" variant="ghost" onClick={onClose} title="Close the tour (esc)">
          {last ? 'Close' : 'Skip'}
        </Button>
        {at > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setAt(at - 1)} title="Back (←)">
            Back
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          shortcut={['→']}
          onClick={() => (last ? onClose() : setAt(at + 1))}
          title={last ? 'Done (→)' : 'Next (→)'}
        >
          {last ? 'Done' : 'Next'}
        </Button>
      </div>
    </section>
  )
}
