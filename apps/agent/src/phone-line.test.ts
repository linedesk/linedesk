import { EventEmitter } from 'node:events'
import { ParticipantKind, RoomEvent, TrackKind, type RemoteParticipant } from '@livekit/rtc-node'
import { expect, test } from 'vitest'
import { phoneLineOpen } from './phone-line.ts'

const caller = (kind: ParticipantKind) => Promise.resolve({ kind } as RemoteParticipant)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const settled = async (p: Promise<void>) => {
  let done = false
  void p.then(() => (done = true))
  await wait(0)
  return done
}

test('a browser caller can hear at once', async () => {
  expect(await settled(phoneLineOpen(new EventEmitter() as never, caller(ParticipantKind.STANDARD)))).toBe(true)
})

test("a phone caller's line opens the set time after the agent's audio is subscribed", async () => {
  const room = new EventEmitter()
  const open = phoneLineOpen(room as never, caller(ParticipantKind.SIP), 30)
  await wait(50)
  expect(await settled(open)).toBe(false)
  room.emit(RoomEvent.LocalTrackSubscribed, { kind: TrackKind.KIND_VIDEO })
  room.emit(RoomEvent.LocalTrackSubscribed, { kind: TrackKind.KIND_AUDIO })
  expect(await settled(open)).toBe(false)
  await wait(40)
  expect(await settled(open)).toBe(true)
  expect(room.listenerCount(RoomEvent.LocalTrackSubscribed)).toBe(0)
})

test('the pickup may come before the caller is known', async () => {
  const room = new EventEmitter()
  let join: (p: RemoteParticipant) => void = () => {}
  const open = phoneLineOpen(room as never, new Promise(resolve => (join = resolve)), 10)
  room.emit(RoomEvent.LocalTrackSubscribed, { kind: TrackKind.KIND_AUDIO })
  join({ kind: ParticipantKind.SIP } as RemoteParticipant)
  await wait(30)
  expect(await settled(open)).toBe(true)
})

test('the room closing or no caller never holds the greeting', async () => {
  const room = new EventEmitter()
  const open = phoneLineOpen(room as never, caller(ParticipantKind.SIP))
  room.emit(RoomEvent.Disconnected)
  expect(await settled(open)).toBe(true)
  expect(await settled(phoneLineOpen(room as never, Promise.reject(new Error('gone'))))).toBe(true)
})
