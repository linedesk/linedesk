// Shortcut tooltips: any element with a title like "Mark done (E)" shows the label and its keys
// on hover. Clicking such an element emits a hint so the app can say "Next time, press E".
export type ShortcutHint = { label: string; keys: string[] }
export const HINT_EVENT = 'linedesk-hint'

const SHOW_AFTER_MS = 550 // quick clicks never flash a tooltip
const WARM_MS = 400 // once one is visible, neighbours appear at once

export function parseShortcutTitle(title: string | null): ShortcutHint {
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(title ?? '')
  if (!m) return { label: title ?? '', keys: [] }
  const k = m[2]!.trim()
  const keys = /\s/.test(k) ? k.split(/\s+/) : /^[⌘⇧⌥]/.test(k) && k.length > 1 ? [k[0]!, k.slice(1)] : [k]
  return { label: m[1]!, keys }
}

function fill(tip: HTMLElement, info: ShortcutHint, description: string | null) {
  tip.textContent = ''
  tip.append(Object.assign(document.createElement('span'), { textContent: info.label }))
  for (const k of info.keys) tip.append(Object.assign(document.createElement('kbd'), { textContent: k }))
  if (description)
    tip.append(Object.assign(document.createElement('div'), { className: 'kt-desc', textContent: description }))
}

function place(tip: HTMLElement, el: Element) {
  const r = el.getBoundingClientRect(),
    t = tip.getBoundingClientRect()
  const above = r.top - t.height - 6
  tip.style.top = `${above < 4 ? r.bottom + 6 : above}px`
  tip.style.left = `${Math.max(4, Math.min(window.innerWidth - t.width - 4, r.left + r.width / 2 - t.width / 2))}px`
}

/** Keys that only change another key (Shift, ⌘, the start of a screenshot shortcut) leave a tooltip up. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS'])
export const isModifierKey = (key: string) => MODIFIER_KEYS.has(key)

/**
 * Whether a scroll moved the element under the pointer: the page itself or one of its ancestors scrolled.
 * A list, transcript or text field elsewhere that scrolls (often by itself, as data syncs in) does not.
 */
export function scrollMoves(scrolled: EventTarget | null, el: Element): boolean {
  if (!scrolled || scrolled === el.ownerDocument || scrolled === el.ownerDocument?.defaultView) return true
  return typeof (scrolled as Node).contains === 'function' && (scrolled as Node).contains(el)
}

/**
 * Whether `next` is `previous` drawn again: React re-rendered or remounted the element under a resting
 * pointer, so the old one left the page and a new one with the same tooltip sits in its place.
 */
export function isRedrawOf(next: Element | null, previous: Element | null): boolean {
  return (
    !!next &&
    !!previous &&
    next !== previous &&
    !previous.isConnected &&
    next.getAttribute('data-sc') === previous.getAttribute('data-sc')
  )
}

/** The element whose tooltip applies to this event target, with its title moved to data-sc so the browser's own tooltip never shows. */
function tipTarget(target: EventTarget | null): Element | null {
  const el = (target as Element | null)?.closest?.('[title], [data-sc]') ?? null
  if (el?.hasAttribute('title')) {
    el.setAttribute('data-sc', el.getAttribute('title')!)
    el.removeAttribute('title')
  }
  return el
}

/** Install once at startup. */
export function installTooltips() {
  const tip = Object.assign(document.createElement('div'), { className: 'kt', hidden: true })
  tip.setAttribute('role', 'tooltip')
  document.body.append(tip)
  let current: Element | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let warmUntil = 0
  /**
   * Where the pointer was when a key, click, scroll or page change dismissed the tooltips.
   * Until the pointer really moves from there nothing shows: a page that re-renders under a
   * resting pointer (after `/` opens search, say) must not bring a tooltip back.
   */
  let dismissedAt: { x: number; y: number } | null = null
  let pointer = { x: -1, y: -1 }

  function hide(keepWarm: boolean) {
    clearTimeout(timer)
    // Hiding again right after (mouseout, then mouseover on the neighbour) keeps the warmth already there.
    if (!keepWarm) warmUntil = 0
    else if (!tip.hidden) warmUntil = Date.now() + WARM_MS
    current = null
    tip.hidden = true
  }
  function dismiss() {
    hide(false)
    dismissedAt = pointer
  }

  /** The tooltip element under the resting pointer now: after a re-render, a new one in the old one's place. */
  function underPointer(): Element | null {
    return tipTarget(document.elementFromPoint(pointer.x, pointer.y))
  }

  function consider(el: Element | null) {
    if (el === current) return
    if (el && isRedrawOf(el, current)) {
      // Same tooltip on the element that replaced it: stay up (or keep waiting), just follow it.
      current = el
      if (!tip.hidden) place(tip, el)
      return
    }
    hide(true)
    if (!el) return
    const info = parseShortcutTitle(el.getAttribute('data-sc'))
    if (!info.label && !info.keys.length) return
    current = el
    const show = () => {
      // `el`, or what a re-render put in its place since (taken over above, or found under the pointer now).
      const shown = current?.isConnected ? current : underPointer()
      if (shown !== el && !isRedrawOf(shown, el)) return
      current = shown
      fill(tip, info, shown!.getAttribute('data-desc'))
      tip.hidden = false
      place(tip, shown!)
    }
    if (Date.now() < warmUntil) show()
    else timer = setTimeout(show, SHOW_AFTER_MS)
  }

  /** Every mouse event carries the pointer position; a re-render under a resting pointer repeats the old one. */
  function track(e: MouseEvent): boolean {
    pointer = { x: e.clientX, y: e.clientY }
    if (dismissedAt && (dismissedAt.x !== pointer.x || dismissedAt.y !== pointer.y)) dismissedAt = null
    return !dismissedAt
  }
  document.addEventListener('mouseover', e => {
    if (track(e)) consider(tipTarget(e.target))
  })
  document.addEventListener('mousemove', e => {
    if (track(e)) consider(tipTarget(e.target))
  })
  document.addEventListener('mouseout', e => {
    if (!current || current.contains(e.relatedTarget as Node | null)) return
    if (isRedrawOf(tipTarget(e.relatedTarget), current)) return // the mouseover that follows takes it over
    hide(true)
  })
  document.addEventListener('click', e => {
    if (!e.isTrusted || e.detail === 0) return
    const el = (e.target as Element).closest?.('[data-sc], [title]')
    if (!el || el.closest('[data-no-hint]')) return
    const info = parseShortcutTitle(el.getAttribute('data-sc') ?? el.getAttribute('title'))
    if (info.keys.length) window.dispatchEvent(new CustomEvent<ShortcutHint>(HINT_EVENT, { detail: info }))
  })
  document.addEventListener('mousedown', dismiss, true)
  document.addEventListener(
    'keydown',
    e => {
      if (!isModifierKey(e.key)) dismiss()
    },
    true,
  )
  // A scroll elsewhere (a list or transcript as data syncs in) leaves the tooltip up; one that moves its
  // element dismisses it. With no tooltip pending any scroll does, so nothing pops up while the page slides.
  window.addEventListener(
    'scroll',
    e => {
      if (!current || scrollMoves(e.target, current)) dismiss()
    },
    true,
  )
  window.addEventListener('hashchange', dismiss) // another page or call
}
