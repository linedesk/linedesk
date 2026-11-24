import { EventEmitter } from 'node:events'
import { RoomEvent, TrackKind } from '@livekit/rtc-node'
import { expect, test, vi } from 'vitest'
import { describeSetup, greetingAfterPickup, setupTimer, watchAgentAudio } from './setup-timing.ts'

test('the greeting after pickup: from the audio subscribed to the greeting audio', () => {
  expect(greetingAfterPickup({ session: 300, 'audio subscribed': 350, 'greeting audio': 420 })).toBe(70)
  // The greeting was queued first and went out the moment the audio was subscribed.
  expect(greetingAfterPickup({ 'greeting audio': 350, 'audio subscribed': 350 })).toBe(0)
  expect(greetingAfterPickup({ session: 300, 'greeting audio': 420 })).toBeNull()
})

test('the log line lists the steps in the order they happened and the greeting after pickup', () => {
  const line = describeSetup(
    'call_1',
    Date.UTC(2026, 10, 18, 6, 54, 47, 623),
    'warm process after 5 ms',
    { connected: 159, 'greeting audio': 677, session: 303, 'audio subscribed': 290 },
    'cached',
  )
  expect(line).toBe(
    'setup call_1: job started 2026-11-18T06:54:47.623Z (warm process after 5 ms), connected +159 ms, audio subscribed +290 ms, session +303 ms, greeting audio +677 ms (greeting cached); greeting 387 ms after the audio was subscribed (phone: pickup)',
  )
})

test('a step keeps the time it was first marked', () => {
  let t = 1_000
  const timer = setupTimer(null, 1_000, () => t)
  t = 1_100
  timer.mark('audio subscribed')
  t = 1_900
  timer.mark('audio subscribed') // a re-subscription after a reconnect is not the pickup
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  timer.log('call_2')
  expect(log.mock.calls[0]![0]).toContain('audio subscribed +100 ms')
  log.mockRestore()
})

test("marks the agent's audio published and subscribed, not other tracks", () => {
  const room = new EventEmitter()
  const marks: string[] = []
  const stop = watchAgentAudio(room as never, step => marks.push(step))
  room.emit(RoomEvent.LocalTrackPublished, { kind: TrackKind.KIND_VIDEO })
  room.emit(RoomEvent.LocalTrackPublished, { kind: TrackKind.KIND_AUDIO })
  room.emit(RoomEvent.LocalTrackSubscribed, { kind: TrackKind.KIND_AUDIO })
  stop()
  room.emit(RoomEvent.LocalTrackSubscribed, { kind: TrackKind.KIND_AUDIO })
  expect(marks).toEqual(['audio published', 'audio subscribed'])
})
