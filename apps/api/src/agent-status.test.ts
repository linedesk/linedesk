import { expect, test } from 'vitest'
import { agentAway, agentStatus } from './admin-overview.ts'

test('the voice agent is not reported missing before it had its chance to check in', () => {
  const started = 1_000_000
  expect(agentStatus(started + 10_000, null, started)).toMatchObject({ ok: true, message: expect.stringMatching(/Waiting/) })
  expect(agentAway(started + 10_000, null, started)).toBe(false)
  expect(agentStatus(started + 120_000, null, started)).toMatchObject({ ok: false })
  expect(agentAway(started + 120_000, null, started)).toBe(true)
  expect(agentStatus(started + 120_000, started + 100_000, started)).toMatchObject({ ok: true })
})
