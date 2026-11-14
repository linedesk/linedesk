import { describe, expect, test } from 'vitest'
import {
  clampCrop,
  cropOutput,
  cropSide,
  defaultCrop,
  imagePlacement,
  MAX_ZOOM,
  panCrop,
  zoomCrop,
} from './cropMath.ts'

const wide = { width: 1200, height: 800 }
const tall = { width: 400, height: 1000 }

describe('the first frame', () => {
  test('is the largest square, in the middle', () => {
    expect(defaultCrop(wide)).toEqual({ cx: 600, cy: 400, zoom: 1 })
    expect(cropOutput(wide, defaultCrop(wide), 512)).toEqual({ sx: 200, sy: 0, side: 800, out: 512 })
    expect(cropOutput(tall, defaultCrop(tall), 512)).toEqual({ sx: 0, sy: 300, side: 400, out: 400 })
  })

  test('fills the frame: the shorter side spans it, the image is centred', () => {
    expect(imagePlacement(wide, defaultCrop(wide), 280)).toEqual({ left: -70, top: 0, width: 420, height: 280 })
  })
})

describe('moving', () => {
  test('the picture follows the pointer: dragging right shows more of the left', () => {
    const moved = panCrop(wide, defaultCrop(wide), 35, 0, 280)
    // 800 image pixels over 280 frame pixels: 35 frame pixels are 100 image pixels.
    expect(moved.cx).toBeCloseTo(500)
    expect(moved.cy).toBe(400)
  })

  test('never past an edge', () => {
    expect(panCrop(wide, defaultCrop(wide), 10_000, 0, 280).cx).toBe(400)
    expect(panCrop(wide, defaultCrop(wide), -10_000, 0, 280).cx).toBe(800)
    // At zoom 1 a landscape image can't move up or down at all.
    expect(panCrop(wide, defaultCrop(wide), 0, 500, 280).cy).toBe(400)
  })
})

describe('zooming', () => {
  test('keeps the middle by default and stays within 1 and the most', () => {
    const zoomed = zoomCrop(wide, defaultCrop(wide), 2, 280)
    expect(zoomed).toEqual({ cx: 600, cy: 400, zoom: 2 })
    expect(cropSide(wide, zoomed.zoom)).toBe(400)
    expect(zoomCrop(wide, defaultCrop(wide), 0.2, 280).zoom).toBe(1)
    expect(zoomCrop(wide, defaultCrop(wide), 100, 280).zoom).toBe(MAX_ZOOM)
  })

  test('keeps the point under the pointer where it is', () => {
    const start = defaultCrop(wide)
    const at = { x: 70, y: 70 }
    const pointBefore = { x: start.cx + (at.x - 140) * (800 / 280), y: start.cy + (at.y - 140) * (800 / 280) }
    const zoomed = zoomCrop(wide, start, 2, 280, at)
    const side = cropSide(wide, 2)
    const pointAfter = { x: zoomed.cx + (at.x - 140) * (side / 280), y: zoomed.cy + (at.y - 140) * (side / 280) }
    expect(pointAfter.x).toBeCloseTo(pointBefore.x)
    expect(pointAfter.y).toBeCloseTo(pointBefore.y)
  })

  test('zooming out again pulls the square back inside the image', () => {
    const corner = panCrop(wide, zoomCrop(wide, defaultCrop(wide), 4, 280), 10_000, 10_000, 280)
    expect(corner).toEqual({ cx: 100, cy: 100, zoom: 4 })
    expect(zoomCrop(wide, corner, 1, 280)).toEqual({ cx: 400, cy: 400, zoom: 1 })
  })

  test('a tiny image zooms no further than one pixel', () => {
    expect(clampCrop({ width: 4, height: 3 }, { cx: 2, cy: 1.5, zoom: 8 }).zoom).toBe(3)
  })
})

describe('the saved square', () => {
  test('is the kept part at up to the stored size, never blown up', () => {
    const zoomed = zoomCrop(wide, defaultCrop(wide), 4, 280)
    expect(cropOutput(wide, zoomed, 512)).toEqual({ sx: 500, sy: 300, side: 200, out: 200 })
    expect(cropOutput({ width: 3000, height: 3000 }, { cx: 1500, cy: 1500, zoom: 1 }, 512).out).toBe(512)
  })

  test('a crop out of bounds is clamped before it is cut', () => {
    expect(cropOutput(wide, { cx: -50, cy: 9999, zoom: 1 }, 512)).toEqual({ sx: 0, sy: 0, side: 800, out: 512 })
  })
})
