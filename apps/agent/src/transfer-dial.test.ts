// The dial of a warm transfer: the API is asked right before dialling (destination policy and minutes checked again),
// and the dial uses the caller ID and the leg length the API answered.
import type { SipClient } from 'livekit-server-sdk'
import { describe, expect, test } from 'vitest'
import { ActionError, type ApiClient } from './api-client.ts'
import type { CallSession } from './call-session.ts'
import { sipDialer, transferLegSeconds } from './on-call-dialer.ts'
import { audioMs } from './transfer-call.ts'
import { startTransfer } from './transfer-tool.ts'

const call = { callId: 'call_1', workspaceId: 'ws_1' } as unknown as CallSession
const target = { to: '+4915112345678', name: 'Mike' }
const apiAnswering = (answer: () => unknown): Pick<ApiClient, 'run'> => ({
  run: async () => answer() as Awaited<ReturnType<ApiClient['run']>>,
})

describe('startTransfer: the API checks the destination again right before the dial', () => {
  test('allowed: the caller ID and the longest the leg may last', async () => {
    const api = apiAnswering(() => ({ ok: true, rows: {}, data: { callerId: '+493012345678', maxMinutes: 30 } }))
    expect(await startTransfer(api, call, target)).toEqual({
      refused: null,
      start: { callerId: '+493012345678', maxMinutes: 30 },
    })
  })

  test('a country the workspace may no longer call: refused, and only this contact (the plan goes on)', async () => {
    const api = apiAnswering(() => {
      throw new ActionError(
        'call.transfer',
        409,
        'transfer refused: Only numbers in the United States can take transferred calls.',
      )
    })
    expect(await startTransfer(api, call, target)).toMatchObject({ destination: true })
  })

  test("the day's minutes or another leg: refused for every contact", async () => {
    const api = apiAnswering(() => {
      throw new ActionError('call.transfer', 409, 'transfer limit reached: 120 minutes of transferred calls a day')
    })
    expect(await startTransfer(api, call, target)).toMatchObject({ destination: false })
  })

  test('an older API without data: the dial goes on as before', async () => {
    const api = apiAnswering(() => ({ ok: true, rows: {} }))
    expect(await startTransfer(api, call, target)).toEqual({ refused: null, start: {} })
  })
})

describe('sipDialer', () => {
  function fakeSip() {
    const requests: Record<string, unknown>[] = []
    const sip = {
      createSipParticipant: async (_trunk: string, _to: string, _room: string, options: Record<string, unknown>) => {
        requests.push(options)
        return {}
      },
    } as unknown as SipClient
    return { sip, requests }
  }

  test("dials with the API's caller ID and leg length, else the business number and the longest call", async () => {
    const { sip, requests } = fakeSip()
    const dialer = sipDialer({ sip, trunkId: 'ST_1', to: target.to, from: '+15035550142' })
    const signal = new AbortController().signal
    await dialer.dial({ room: 'r', identity: 'on-call', signal, from: '+493012345678', maxCallSeconds: 19 * 60 })
    await dialer.dial({ room: 'r', identity: 'on-call', signal })
    expect(requests[0]).toMatchObject({ fromNumber: '+493012345678', maxCallDuration: 19 * 60 })
    expect(requests[1]).toMatchObject({ fromNumber: '+15035550142', maxCallDuration: transferLegSeconds() })
  })

  test('the leg length is never above the longest call, nor below a minute', () => {
    expect(transferLegSeconds()).toBe(120 * 60)
    expect(transferLegSeconds(10_000_000)).toBe(120 * 60)
    expect(transferLegSeconds(5)).toBe(60)
  })
})

test('audioMs: how long a pre-rendered line plays', () => {
  expect(audioMs({ sampleRate: 24_000, channels: 1, samples: new Int16Array(48_000) })).toBe(2000)
  expect(audioMs({ sampleRate: 16_000, channels: 2, samples: new Int16Array(64_000) })).toBe(2000)
})
