import { expect, test } from 'vitest'
import { agentAway, agentStatus, publicHealth } from './admin-overview.ts'

test('the voice agent is not reported missing before it had its chance to check in', () => {
  const started = 1_000_000
  expect(agentStatus(started + 10_000, null, started)).toMatchObject({
    ok: true,
    message: expect.stringMatching(/Waiting/),
  })
  expect(agentAway(started + 10_000, null, started)).toBe(false)
  expect(agentStatus(started + 120_000, null, started)).toMatchObject({ ok: false })
  expect(agentAway(started + 120_000, null, started)).toBe(true)
  expect(agentStatus(started + 120_000, started + 100_000, started)).toMatchObject({ ok: true })
})

test('the public health check answers 503 only when the voice agent is away, and 200 without LiveKit', () => {
  const started = 1_000_000
  const env = { LIVEKIT_URL: 'ws://livekit:7880' }
  expect(publicHealth(env, started + 10_000, null, started)).toEqual({ status: 200, body: { ok: true, agent: 'ok' } })
  expect(publicHealth(env, started + 120_000, null, started)).toEqual({
    status: 503,
    body: { ok: false, agent: 'away' },
  })
  expect(publicHealth(env, started + 120_000, started + 100_000, started)).toEqual({
    status: 200,
    body: { ok: true, agent: 'ok' },
  })
  expect(publicHealth({}, started + 120_000, null, started)).toEqual({ status: 200, body: { ok: true, agent: 'off' } })
})
