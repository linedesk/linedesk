import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { type AnchorRect, activeOptionScroll, keepingScroll, placeList } from './floating.ts'

const viewport = { width: 1280, height: 700 }
const field = (top: number, left = 400, width = 360, height = 36): AnchorRect => ({
  top,
  bottom: top + height,
  left,
  right: left + width,
  width,
})

describe('placeList', () => {
  it('opens below the control with room there, 4px under it', () => {
    const p = placeList({ anchor: field(100), viewport, contentHeight: 600, listWidth: 360, match: true })
    expect(p.side).toBe('below')
    expect(p.top).toBe(140)
    expect(p.bottom).toBeUndefined()
    expect(p.maxHeight).toBe(280)
  })

  it('stays below and shrinks to the room left when that is still more than above', () => {
    // 700 - 436 - 4 - 8 = 252 below, 400 - 12 = 388 above: a short list (200) still fits below.
    const short = placeList({ anchor: field(400), viewport, contentHeight: 200, listWidth: 360, match: true })
    expect(short.side).toBe('below')
    expect(short.maxHeight).toBe(252)
  })

  it('flips above when the list does not fit below and there is more room above', () => {
    const p = placeList({ anchor: field(600), viewport, contentHeight: 2000, listWidth: 360, match: true })
    expect(p.side).toBe('above')
    // Attached by its bottom edge 4px over the control, so it stays there as the list gets shorter.
    expect(p.bottom).toBe(700 - 600 + 4)
    expect(p.top).toBeUndefined()
    expect(p.maxHeight).toBe(280)
  })

  it('keeps the list below when below has more room, however little', () => {
    const tiny = { width: 1280, height: 200 }
    const p = placeList({ anchor: field(60), viewport: tiny, contentHeight: 2000, listWidth: 360, match: true })
    expect(p.side).toBe('below')
    expect(p.maxHeight).toBe(200 - 96 - 4 - 8)
  })

  it('limits the height to the room above in a short window', () => {
    const short = { width: 1280, height: 300 }
    const p = placeList({ anchor: field(200), viewport: short, contentHeight: 900, listWidth: 360, match: true })
    expect(p.side).toBe('above')
    expect(p.maxHeight).toBe(200 - 4 - 8)
  })

  it('uses the CSS max-height and never goes below zero', () => {
    const p = placeList({ anchor: field(100), viewport, contentHeight: 900, listWidth: 360, maxHeight: 340 })
    expect(p.maxHeight).toBe(340)
    const off = placeList({
      anchor: field(-200),
      viewport: { width: 1280, height: 100 },
      contentHeight: 900,
      listWidth: 0,
    })
    expect(off.maxHeight).toBeGreaterThanOrEqual(0)
  })

  it('is as wide as the control with match', () => {
    const p = placeList({ anchor: field(100, 400, 312), viewport, contentHeight: 100, listWidth: 900, match: true })
    expect(p.width).toBe(312)
    expect(p.left).toBe(400)
  })

  it('is at least as wide as the control and minWidth, wider when the content needs it', () => {
    const narrow = placeList({
      anchor: field(100, 400, 120),
      viewport,
      contentHeight: 100,
      listWidth: 0,
      minWidth: 240,
    })
    expect(narrow.width).toBe(240)
    const wide = placeList({
      anchor: field(100, 400, 120),
      viewport,
      contentHeight: 100,
      listWidth: 300,
      minWidth: 240,
    })
    expect(wide.width).toBe(300)
    const control = placeList({
      anchor: field(100, 400, 360),
      viewport,
      contentHeight: 100,
      listWidth: 0,
      minWidth: 240,
    })
    expect(control.width).toBe(360)
  })

  it('lines up with the control’s right edge for align end', () => {
    const p = placeList({
      anchor: field(100, 1000, 32),
      viewport,
      contentHeight: 100,
      listWidth: 0,
      minWidth: 180,
      align: 'end',
    })
    expect(p.left).toBe(1032 - 180)
  })

  it('stays inside the window horizontally', () => {
    const right = placeList({ anchor: field(100, 1200, 60), viewport, contentHeight: 100, listWidth: 0, minWidth: 240 })
    expect(right.left).toBe(1280 - 8 - 240)
    const left = placeList({
      anchor: field(100, 2, 32),
      viewport,
      contentHeight: 100,
      listWidth: 0,
      minWidth: 180,
      align: 'end',
    })
    expect(left.left).toBe(8)
    const phone = placeList({
      anchor: field(100, 16, 343),
      viewport: { width: 375, height: 700 },
      contentHeight: 100,
      listWidth: 900,
    })
    expect(phone.width).toBe(375 - 16)
    expect(phone.left).toBe(8)
  })
})

