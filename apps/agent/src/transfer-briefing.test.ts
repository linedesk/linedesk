// A transfer contact's briefing switch (TransferContact.briefing): with it on (or missing) the on-call person is briefed
// by an AI voice and decides; with it off the caller is put straight through once the phone is answered.
import { spokenLines } from '@linedesk/actions'
import type { TransferContact } from '@linedesk/db/types'
import { beforeEach, expect, test, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  forwarded: [] as string[],
  ringbackStopped: 0,
  deleted: [] as string[],
}))

vi.mock('@livekit/rtc-node', async importOriginal => {
  const actual = await importOriginal<typeof import('@livekit/rtc-node')>()
  const track = { kind: actual.TrackKind.KIND_AUDIO }
  class Room {
    name = ''
    remoteParticipants = new Map([
      ['on-call', { trackPublications: new Map([['a', { track }]]) }],
      ['caller', { trackPublications: new Map([['a', { track }]]) }],
    ])
    async connect() {}
    async disconnect() {}
    on() {}
    off() {}
  }
  return { ...actual, Room }
})
vi.mock('livekit-server-sdk', () => ({
  AccessToken: class {
    kind = ''
    addGrant() {}
    async toJwt() {
      return 'jwt'
    }
  },
  RoomServiceClient: class {
    async deleteRoom(name: string) {
      bridge.deleted.push(name)
    }
  },
}))
vi.mock('./audio-bridge.ts', () => ({
  playRingback: async () => async () => {
    bridge.ringbackStopped++
  },
  forwardAudio: async (_track: unknown, _into: unknown, name: string) => {
    bridge.forwarded.push(name)
    return async () => {}
  },
}))
vi.mock('./greeting-cache.ts', () => ({ synthesize: async () => null, audioStream: () => null }))
vi.mock('./pipeline.ts', () => ({ createStt: () => null, sttDetectsTurns: () => false }))

const { warmTransfer } = await import('./transfer-call.ts')
const { NotAnsweredError } = await import('./on-call-dialer.ts')
const { Room } = await import('@livekit/rtc-node')

beforeEach(() => {
  bridge.forwarded = []
  bridge.ringbackStopped = 0
  bridge.deleted = []
})

function setup(dial: (request: { briefed?: boolean; from?: string }) => Promise<void>) {
  const callerRoom = new Room() as unknown as InstanceType<typeof Room> & { name: string }
  callerRoom.name = 'call-1'
  let voices = 0
  const cleanups: (() => Promise<void>)[] = []
  return {
    voices: () => voices,
    cleanups,
    setup: {
      livekit: { url: 'ws://localhost:7880', apiKey: 'k', apiSecret: 's' },
      callerRoom,
      callerIdentity: 'caller',
      dialer: { dial },
      consult: {
        tts: () => {
          voices++
          return {} as never
        },
        stt: {} as never,
      },
      callerId: '+15035550100',
    } as never,
    hooks: (onConnecting: () => Promise<void> = async () => {}) => ({
      onBridgeEnded: () => {},
      addCleanup: (cleanup: () => Promise<void>) => void cleanups.push(cleanup),
      onConnecting,
    }),
  }
}

test('briefing off: the caller is put through once the phone is answered, with no voice on the on-call leg', async () => {
  const requests: { briefed?: boolean; from?: string }[] = []
  const t = setup(async request => void requests.push(request))
  const stopped: string[] = []
  const outcome = await warmTransfer(t.setup, null, new AbortController().signal, t.hooks(async () => void stopped.push('recording')))
  expect(outcome).toEqual({ result: 'connected' })
  // Dialled like any transfer, showing the same caller ID, but told nobody is briefed.
  expect(requests).toEqual([expect.objectContaining({ briefed: false, from: '+15035550100' })])
  // Nothing is said to the person: no voice is made for the consult leg.
  expect(t.voices()).toBe(0)
  // The recording stops before the bridge; then both directions are forwarded and the ringback stops.
  expect(stopped).toEqual(['recording'])
  expect(bridge.forwarded).toEqual(['on-call', 'caller'])
  expect(bridge.ringbackStopped).toBeGreaterThan(0)
})

