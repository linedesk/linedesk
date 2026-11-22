// The first-use tour: four steps, each a small card next to what it explains, with an arrow pointing at it
// and the rest of the screen dimmed around it. With nothing to point at (phones hide some of it) the card
// is centred. → or Enter next, ← back, Esc closes; every other key still works, so the shortcuts it names
// can be tried at once. Clicks reach only the card: a click elsewhere (another call, the menu) would leave the
// tour pointing at what is no longer there. While a dialog is open over it, the tour waits.
import { arrow, autoUpdate, flip, hide, offset, shift, useFloating } from '@floating-ui/react-dom'
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWriteAction } from '../settings/settings-api.ts'
import { useAssistantName, useRows } from '../store.tsx'
import { Button } from '../ui/kit.tsx'
import { dialogOpen, findTarget, onScreen, spotlightBox, type TourStep, tourKey, tourSteps } from './tour.ts'
import { useT } from '@linedesk/i18n/react'

const GAP = 12 // between the target and the card's arrow tip
const EDGE = 12 // the card keeps this far from the window's edges

export function Tour({ onClose: close, canAssign }: { onClose: () => void; canAssign: boolean }) {
  const t = useT()
  const assistant = useAssistantName()
  // The sample calls are the tour's material (added with the last onboarding step): its end removes them, done or
  // skipped, so the inbox starts clean for real calls (Janik, 2026-11-22). Removing them in the inbox stays possible.
  const samples = useRows('calls').some(c => c.source === 'sample' && !c.deleted_at)
  const write = useWriteAction()
  const onClose = () => {
    if (samples) void write('sample.remove', {}).catch(() => {})
    close()
  }
  const steps = useMemo(() => tourSteps(assistant, canAssign, samples), [assistant, canAssign, samples])
  const [at, setAt] = useState(0)
  const step = steps[at]!
  const last = at === steps.length - 1
  const target = useStepTarget(step)
  const titleId = useId()
  const textId = useId()

  // A dialog opened over the inbox (New workspace, ⌘K, ?): the tour steps aside until it closes, keys included.
  const paused = useDialogOpen()
  useTourKeys(at, steps.length, setAt, onClose, paused)
  const nextRef = useFocusWhileOpen(paused)

  if (paused) return null
  return (
    <>
      <ClickShield />
      <Spotlight target={target} />
      <TourCard step={step} target={target} labelledBy={titleId} describedBy={textId}>
        <h2 id={titleId}>{step.title}</h2>
        <p id={textId}>{step.text}</p>
        <div className="tour-foot">
          <span className="tour-count" aria-hidden="true">
            {t('shell.tour.count', { step: at + 1, steps: steps.length })}
          </span>
          <div className="tour-actions">
            <Button size="sm" variant="ghost" onClick={onClose} title={t('shell.tour.closeTip', { key: 'esc' })}>
              {last ? t('common.action.close') : t('shell.tour.skip')}
            </Button>
            {at > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAt(at - 1)}
                title={t('common.withKey', { label: t('shell.tour.back'), key: '←' })}
              >
                {t('shell.tour.back')}
              </Button>
            )}
            <Button
              ref={nextRef}
              size="sm"
              variant="primary"
              shortcut={['→']}
              onClick={() => (last ? onClose() : setAt(at + 1))}
              title={t('common.withKey', { label: last ? t('shell.tour.done') : t('shell.tour.next'), key: '→' })}
            >
              {last ? t('shell.tour.done') : t('shell.tour.next')}
            </Button>
          </div>
        </div>
      </TourCard>
      <div className="sr-only" aria-live="polite">
        {t('shell.tour.stepOf', { step: at + 1, steps: steps.length, title: step.title })}
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

/** Takes every click outside the card while the tour runs, and keeps focus on the card (no mousedown focus). */
function ClickShield() {
  return <div className="tour-shield" aria-hidden="true" onMouseDown={e => e.preventDefault()} />
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
function useTourKeys(at: number, count: number, setAt: (n: number) => void, onClose: () => void, paused: boolean) {
  useEffect(() => {
    if (paused) return // the dialog's own keys (Esc closes it, not the tour)
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
  }, [at, count, setAt, onClose, paused])
}

/** Whether a modal dialog is open anywhere on the page (dialogOpen), followed as dialogs open and close. */
function useDialogOpen(): boolean {
  const [open, setOpen] = useState(() => dialogOpen())
  useEffect(() => {
    const check = () => setOpen(dialogOpen())
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'aria-modal'],
    })
    return () => observer.disconnect()
  }, [])
  return open
}

/**
 * Focus starts on Next (Enter moves on, a screen reader reads the step) and goes back where it was after. While a
 * dialog has paused the tour, focus stays with the dialog; the tour takes it again once the dialog has closed.
 */
function useFocusWhileOpen(paused: boolean) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (paused) return
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
  }, [paused])
  return ref
}