// LIN-532: the open list of calls at the same time jumped while it was scrolled with a wheel or trackpad.
describe('activeOptionScroll', () => {
  it('never scrolls to the option the pointer moved onto, so scrolling under a resting pointer cannot run on', () => {
    const scroll = activeOptionScroll()
    expect(scroll.scrolls(0)).toBe(true) // the list opens: the picked option is shown
    // A small wheel step moves option 4 under the pointer, then option 5: neither scrolls the list.
    scroll.pointer(4, 0)
    expect(scroll.scrolls(4)).toBe(false)
    scroll.pointer(5, 4)
    expect(scroll.scrolls(5)).toBe(false)
  })

  it('still scrolls when the keys move the active option, also right after the pointer moved it', () => {
    const scroll = activeOptionScroll()
    scroll.pointer(3, 0)
    expect(scroll.scrolls(3)).toBe(false)
    expect(scroll.scrolls(4)).toBe(true) // ArrowDown
    expect(scroll.scrolls(9)).toBe(true) // End
  })

  it('the pointer resting on the active option leaves the next key move scrolling', () => {
    const scroll = activeOptionScroll()
    scroll.pointer(2, 2) // no change, no move follows
    expect(scroll.scrolls(2)).toBe(true) // e.g. reopened on the same option
    scroll.pointer(7, 2)
    expect(scroll.scrolls(7)).toBe(false)
  })
})

describe('keepingScroll', () => {
  /** A list whose scroll the browser clamps to its content, which placing shrinks for a moment. */
  function list(content: number, height = 280) {
    let top = 0
    const el = {
      content,
      get scrollTop() {
        return top
      },
      set scrollTop(v: number) {
        top = Math.max(0, Math.min(v, el.content - height))
      },
    }
    return el
  }

  it('puts a list scrolled down back where it was after measuring shrank it', () => {
    const el = list(538)
    el.scrollTop = 200
    keepingScroll(el, () => {
      el.content = 328 // measuring: descriptions left out, the browser clamps the scroll to 48
      const was = el.scrollTop
      el.scrollTop = was
      el.content = 538
    })
    expect(el.scrollTop).toBe(200)
  })

  it('leaves the scroll alone when placing did not move it', () => {
    const el = list(538)
    el.scrollTop = 120
    let writes = 0
    const watched = {
      get scrollTop() {
        return el.scrollTop
      },
      set scrollTop(v: number) {
        writes++
        el.scrollTop = v
      },
    }
    keepingScroll(watched, () => {})
    expect(writes).toBe(0)
    expect(el.scrollTop).toBe(120)
  })
})

describe('lists that open from a control', () => {
  const SRC = join(import.meta.dirname, '..')
  const sources = (dir = SRC): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sources(path)
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative(SRC, path)] : []
    })
  const files = sources().map(path => ({ path, text: readFileSync(join(SRC, path), 'utf8') }))

  it('that keep the active option in view let the pointer move it only through useActiveOptionInView', () => {
    const direct = files
      .filter(f => f.text.includes('useActiveOptionInView(') && /onMouseEnter=\{\(\) => setActive\(/.test(f.text))
      .map(f => f.path)
    expect(direct, 'onMouseEnter={() => pointAt(i)}, pointAt from useActiveOptionInView (ui/floating.ts)').toEqual([])
  })

  it('scroll their active option into view only in useActiveOptionInView', () => {
    const own = files
      .filter(f => f.path !== join('ui', 'floating.ts') && /-\$\{active\}`\)\?\.scrollIntoView/.test(f.text))
      .map(f => f.path)
    expect(own, 'use useActiveOptionInView from ui/floating.ts').toEqual([])
  })
})
