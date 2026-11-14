// When a loading area shows its skeleton (docs/design-principles.md, "Loading"): not at all for a load
// that is done within SHOW_AFTER_MS (no flash), and once shown for at least MIN_SHOWN_MS (no flicker).
// Pure timing, no React: ui/LoadStates.tsx `useLoading` drives it, loadingGate.test.ts checks it.

/** A load done this fast shows no skeleton at all: the space stays reserved, but empty. */
export const SHOW_AFTER_MS = 180
/** A skeleton that did show stays this long, so it never blinks. */
export const MIN_SHOWN_MS = 320
/** Still loading after this long: say so (LoadProblem with Try again) instead of an endless skeleton. */
export const SLOW_MS = 12_000
/** How long content that arrived after a wait is marked as fading in (the fade itself is 140 ms, app.css `ld-in`). */
export const FADE_MS = 200

/**
 * `reserve`: loading, the skeleton holds the space but is not visible yet. `skeleton`: loading (or held
 * for MIN_SHOWN_MS), the skeleton is visible. `slow`: still loading after SLOW_MS. `content`: loaded.
 */
export type LoadingPhase = 'reserve' | 'skeleton' | 'slow' | 'content'

export type LoadingView = {
  phase: LoadingPhase
  /**
   * The content just arrived after a wait: it fades in (true for FADE_MS, then false again, so content
   * that mounts later, like rows scrolled into view, does not fade). Content that was there at once never does.
   */
  fadeIn: boolean
}

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
  now: () => number
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: id => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

/** The first view, before any timer ran: what a component renders on its first frame. */
export const initialView = (loading: boolean): LoadingView => ({
  phase: loading ? 'reserve' : 'content',
  fadeIn: false,
})

/**
 * Follows one area's `loading` flag over time and reports each change of view. Call `set` whenever the flag
 * may have changed (repeating the same value is fine) and `dispose` when the area goes away.
 */
export function createLoadingGate(loading: boolean, onChange: (view: LoadingView) => void, timers = realTimers) {
  let view = initialView(loading)
  let isLoading = false
  let shownAt = 0
  let showTimer: unknown = null
  let slowTimer: unknown = null
  let hideTimer: unknown = null
  let fadeTimer: unknown = null

  const clear = (id: unknown) => id !== null && timers.clearTimeout(id)
  const emit = (next: LoadingView) => {
    if (next.phase === view.phase && next.fadeIn === view.fadeIn) return
    view = next
    onChange(view)
  }
  const reveal = () => {
    showTimer = null
    shownAt = timers.now()
    emit({ phase: 'skeleton', fadeIn: false })
  }
  const arrive = () => {
    emit({ phase: 'content', fadeIn: true })
    fadeTimer = timers.setTimeout(() => {
      fadeTimer = null
      emit({ phase: 'content', fadeIn: false })
    }, FADE_MS)
  }
  const finish = () => {
    hideTimer = null
    arrive()
  }

  function start() {
    clear(hideTimer)
    clear(fadeTimer)
    hideTimer = fadeTimer = null
    if (view.phase === 'content') emit({ phase: 'reserve', fadeIn: false })
    if (view.phase === 'reserve' && showTimer === null) showTimer = timers.setTimeout(reveal, SHOW_AFTER_MS)
    if (slowTimer === null)
      slowTimer = timers.setTimeout(() => {
        slowTimer = null
        clear(showTimer)
        showTimer = null
        emit({ phase: 'slow', fadeIn: false })
      }, SLOW_MS)
  }

  function stop() {
    clear(showTimer)
    clear(slowTimer)
    showTimer = slowTimer = null
    if (view.phase === 'reserve' || view.phase === 'slow') return arrive()
    if (view.phase !== 'skeleton' || hideTimer !== null) return
    const left = MIN_SHOWN_MS - (timers.now() - shownAt)
    if (left <= 0) finish()
    else hideTimer = timers.setTimeout(finish, left)
  }

  function set(next: boolean) {
    if (next === isLoading) return
    isLoading = next
    if (next) start()
    else stop()
  }

  set(loading)
  return {
    set,
    view: () => view,
    dispose() {
      clear(showTimer)
      clear(slowTimer)
      clear(hideTimer)
      clear(fadeTimer)
      showTimer = slowTimer = hideTimer = fadeTimer = null
    },
  }
}
