import { expect, test } from 'vitest'
import type { CallTestFinding } from '@callfront/actions'
import { evaluateCall, formatReport } from './report.ts'
import { callerInstructions, parseTestCallerMetadata, scenarioNames, scenarios } from './scenarios.ts'

const finished: CallTestFinding = {
  workspaceId: 'ws_1',
  call: { id: 'call_1', status: 'completed', outcome: 'callback', urgency: 'urgent', title: 'Burst pipe', summary: 'Dana needs a plumber now.', recording_key: null, duration_sec: 74 },
  turns: { caller: 4, agent: 5, system: 2 },
}

test('the job metadata picks a known scenario, nothing else turns an agent into a caller', () => {
  expect(parseTestCallerMetadata('{"source":"test-caller","scenario":"burst-pipe"}')).toEqual({ source: 'test-caller', scenario: 'burst-pipe' })
  for (const metadata of ['', 'nope', '{"source":"test","workspaceId":"ws_1"}', '{"source":"test-caller","scenario":"rob-a-bank"}']) {
    expect(parseTestCallerMetadata(metadata)).toBeNull()
  }
})

test('every scenario tells the caller to end the call and never reveal the test', () => {
  expect(scenarioNames).toEqual(['burst-pipe', 'booking', 'wrong-number'])
  for (const name of scenarioNames) {
    const prompt = callerInstructions(scenarios[name])
    expect(prompt).toContain('end_call')
    expect(prompt).toContain('Never say that you are an AI')
  }
})

test('a finished burst-pipe call passes', () => {
  const checks = evaluateCall(finished, scenarios['burst-pipe'])
  expect(checks.every(c => c.ok)).toBe(true)
  expect(formatReport(checks)).toMatch(/PASS {2}urgency: urgent \(expected urgent\)\nPASS {2}recording: none \(recording not expected\)\nCall test passed\.$/)
})

test('a missing call, a live call, a thin transcript or a wrong urgency fails', () => {
  expect(evaluateCall({ ...finished, call: null }, scenarios['burst-pipe'])).toEqual([{ ok: false, label: 'call in the inbox', detail: 'no call from the test number arrived' }])
  const failed = (finding: CallTestFinding, label: string) => evaluateCall(finding, scenarios['burst-pipe']).find(c => c.label === label)?.ok
  expect(failed({ ...finished, call: { ...finished.call!, status: 'live' } }, 'call finished')).toBe(false)
  expect(failed({ ...finished, turns: { caller: 0, agent: 1, system: 0 } }, 'transcript')).toBe(false)
  expect(failed({ ...finished, call: { ...finished.call!, urgency: 'normal' } }, 'urgency')).toBe(false)
  expect(failed({ ...finished, call: { ...finished.call!, summary: null, title: null } }, 'summary')).toBe(false)
  expect(evaluateCall(finished, scenarios['burst-pipe'], { expectRecording: true }).find(c => c.label === 'recording')).toMatchObject({ ok: false, detail: 'missing' })
  expect(formatReport(evaluateCall({ ...finished, call: null }, scenarios.booking))).toMatch(/Call test failed\.$/)
})
