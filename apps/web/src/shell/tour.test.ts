import { expect, test, vi } from 'vitest'
import { finishTour, queueTour, tourDue, tourKey, tourSteps } from './tour.ts'

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
