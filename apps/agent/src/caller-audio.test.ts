import { EventEmitter } from 'node:events'
import { ParticipantKind, RoomEvent, TrackKind, type RemoteParticipant, type RemoteTrack } from '@livekit/rtc-node'
import { expect, test } from 'vitest'
import { callerAudioOpen } from './caller-audio.ts'

const audio = { kind: TrackKind.KIND_AUDIO } as RemoteTrack
const caller = (kind: ParticipantKind, tracks: RemoteTrack[] = []) =>
  ({
    identity: 'caller',
    kind,
    trackPublications: new Map(tracks.map((track, i) => [`t${i}`, { track }])),
  }) as unknown as RemoteParticipant

/** Frames that arrive when `send` is called; `cancelled` tells whether the reader was let go. */
function frames() {
  let send = () => {}
  const state = { cancelled: false, send: () => send() }
  const framesOf = () => ({
    getReader: () => ({
      read: () => new Promise<unknown>(resolve => (send = () => resolve({ done: false }))),
      cancel: async () => {
        state.cancelled = true
      },
    }),
  })
  return { state, framesOf }
}

const settled = async (p: Promise<void>) => {
  let done = false
  void p.then(() => (done = true))
  await new Promise(resolve => setTimeout(resolve, 0))
  return done
}

test('a browser caller can hear at once', async () => {
  const room = new EventEmitter() as never
  expect(await settled(callerAudioOpen(room, Promise.resolve(caller(ParticipantKind.STANDARD))))).toBe(true)
})

test('a phone caller can hear once their first audio arrives, on a track they already had', async () => {
  const room = new EventEmitter() as never
  const { state, framesOf } = frames()
  const open = callerAudioOpen(room, Promise.resolve(caller(ParticipantKind.SIP, [audio])), framesOf)
  expect(await settled(open)).toBe(false)
  state.send()
  expect(await settled(open)).toBe(true)
  expect(state.cancelled).toBe(true)
})

test('a phone caller whose track comes later; other participants do not count', async () => {
  const room = new EventEmitter()
  const { state, framesOf } = frames()
  const open = callerAudioOpen(room as never, Promise.resolve(caller(ParticipantKind.SIP)), framesOf)
  await settled(open)
  room.emit(RoomEvent.TrackSubscribed, audio, {}, { identity: 'someone else' })
  state.send()
  expect(await settled(open)).toBe(false)
  room.emit(RoomEvent.TrackSubscribed, audio, {}, { identity: 'caller' })
  state.send()
  expect(await settled(open)).toBe(true)
  expect(room.listenerCount(RoomEvent.TrackSubscribed)).toBe(0)
})

test('the room closing or no caller never holds the greeting', async () => {
  const room = new EventEmitter()
  const open = callerAudioOpen(room as never, Promise.resolve(caller(ParticipantKind.SIP)), frames().framesOf)
  await settled(open)
  room.emit(RoomEvent.Disconnected)
  expect(await settled(open)).toBe(true)
  expect(await settled(callerAudioOpen(room as never, Promise.reject(new Error('gone'))))).toBe(true)
})
