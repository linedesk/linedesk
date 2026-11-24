import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextSpeed, recordingLength, recordingMissing, registerPlayer, seekSeconds, togglePlayback } from './playback.ts'

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
  it('tells a call without a recording file (404) from a recording that failed to load', async () => {
    const answering = (status: number) => vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch
    expect(await recordingMissing('/v1/calls/c1/recording', answering(404))).toBe(true)
    expect(await recordingMissing('/v1/calls/c1/recording', answering(409))).toBe(false)
    expect(await recordingMissing('/v1/calls/c1/recording', answering(206))).toBe(false)
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    expect(await recordingMissing('/v1/calls/c1/recording', offline)).toBe(false)
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
