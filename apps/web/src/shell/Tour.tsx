// The first-use tour: five steps, each a small card next to what it explains, with an arrow pointing at it
// and the rest of the screen dimmed around it. With nothing to point at (phones hide some of it) the card
// is centred. → or Enter next, ← back, Esc closes; every other key still works, so the shortcuts it names
// can be tried at once, and clicks go through to the app.
import { arrow, autoUpdate, flip, hide, offset, shift, useFloating } from '@floating-ui/react-dom'
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAssistantName } from '../store.tsx'
import { Button } from '../ui/kit.tsx'
import { findTarget, onScreen, spotlightBox, type TourStep, tourKey, tourSteps } from './tour.ts'

const GAP = 12 // between the target and the card's arrow tip
const EDGE = 12 // the card keeps this far from the window's edges

export function Tour({ onClose }: { onClose: () => void }) {
  const assistant = useAssistantName()
  const steps = useMemo(() => tourSteps(assistant), [assistant])
  const [at, setAt] = useState(0)
  const step = steps[at]!
  const last = at === steps.length - 1
  const target = useStepTarget(step)
  const titleId = useId()
  const textId = useId()

  useTourKeys(at, steps.length, setAt, onClose)
  const nextRef = useFocusWhileOpen()

  return (
    <>
      <Spotlight target={target} />
      <TourCard step={step} target={target} labelledBy={titleId} describedBy={textId}>
        <h2 id={titleId}>{step.title}</h2>
        <p id={textId}>{step.text}</p>
        <div className="tour-foot">
          <span className="tour-count" aria-hidden="true">
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
            ref={nextRef}
            size="sm"
            variant="primary"
            shortcut={['→']}
            onClick={() => (last ? onClose() : setAt(at + 1))}
            title={last ? 'Done (→)' : 'Next (→)'}
          >
            {last ? 'Done' : 'Next'}
          </Button>
        </div>
      </TourCard>
      <div className="sr-only" aria-live="polite">
        Step {at + 1} of {steps.length}: {step.title}
      </div>
    </>
  )
}

/** The card: anchored next to the target with an arrow, or centred when there is none on screen. */
function TourCard({
  step,
  target,
  labelledBy,
  describedBy,
  children,
}: {
  step: TourStep
  target: Element | null
  labelledBy: string
  describedBy: string
  children: ReactNode
}) {
  const arrowRef = useRef<HTMLDivElement>(null)
  const { refs, floatingStyles, placement, middlewareData, isPositioned } = useFloating({
    elements: { reference: target },
    placement: step.placement ?? 'bottom',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate, // follows scrolling, resizing and the target's own size changes
    middleware: [
      offset(GAP),
      flip({ padding: EDGE }),
      shift({ padding: EDGE }),
      arrow({ element: arrowRef, padding: 14 }),
      hide({ strategy: 'referenceHidden' }),
    ],
  })
  const anchored = target !== null && !middlewareData.hide?.referenceHidden
  const side = placement.split('-')[0] as 'top' | 'bottom' | 'left' | 'right'
  const tip = middlewareData.arrow

  return (
    <section
      ref={refs.setFloating}
      className={anchored ? 'tour' : 'tour is-centred'}
      data-side={anchored ? side : undefined}
      data-ready={!anchored || isPositioned ? '' : undefined}
      style={anchored ? floatingStyles : undefined}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {anchored && (
        <div
          ref={arrowRef}
          className="tour-arrow"
          aria-hidden="true"
          style={{ left: tip?.x != null ? tip.x : undefined, top: tip?.y != null ? tip.y : undefined }}
        />
      )}
      {children}
    </section>
  )
}

/** Dims the screen except for a rounded window around the target; the whole screen when there is none. */
function Spotlight({ target }: { target: Element | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<DOMRect | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!target || !el) return setBox(null)
    return autoUpdate(target, el, () => setBox(target.getBoundingClientRect()))
  }, [target])
  const view = { width: window.innerWidth, height: window.innerHeight }
  const shown = box && onScreen(box, view)
  return (
    <div
      ref={ref}
      className={shown ? 'tour-spot' : 'tour-spot is-full'}
      style={shown ? spotlightBox(box, view) : undefined}
      aria-hidden="true"
    />
  )
}

/** The element the step points at: found again whenever the page changes (rows load, the cursor moves). */
function useStepTarget(step: TourStep): Element | null {
  const [target, setTarget] = useState<Element | null>(() => findTarget(step.targets))
  useEffect(() => {
    let frame = 0
    const resolve = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setTarget(findTarget(step.targets)))
    }
    setTarget(findTarget(step.targets))
    const observer = new MutationObserver(resolve)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    window.addEventListener('resize', resolve) // a breakpoint can hide or show a target
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', resolve)
    }
  }, [step])
  useEffect(() => {
    if (!target) return
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
  }, [target])
  return target
}

/** → / ← / Esc for the tour, before the app's own shortcuts (Esc there closes a call). */
function useTourKeys(at: number, count: number, setAt: (n: number) => void, onClose: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return // arrows move the caret there
      const next = tourKey(e.key, at, count)
      if (next === null) return
      e.preventDefault()
      e.stopPropagation()
      if (next === 'close') onClose()
      else setAt(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [at, count, setAt, onClose])
}

/** Focus starts on Next (Enter moves on, a screen reader reads the step) and goes back where it was after. */
function useFocusWhileOpen() {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let before: HTMLElement | null = null
    // A frame later: started from ⌘K, the closing palette first puts focus back where it was.
    const frame = requestAnimationFrame(() => {
      before = document.activeElement as HTMLElement | null
      ref.current?.focus({ preventScroll: true })
    })
    return () => {
      cancelAnimationFrame(frame)
      if (before?.isConnected && document.activeElement === ref.current) before.focus({ preventScroll: true })
    }
  }, [])
  return ref
}
