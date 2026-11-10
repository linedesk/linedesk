import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextSpeed, recordingLength, registerPlayer, seekSeconds, togglePlayback } from './playback.ts'

describe('recording playback', () => {
  it('cycles the speed 1, 1.5, 2 and back', () => {
    expect([nextSpeed(1), nextSpeed(1.5), nextSpeed(2), nextSpeed(3)]).toEqual([1.5, 2, 1, 1])
  })
  it('turns a pointer position into seconds, clamped to the track', () => {
    expect(seekSeconds(150, 100, 200, 60)).toBe(15)
    expect(seekSeconds(50, 100, 200, 60)).toBe(0)
    expect(seekSeconds(400, 100, 200, 60)).toBe(60)
    expect(seekSeconds(150, 100, 0, 60)).toBe(0)
  })
  it('falls back to the call duration when the file reports no length', () => {
    expect(recordingLength(42.5, 96)).toBe(42.5)
    expect(recordingLength(Number.POSITIVE_INFINITY, 96)).toBe(96)
    expect(recordingLength(Number.NaN, null)).toBe(0)
  })
})

describe('keyboard toggle', () => {
  let unregister = () => {}
  afterEach(() => unregister())
  it('toggles the mounted player and reports whether there is one', () => {
    expect(togglePlayback()).toBe(false)
    const toggle = vi.fn()
    unregister = registerPlayer(toggle)
    expect(togglePlayback()).toBe(true)
    expect(toggle).toHaveBeenCalledOnce()
    unregister()
    expect(togglePlayback()).toBe(false)
  })
})
