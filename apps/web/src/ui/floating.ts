// Lists and menus that open from a control (Select, the searchable pickers, MenuButton) float above everything:
// the open list is shown in the browser's top layer (popover="manual"), so a dialog's or a panel's scrolling body
// never cuts it off, and it is placed against its control with position: fixed. It stays in the DOM where React
// renders it, so focus traps, clicks outside, Esc and Tab keep working as for any element inside the dialog.
import { type RefObject, useLayoutEffect, useRef } from 'react'
import './controls.css'

export type AnchorRect = { top: number; bottom: number; left: number; right: number; width: number }

export type PlaceInput = {
  /** The control the list opens from (getBoundingClientRect). */
  anchor: AnchorRect
  viewport: { width: number; height: number }
  /** The list's full height without a limit (scrollHeight). */
  contentHeight: number
  /** The width the list's content needs at its least width (scrollWidth); only used when `match` is off. */
  listWidth: number
  /** The list is exactly as wide as the control (a combobox under its field). */
  match?: boolean
  /** Without `match`: at least this wide, and never narrower than the control. */
  minWidth?: number
  /** Which edge of the control the list lines up with. */
  align?: 'start' | 'end'
  /** The tallest the list may be (its CSS max-height); less when the window has no room. */
  maxHeight?: number
  /** Space between control and list. */
  gap?: number
  /** Space kept free at the window's edges. */
  margin?: number
}

export type Placement = {
  side: 'below' | 'above'
  /** Below: the list's top edge. */
  top?: number
  /** Above: the distance of the list's bottom edge from the window's bottom, so it stays attached as it shrinks. */
  bottom?: number
  left: number
  width: number
  maxHeight: number
}

/**
 * Where an open list goes: below its control, or above when it does not fit below and there is more room above.
 * Its height is limited to the room on that side, its width follows the control and it stays inside the window.
 */
export function placeList({
  anchor,
  viewport,
  contentHeight,
  listWidth,
  match = false,
  minWidth = 0,
  align = 'start',
  maxHeight = 280,
  gap = 4,
  margin = 8,
}: PlaceInput): Placement {
  const below = viewport.height - anchor.bottom - gap - margin
  const above = anchor.top - gap - margin
  const wanted = Math.min(contentHeight, maxHeight)
  const side = below >= wanted || below >= above ? 'below' : 'above'
  const room = Math.max(0, Math.floor(side === 'below' ? below : above))
  const maxH = Math.min(maxHeight, room)

  const widest = Math.max(0, viewport.width - 2 * margin)
  const width = Math.min(widest, match ? anchor.width : Math.max(anchor.width, minWidth, listWidth))
  const start = align === 'end' ? anchor.right - width : anchor.left
  const left = Math.max(margin, Math.min(viewport.width - margin - width, start))

  const vertical = side === 'below' ? { top: anchor.bottom + gap } : { bottom: viewport.height - anchor.top + gap }
  return { side, ...vertical, left, width, maxHeight: maxH }
}

type Options = Pick<PlaceInput, 'match' | 'minWidth' | 'align' | 'gap'>

const supportsPopover = () => typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype

/** The CSS max-height of the list (px), read before the hook sets its own; none: no limit. */
function cssMaxHeight(el: HTMLElement): number {
  const v = Number.parseFloat(getComputedStyle(el).maxHeight)
  return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY
}

/**
 * While `open`, shows `list` in the top layer and keeps it placed against `anchor` (placeList): again on every
 * render, on any scroll outside the list, on resize and when either changes size. Give the list `popover="manual"`;
 * it leaves the top layer when it unmounts (the dialog closes) or `open` turns off.
 */
export function useAnchoredList(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
  options: Options = {},
) {
  const opts = useRef(options)
  opts.current = options
  const place = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    const el = list.current
    if (!open || !el) return
    if (supportsPopover() && el.hasAttribute('popover') && !el.matches(':popover-open')) el.showPopover()
    const limit = cssMaxHeight(el)
    Object.assign(el.style, { position: 'fixed', margin: '0', right: 'auto', zIndex: '80' })

    place.current = () => {
      const a = anchor.current
      if (!a || !el.isConnected) return
      const { match, minWidth } = opts.current
      const r = a.getBoundingClientRect()
      // The least width first: text that wraps wraps there, and what does not (a long label) shows in scrollWidth.
      const least = match ? r.width : Math.max(r.width, minWidth ?? 0)
      Object.assign(el.style, { width: `${least}px`, minWidth: '0px', maxWidth: 'none' })
      const p = placeList({
        ...opts.current,
        anchor: r,
        viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
        contentHeight: el.scrollHeight,
        listWidth: el.scrollWidth,
        maxHeight: limit,
      })
      Object.assign(el.style, {
        top: p.top === undefined ? 'auto' : `${p.top}px`,
        bottom: p.bottom === undefined ? 'auto' : `${p.bottom}px`,
        left: `${p.left}px`,
        width: `${p.width}px`,
        maxHeight: `${p.maxHeight}px`,
      })
      el.dataset.side = p.side
    }
    place.current()

    let frame = 0
    const later = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => place.current())
    }
    // A scroll inside the list moves nothing; the dialog body, a panel or the page scrolling moves the control.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && el.contains(e.target))) later()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', later)
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later)
    if (anchor.current) sizes?.observe(anchor.current)
    sizes?.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', later)
      sizes?.disconnect()
      place.current = () => {}
      if (supportsPopover() && el.isConnected && el.matches(':popover-open')) el.hidePopover()
    }
  }, [open, anchor, list])

  // What is in the list changes as the user types: placed again before the browser paints.
  useLayoutEffect(() => {
    if (open) place.current()
  })
}