test('briefing off: a recording that cannot be stopped means no bridge (fail closed), the on-call leg is hung up', async () => {
  const t = setup(async () => {})
  const outcome = await warmTransfer(
    t.setup,
    null,
    new AbortController().signal,
    t.hooks(async () => {
      throw new Error('egress down')
    }),
  )
  expect(outcome).toEqual({ result: 'failed' })
  expect(bridge.forwarded).toEqual([])
  await vi.waitFor(() => expect(bridge.deleted).toContain('call-1-oncall'))
})

test('briefing off: nobody answering is not answered, as with a briefing', async () => {
  const t = setup(async () => {
    throw new NotAnsweredError('rang out')
  })
  expect(await warmTransfer(t.setup, null, new AbortController().signal, t.hooks())).toEqual({ result: 'not_answered' })
  expect(bridge.forwarded).toEqual([])
})

test('briefing on: the consult voice is made and the dial says the person is briefed', async () => {
  const requests: { briefed?: boolean }[] = []
  const t = setup(async request => {
    requests.push(request)
    throw new NotAnsweredError('rang out')
  })
  const outcome = await warmTransfer(t.setup, 'Call from 503 555 0142 about a leak. Press 1 or say yes to take it, or press 2 or say no.', new AbortController().signal, t.hooks())
  expect(outcome).toEqual({ result: 'not_answered' })
  expect(requests).toEqual([expect.objectContaining({ briefed: true })])
  expect(t.voices()).toBe(1)
})

// The transfer tool hands each contact's own setting to the call: the briefing text, or null for none.
test('transfer_call briefs a contact with the briefing on or not set, and puts one with it off straight through', async () => {
  const warm = vi.fn(async () => ({ result: 'not_answered' as const }))
  vi.resetModules()
  vi.doMock('./transfer-call.ts', () => ({ warmTransfer: warm }))
  vi.doMock('./env.ts', () => ({ requireLivekitEnv: () => ({ LIVEKIT_URL: 'ws://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' }) }))
  vi.doMock('./busy-line.ts', () => ({ lineAudio: async () => Promise.reject(new Error('no voice in tests')) }))
  const { transferTool } = await import('./transfer-tool.ts')
  const { CallLog } = await import('./call-log.ts')
  const base: Omit<TransferContact, 'id' | 'name' | 'number'> = {
    condition: 'Urgent: a burst pipe',
    hours_only: false,
    ring_seconds: 25,
    if_no_answer: 'next',
    enabled: true,
  }
  const contacts = [
    { ...base, id: 'a', name: 'Mike', number: '+15035550199', briefing: true },
    { ...base, id: 'b', name: 'Owner', number: '+15035550188', briefing: false },
    { ...base, id: 'c', name: 'Sarah', number: '+15035550177' },
  ]
  const call = { callId: 'c1', workspaceId: 'w1', contact: { phone: '+15035550142', name: null }, caller: null, assistant: null, append: async () => {} } as never
  const tool = transferTool({
    ctx: { room: { on() {}, off() {} }, deleteRoom: async () => {}, addShutdownCallback() {} } as never,
    api: { run: async () => ({ data: {} }) } as never,
    call,
    log: new CallLog(call),
    speech: { consult: {} } as never,
    callerIdentity: Promise.resolve('caller'),
    contacts,
    lines: () => spokenLines('en'),
    dialerOf: async () => ({ dial: async () => {} }),
  })
  const session = { input: { setAudioEnabled() {} }, output: { setAudioEnabled() {} } }
  await (tool as unknown as { execute: (args: unknown, opts: unknown) => Promise<unknown> }).execute(
    { contacts: ['Mike'], caller_name: null, about: 'a burst pipe' },
    { ctx: { waitForPlayout: async () => {}, disallowInterruptions() {}, session } },
  )
  const briefings = warm.mock.calls.map(args => (args as unknown[])[1])
  expect(briefings).toEqual([
    'Call from 503 555 0142 about a burst pipe. Press 1 or say yes to take it, or press 2 or say no.',
    null,
    'Call from 503 555 0142 about a burst pipe. Press 1 or say yes to take it, or press 2 or say no.',
  ])
  vi.doUnmock('./transfer-call.ts')
  vi.doUnmock('./env.ts')
  vi.doUnmock('./busy-line.ts')
})
