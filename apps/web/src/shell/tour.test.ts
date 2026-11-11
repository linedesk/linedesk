import { expect, test, vi } from 'vitest'
import { findTarget, finishTour, onScreen, spotlightBox, queueTour, tourDue, tourKey, tourSteps } from './tour.ts'

test('five short steps: inbox, a call, assign and finish, settings, the rest', () => {
  const steps = tourSteps('Ava')
  expect(steps.map(s => s.title)).toEqual([
    'Your inbox',
    'Open a call',
    'Assign and finish',
    'Settings',
    'Everything else',
  ])
  expect(steps[0]!.text).toContain('Ava')
})

test('→ moves on and closes after the last step, ← goes back, Esc closes, other keys stay with the app', () => {
  expect(tourKey('ArrowRight', 0, 5)).toBe(1)
  expect(tourKey('ArrowRight', 4, 5)).toBe('close')
  expect(tourKey('ArrowLeft', 0, 5)).toBe(0)
  expect(tourKey('ArrowLeft', 3, 5)).toBe(2)
  expect(tourKey('Escape', 2, 5)).toBe('close')
  for (const key of ['Enter', 'j', 'e', 'a']) expect(tourKey(key, 1, 5)).toBeNull()
})

test('due once in the workspace whose onboarding finished in this browser', () => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  })
  expect(tourDue('ws-1')).toBe(false)
  queueTour('ws-1')
  expect(tourDue('ws-1')).toBe(true)
  expect(tourDue('ws-2')).toBe(false)
  finishTour()
  expect(tourDue('ws-1')).toBe(false)
  vi.unstubAllGlobals()
})

test('every step but the last points at something on the inbox; the last points at the shortcut hints', () => {
  const steps = tourSteps('Ava')
  for (const step of steps) expect(step.targets?.length).toBeGreaterThan(0)
  expect(steps[2]!.targets![0]).toContain('.is-cursor .r-acts') // Done and Remind buttons of the call under the cursor
  expect(steps.at(-1)!.targets![0]).toContain('.ib-hint')
})

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
})
const element = (b: ReturnType<typeof box>) => ({ getBoundingClientRect: () => b }) as unknown as Element

test('the first target that is rendered wins; hidden ones (no box) and missing ones are skipped', () => {
  const hidden = element(box(0, 0, 0, 0))
  const row = element(box(0, 100, 800, 48))
  const page = new Map<string, Element>([
    ['.is-cursor .r-acts', hidden],
    ['.row', row],
  ])
  const root = { querySelector: (s: string) => page.get(s) ?? null } as Pick<Document, 'querySelector'>
  expect(findTarget(['.is-cursor .r-acts', '.missing', '.row'], root)).toBe(row)
  expect(findTarget(['.missing'], root)).toBeNull()
  expect(findTarget(undefined, root)).toBeNull()
})

test('a target is on screen when some of it is inside the window', () => {
  const view = { width: 1000, height: 800 }
  expect(onScreen(box(10, 10, 100, 40), view)).toBe(true)
  expect(onScreen(box(-50, 790, 100, 40), view)).toBe(true) // partly visible
  expect(onScreen(box(10, 900, 100, 40), view)).toBe(false) // below the fold
  expect(onScreen(box(10, -60, 100, 40), view)).toBe(false) // scrolled past
  expect(onScreen(box(10, 10, 0, 0), view)).toBe(false)
})

test('the spotlight leaves room around the target and stays inside the window', () => {
  const view = { width: 1000, height: 800 }
  expect(spotlightBox(box(100, 100, 40, 20), view)).toEqual({ left: 94, top: 94, width: 52, height: 32 })
  expect(spotlightBox(box(0, 120, 1000, 48), view)).toEqual({ left: 4, top: 114, width: 992, height: 60 }) // a full-width row
})
