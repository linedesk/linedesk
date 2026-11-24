import { expect, test, vi } from 'vitest'
import {
  dialogOpen,
  findTarget,
  finishTour,
  onScreen,
  queueTour,
  spotlightBox,
  tourDue,
  tourKey,
  tourStartsNow,
  tourSteps,
} from './tour.ts'

test('four short steps about the job: calls that need you, a call, handling it, the rest', () => {
  const steps = tourSteps('Ava')
  expect(steps.map(s => s.title)).toEqual([
    'Calls that need you',
    'Open a call',
    'Handled it? Mark it done',
    'Everything else',
  ])
  expect(steps[0]!.text).toContain('Ava')
})

test('the text teaches the job; keys only in their own line', () => {
  for (const step of tourSteps('Ava')) {
    expect(step.text).not.toMatch(/\b[JKEHZC]\b|Enter|Esc|⌘K/)
    expect(step.keys).toMatch(/^Keys: /)
  }
  expect(tourSteps('Ava')[2]!.keys).toBe('Keys: C call back · E done · H remind · A assign · Z undo')
})

test('alone in the workspace, the handle step names no A (nobody to assign to)', () => {
  const alone = tourSteps('Ava', false)[2]!
  expect(alone.title).toBe('Handled it? Mark it done')
  expect(alone.keys).not.toContain('A assign')
  expect(alone.text).not.toContain('assign')
  expect(tourSteps('Ava', true)[2]!.text).toContain('assign it to someone')
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

test('queued after onboarding, it waits for the first call in the inbox, then starts once', () => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  })
  expect(tourStartsNow('ws-1', 3)).toBe(false) // not queued: never on its own
  queueTour('ws-1')
  expect(tourStartsNow('ws-1', 0)).toBe(false) // empty inbox: the checklist first, the tour waits
  expect(tourDue('ws-1')).toBe(true) // still queued
  expect(tourStartsNow('ws-2', 1)).toBe(false) // another workspace's inbox
  expect(tourStartsNow('ws-1', 1)).toBe(true) // a call shows up (real or sample)
  finishTour() // started: Workspace finishes it at once
  expect(tourStartsNow('ws-1', 5)).toBe(false) // only once
  vi.unstubAllGlobals()
})

test('every step but the last points at something on the inbox; the last points at the menu', () => {
  const steps = tourSteps('Ava')
  for (const step of steps) expect(step.targets?.length).toBeGreaterThan(0)
  expect(steps[2]!.targets![0]).toContain('.is-cursor .r-acts') // Done and Remind buttons of the call under the cursor
  expect(steps.at(-1)!.targets![0]).toBe('.menu-btn')
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

test('the tour waits while a dialog is open: New workspace, ⌘K, the shortcut sheet (LIN-161)', () => {
  // A page of elements by their attributes, matched against attribute selectors like [role="dialog"][aria-modal="true"].
  const page = (...elements: Record<string, string>[]) => ({
    querySelector: (selectors: string) =>
      selectors
        .split(',')
        .some(selector =>
          elements.some(attrs =>
            [...selector.matchAll(/\[([a-z-]+)="([^"]*)"\]/g)].every(([, name, value]) => attrs[name!] === value),
          ),
        )
        ? ({} as Element)
        : null,
  })
  const tourCard = { role: 'dialog', 'aria-modal': 'false' }
  expect(dialogOpen(page())).toBe(false)
  // The tour's own card is a dialog too, but not a modal one: it never pauses itself.
  expect(dialogOpen(page(tourCard))).toBe(false)
  expect(dialogOpen(page(tourCard, { role: 'dialog', 'aria-modal': 'true' }))).toBe(true) // New workspace, ⌘K, ?
  expect(dialogOpen(page({ role: 'alertdialog' }))).toBe(true)
})
