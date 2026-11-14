import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createLoadingGate,
  FADE_MS,
  initialView,
  type LoadingView,
  MIN_SHOWN_MS,
  SHOW_AFTER_MS,
  SLOW_MS,
} from './loadingGate.ts'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function watch(loading: boolean) {
  const views: LoadingView[] = []
  const gate = createLoadingGate(loading, view => views.push(view))
  return { gate, views, phase: () => gate.view().phase }
}

test('content that is there at once shows at once, without a fade', () => {
  const { gate, views } = watch(false)
  expect(gate.view()).toEqual({ phase: 'content', fadeIn: false })
  expect(initialView(false)).toEqual({ phase: 'content', fadeIn: false })
  vi.advanceTimersByTime(SLOW_MS * 2)
  expect(views).toEqual([])
})

test('a fast load never shows the skeleton: the space is reserved, then the content fades in', () => {
  const { gate, views, phase } = watch(true)
  expect(phase()).toBe('reserve')
  vi.advanceTimersByTime(SHOW_AFTER_MS - 1)
  gate.set(false)
  expect(gate.view()).toEqual({ phase: 'content', fadeIn: true })
  vi.advanceTimersByTime(SLOW_MS)
  expect(views).toEqual([
    { phase: 'content', fadeIn: true },
    { phase: 'content', fadeIn: false },
  ])
})

test('the fade is only marked for a moment, so content that mounts later does not fade', () => {
  const { gate } = watch(true)
  gate.set(false)
  vi.advanceTimersByTime(FADE_MS - 1)
  expect(gate.view().fadeIn).toBe(true)
  vi.advanceTimersByTime(1)
  expect(gate.view()).toEqual({ phase: 'content', fadeIn: false })
})

test('a slower load shows the skeleton after the delay', () => {
  const { phase } = watch(true)
  vi.advanceTimersByTime(SHOW_AFTER_MS - 1)
  expect(phase()).toBe('reserve')
  vi.advanceTimersByTime(1)
  expect(phase()).toBe('skeleton')
})

test('a skeleton that showed stays for the minimum time, then the content fades in', () => {
  const { gate, phase } = watch(true)
  vi.advanceTimersByTime(SHOW_AFTER_MS + 20)
  gate.set(false)
  expect(phase()).toBe('skeleton')
  vi.advanceTimersByTime(MIN_SHOWN_MS - 21)
  expect(phase()).toBe('skeleton')
  vi.advanceTimersByTime(1)
  expect(gate.view()).toEqual({ phase: 'content', fadeIn: true })
})

test('a skeleton shown longer than the minimum goes as soon as the data is there', () => {
  const { gate, phase } = watch(true)
  vi.advanceTimersByTime(SHOW_AFTER_MS + MIN_SHOWN_MS + 500)
  gate.set(false)
  expect(phase()).toBe('content')
})

test('loading again while the skeleton is held keeps it, with no blink in between', () => {
  const { gate, views, phase } = watch(true)
  vi.advanceTimersByTime(SHOW_AFTER_MS)
  gate.set(false)
  vi.advanceTimersByTime(MIN_SHOWN_MS / 2)
  gate.set(true)
  vi.advanceTimersByTime(MIN_SHOWN_MS)
  expect(phase()).toBe('skeleton')
  expect(views.map(v => v.phase)).toEqual(['skeleton'])
  gate.set(false)
  expect(phase()).toBe('content')
})

test('loading that starts later goes through the same delay', () => {
  const { gate, phase } = watch(false)
  gate.set(true)
  expect(phase()).toBe('reserve')
  vi.advanceTimersByTime(SHOW_AFTER_MS)
  expect(phase()).toBe('skeleton')
})

test('repeating the same flag changes nothing and restarts no timer', () => {
  const { gate, phase } = watch(true)
  vi.advanceTimersByTime(SHOW_AFTER_MS - 10)
  gate.set(true)
  vi.advanceTimersByTime(10)
  expect(phase()).toBe('skeleton')
})

test('a load that never ends turns into a problem, never an endless skeleton', () => {
  const { gate, phase } = watch(true)
  vi.advanceTimersByTime(SLOW_MS - 1)
  expect(phase()).toBe('skeleton')
  vi.advanceTimersByTime(1)
  expect(phase()).toBe('slow')
  gate.set(false)
  expect(gate.view()).toEqual({ phase: 'content', fadeIn: true })
})

test('dispose stops every timer', () => {
  const { gate, views } = watch(true)
  gate.dispose()
  vi.advanceTimersByTime(SLOW_MS * 2)
  expect(views).toEqual([])
})
