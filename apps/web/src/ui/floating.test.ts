import { describe, expect, it } from 'vitest'
import { type AnchorRect, placeList } from './floating.ts'

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
