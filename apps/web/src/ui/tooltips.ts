// Shortcut tooltips: any element with a title like "Mark done (E)" shows the label and its keys
// on hover. Clicking such an element emits a hint so the app can say "Next time, press E".
export type ShortcutHint = { label: string; keys: string[] }
export const HINT_EVENT = 'callfront-hint'

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
  if (description) tip.append(Object.assign(document.createElement('div'), { className: 'kt-desc', textContent: description }))
}

function place(tip: HTMLElement, el: Element) {
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect()
  const above = r.top - t.height - 6
  tip.style.top = `${above < 4 ? r.bottom + 6 : above}px`
  tip.style.left = `${Math.max(4, Math.min(window.innerWidth - t.width - 4, r.left + r.width / 2 - t.width / 2))}px`
}

/** The element whose tooltip applies to this event target, with its title moved to data-sc so the browser's own tooltip never shows. */
function tipTarget(target: EventTarget | null): Element | null {
  const el = (target as Element | null)?.closest?.('[title], [data-sc]') ?? null
  if (el?.hasAttribute('title')) { el.setAttribute('data-sc', el.getAttribute('title')!); el.removeAttribute('title') }
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
    warmUntil = keepWarm && !tip.hidden ? Date.now() + WARM_MS : 0
    current = null
    tip.hidden = true
  }
  function dismiss() {
    hide(false)
    dismissedAt = pointer
  }

  function consider(el: Element | null) {
    if (el === current) return
    hide(true)
    if (!el) return
    const info = parseShortcutTitle(el.getAttribute('data-sc'))
    if (!info.label && !info.keys.length) return
    current = el
    const show = () => {
      if (current !== el || !document.contains(el)) return
      fill(tip, info, el.getAttribute('data-desc'))
      tip.hidden = false
      place(tip, el)
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
  document.addEventListener('mouseover', e => { if (track(e)) consider(tipTarget(e.target)) })
  document.addEventListener('mousemove', e => {
    if (track(e)) consider(tipTarget(e.target))
    else if (current && !current.isConnected) hide(false) // its element was re-rendered away
  })
  document.addEventListener('mouseout', e => { if (current && !current.contains(e.relatedTarget as Node | null)) hide(true) })
  document.addEventListener('click', e => {
    if (!e.isTrusted || e.detail === 0) return
    const el = (e.target as Element).closest?.('[data-sc], [title]')
    if (!el) return
    const info = parseShortcutTitle(el.getAttribute('data-sc') ?? el.getAttribute('title'))
    if (info.keys.length) window.dispatchEvent(new CustomEvent<ShortcutHint>(HINT_EVENT, { detail: info }))
  })
  document.addEventListener('mousedown', dismiss, true)
  document.addEventListener('keydown', dismiss, true)
  window.addEventListener('scroll', dismiss, true)
  window.addEventListener('hashchange', dismiss) // another page or call
}
