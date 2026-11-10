import { expect, test } from 'vitest'
import type { CallTestFinding } from '@callfront/actions'
import { evaluateCall, formatReport, latencyOf } from './report.ts'
import { callerInstructions, parseTestCallerMetadata, scenarioNames, scenarios } from './scenarios.ts'

const lines = [
  { speaker: 'agent', text: 'Thanks for calling Brightwater. This is Maya, the AI assistant. How can I help?', at_ms: 1800 },
  { speaker: 'caller', text: 'A pipe burst under my sink.', at_ms: 6000 },
  { speaker: 'system', text: 'Flagged as urgent', at_ms: 7000 },
  { speaker: 'agent', text: 'I have flagged this as urgent. What is your address?', at_ms: 9500 },
  { speaker: 'caller', text: '1450 Southeast Division Street.', at_ms: 14000 },
  { speaker: 'agent', text: 'Thanks, the team will call you back.', at_ms: 16500 },
]
const finished: CallTestFinding = {
  workspaceId: 'ws_1',
  call: { id: 'call_1', status: 'completed', outcome: 'callback', urgency: 'urgent', title: 'Burst pipe', summary: 'Dana needs a plumber now.', recording_key: null, duration_sec: 74, action_items: 1 },
  turns: { caller: 2, agent: 3, system: 1 },
  lines,
}
const check = (finding: CallTestFinding, name: keyof typeof scenarios, label: string) => evaluateCall(finding, scenarios[name]).find(c => c.label === label)

test('the job metadata picks a known scenario and mode; nothing else turns an agent into a caller', () => {
  expect(parseTestCallerMetadata('{"source":"test-caller","scenario":"burst-pipe","mode":"room"}')).toEqual({ source: 'test-caller', scenario: 'burst-pipe', mode: 'room' })
  expect(parseTestCallerMetadata('{"source":"test-caller","scenario":"silence"}')?.mode).toBe('phone')
  for (const metadata of ['', 'nope', '{"source":"test","workspaceId":"ws_1"}', '{"source":"test-caller","scenario":"rob-a-bank"}']) {
    expect(parseTestCallerMetadata(metadata)).toBeNull()
  }
})

test('eight scenarios; every speaking caller is told to end the call and never reveal the test', () => {
  expect(scenarioNames).toEqual(['callback-message', 'burst-pipe', 'price-question', 'booking', 'wrong-number', 'robot-question', 'interrupter', 'silence'])
  for (const name of scenarioNames.filter(n => scenarios[n].persona)) {
    expect(callerInstructions(scenarios[name])).toContain('end_call')
    expect(callerInstructions(scenarios[name])).toContain('Never say that you are an AI')
  }
})

test('a finished burst-pipe call passes, with transcript, summary and latency in the report', () => {
  const checks = evaluateCall(finished, scenarios['burst-pipe'])
  expect(checks.every(c => c.ok)).toBe(true)
  const report = formatReport(finished, checks)
  expect(report).toContain('  [6.0 s] caller: A pipe burst under my sink.')
  expect(report).toContain('Summary: Burst pipe: Dana needs a plumber now.')
  expect(report).toContain('Latency (approximate): greeting after 1.8 s; caller turn to next assistant line: 3.5 s, 2.5 s (median 3.5 s)')
  expect(report).toMatch(/PASS {2}message taken: 1 action item\n {2}PASS {2}recording: none \(not expected\)\nCall test passed\.$/)
})

test('latency: greeting time and the gap from each caller turn to the next assistant line', () => {
  expect(latencyOf(lines)).toEqual({ greetingMs: 1800, replyGapsMs: [3500, 2500] })
  expect(latencyOf([])).toEqual({ greetingMs: null, replyGapsMs: [] })
})

test('each expectation fails when it is not met', () => {
  expect(evaluateCall({ ...finished, call: null }, scenarios['burst-pipe'])).toEqual([{ ok: false, label: 'call in the inbox', detail: 'no call from the test caller arrived' }])
  expect(check({ ...finished, call: { ...finished.call!, status: 'live' } }, 'burst-pipe', 'call finished')?.ok).toBe(false)
  expect(check({ ...finished, turns: { caller: 0, agent: 1, system: 0 } }, 'burst-pipe', 'transcript')?.ok).toBe(false)
  expect(check({ ...finished, call: { ...finished.call!, urgency: 'normal' } }, 'burst-pipe', 'urgency')?.ok).toBe(false)
  expect(check({ ...finished, call: { ...finished.call!, action_items: 0 } }, 'callback-message', 'message taken')?.ok).toBe(false)
  expect(evaluateCall(finished, scenarios['burst-pipe'], { expectRecording: true }).find(c => c.label === 'recording')).toMatchObject({ ok: false, detail: 'missing' })
})

test('what the assistant says: AI disclosure when asked, no prices, no booked times', () => {
  // The greeting alone does not count: the assistant has to say it when asked.
  expect(check(finished, 'robot-question', 'assistant says')?.ok).toBe(false)
  const answered = { ...finished, lines: [...lines.slice(0, 2), { speaker: 'agent', text: "I'm an AI assistant.", at_ms: 8000 }, ...lines.slice(2)] }
  expect(check(answered, 'robot-question', 'assistant says')?.ok).toBe(true)
  const priced = { ...finished, lines: [...lines, { speaker: 'agent', text: 'A drain is usually $150.', at_ms: 20000 }] }
  expect(check(priced, 'price-question', 'assistant avoids')).toMatchObject({ ok: false, detail: 'said "$150"' })
  const booked = { ...finished, lines: [...lines, { speaker: 'agent', text: "Great, you're booked for Tuesday at 10.", at_ms: 20000 }] }
  expect(check(booked, 'booking', 'assistant avoids')?.ok).toBe(false)
  expect(check(finished, 'booking', 'assistant avoids')?.ok).toBe(true)
})

test('a silent caller passes with a greeting and no caller turns', () => {
  const silent = { ...finished, call: { ...finished.call!, outcome: 'hangup', urgency: 'low' }, turns: { caller: 0, agent: 1, system: 0 }, lines: [lines[0]!] }
  expect(evaluateCall(silent, scenarios.silence).every(c => c.ok)).toBe(true)
})
