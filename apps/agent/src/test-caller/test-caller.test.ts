import { describe, expect, test } from 'vitest'
import type { CallTestFinding } from '@linedesk/actions'
import { createLatencyLog, createOnsetDetector, isRinging, rms } from './latency.ts'
import { isGoodbye } from './caller.ts'
import { waitForFinishedCall } from './wait.ts'
import { describeMetrics } from '../turn-metrics.ts'
import { evaluateCall, formatAgentSetup, formatCallerLatency, formatReport, greetingCheck, latencyOf, percentile } from './report.ts'
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
  expect(parseTestCallerMetadata('{"source":"test-caller","scenario":"booking","mode":"room","persona":" You are Test Linedesk. "}')?.persona).toBe('You are Test Linedesk.')
  expect(parseTestCallerMetadata('{"source":"test-caller","scenario":"booking","persona":""}')).not.toHaveProperty('persona')
  for (const metadata of ['', 'nope', '{"source":"test","workspaceId":"ws_1"}', '{"source":"test-caller","scenario":"rob-a-bank"}']) {
    expect(parseTestCallerMetadata(metadata)).toBeNull()
  }
})

test('every speaking caller is told to end the call, never reveal the test, and today\'s date', () => {
  expect(scenarioNames).toEqual([
    'callback-message', 'burst-pipe', 'urgent-promise', 'price-question', 'booking', 'which-calendar', 'wrong-number', 'robot-question', 'interrupter',
    'after-hours', 'transfer-accepted', 'transfer-no-answer', 'transfer-declined', 'keypad-callback', 'silence', 'silence-closing', 'transfer-person', 'spanish-caller',
  ])
  expect(callerInstructions(scenarios.booking, 'Wednesday, November 11, 2026')).toContain('Today is Wednesday, November 11, 2026.')
  expect(callerInstructions(scenarios['spanish-caller'])).toContain('plain spoken Spanish')
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
  expect(report).toContain('greeting 1.8 s; caller turn to next assistant line: 3.5 s, 2.5 s (median 3.5 s)')
  expect(report).toContain('Latency heard by the caller: not measured')
  expect(report).toMatch(/PASS {2}message taken: 1 action item\n {2}PASS {2}flagged urgent: flagged at 7\.0 s\n {2}PASS {2}recording: none \(not expected\)\nCall test passed\.$/)
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

describe('booking scenarios', () => {
  const booking = (over: Partial<NonNullable<CallTestFinding['bookings']>[number]> = {}) => ({
    id: 'bk_1', status: 'confirmed', start_at: '2026-11-17T17:00:00.000Z', title: 'Repair visit · Sam Patel', calendar_name: 'Mike',
    calendar_instruction: 'Emergencies', event: 'found' as const, event_start: '2026-11-17T17:00:00.000Z', note: null, ...over,
  })
  const booked: CallTestFinding = { ...finished, call: { ...finished.call!, outcome: 'booked', urgency: 'normal', action_items: 0 }, bookingReady: true, bookings: [booking()] }
  const labels = (checks: { ok: boolean; label: string }[]) => checks.filter(c => !c.ok).map(c => c.label)

  test('with a calendar: booked, the event is in the calendar, in the calendar whose note fits', () => {
    expect(labels(evaluateCall(booked, scenarios.booking))).toEqual([])
    expect(labels(evaluateCall(booked, scenarios['which-calendar']))).toEqual([])
    expect(labels(evaluateCall({ ...booked, bookings: [booking({ calendar_instruction: 'Estimates' })] }, scenarios['which-calendar']))).toEqual(['calendar choice'])
    expect(labels(evaluateCall({ ...booked, bookings: [booking({ event: 'missing', event_start: null })] }, scenarios.booking))).toEqual(['calendar event'])
    expect(labels(evaluateCall({ ...booked, bookings: [] }, scenarios.booking))).toEqual(['booking'])
    expect(labels(evaluateCall({ ...booked, call: { ...booked.call!, outcome: 'message' } }, scenarios.booking))).toEqual(['outcome'])
  })

  test('without a calendar: a message, and never a claimed booking', () => {
    const noCalendar = { ...finished, call: { ...finished.call!, urgency: 'normal' }, bookingReady: false, bookings: [] }
    const checks = evaluateCall(noCalendar, scenarios.booking)
    expect(labels(checks)).toEqual([])
    expect(checks.find(c => c.label === 'booking')?.detail).toMatch(/cannot book/)
  })
})

test('a silent caller passes with a greeting and no caller turns', () => {
  const silent = { ...finished, call: { ...finished.call!, outcome: 'hangup', urgency: 'low' }, turns: { caller: 0, agent: 1, system: 0 }, lines: [lines[0]!] }
  expect(evaluateCall(silent, scenarios.silence).every(c => c.ok)).toBe(true)
})

test('speech onsets: a new utterance after 400 ms of quiet, not on a short click', () => {
  const onset = createOnsetDetector()
  const feed = (level: number, from: number, to: number) => { const hits = []; for (let t = from; t < to; t += 10) if (onset(level, t)) hits.push(t); return hits }
  expect(feed(2000, 0, 40)).toEqual([]) // 40 ms click
  expect(feed(0, 40, 600)).toEqual([])
  expect(feed(2000, 600, 1500)).toEqual([660]) // speech, detected after 60 ms
  expect(feed(0, 1500, 1800)).toEqual([]) // a pause of 300 ms is the same utterance
  expect(feed(2000, 1800, 2000)).toEqual([])
  expect(feed(0, 2000, 2500)).toEqual([])
  expect(feed(2000, 2500, 2700)).toEqual([2560]) // after 500 ms of quiet: a new one
  expect(rms(Int16Array.from([3, -4]))).toBeCloseTo(Math.sqrt(12.5))
})

test('greeting from the start, replies from the end of each caller turn', () => {
  const log = createLatencyLog(1000)
  log.businessStarted(2560) // greeting starts at 2500
  log.callerStopped(9000)
  log.businessStarted(10_260)
  log.businessStarted(12_000) // the assistant goes on talking: not a reply
  log.callerStopped(20_000)
  log.businessStarted(20_960)
  expect(log.sample).toEqual({ greetingMs: 1500, replyMs: [1200, 900] })
  expect(formatCallerLatency(log.sample)).toBe('Latency heard by the caller: greeting after 1.5 s; reply p50 0.9 s, p90 1.2 s, max 1.2 s over 2 replies (1.2 s, 0.9 s)')
  expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3)
  expect(percentile([5, 1, 3, 2, 4, 6, 7, 8, 9, 10], 90)).toBe(9)
  expect(percentile([], 90)).toBeNull()
})

test('a dialled call times the greeting from pickup and ignores the ringback before it', () => {
  expect(isRinging({ 'sip.callStatus': 'ringing' })).toBe(true)
  expect(isRinging({ 'sip.callStatus': 'active' })).toBe(false)
  expect(isRinging({})).toBe(false)
  const log = createLatencyLog(null)
  log.businessStarted(3000) // ringback tone
  expect(log.sample.greetingMs).toBeNull()
  log.pickedUp(5000)
  log.businessStarted(5860) // greeting starts at 5800
  expect(log.sample.greetingMs).toBe(800)
})

test('the test caller may only hang up after saying goodbye', () => {
  for (const line of ['Thanks, goodbye.', 'Okay, bye!', 'Great, have a good day.', 'Good bye then']) expect(isGoodbye(line)).toBe(true)
  for (const line of ['Hi Maya, a pipe burst under my sink.', 'My number is the one I am calling from.', 'Maybe']) expect(isGoodbye(line)).toBe(false)
})

test('describeMetrics describes the stages that make up a reply and skips the rest', () => {
  expect(describeMetrics({ type: 'eou_metrics', endOfUtteranceDelayMs: 412.4, transcriptionDelayMs: 80 })).toBe('end of turn 412 ms (transcript 80 ms)')
  expect(describeMetrics({ type: 'llm_metrics', ttftMs: 640, durationMs: 1200 })).toBe('llm first token 640 ms (total 1200 ms)')
  expect(describeMetrics({ type: 'tts_metrics', ttfbMs: 230 })).toBe('voice first audio 230 ms')
  expect(describeMetrics({ type: 'vad_metrics' })).toBeNull()
})

test('call test: a completed call is waited on for its recording, up to the grace period', async () => {
  let clock = 0
  const opts = { expectRecording: true, graceMs: 30_000, now: () => clock, wait: async (ms: number) => {
      clock += ms
    } }
  const completed = (recording_key: string | null) => ({ workspaceId: 'ws', call: { status: 'completed', recording_key } }) as never
  const answers = [completed(null), completed(null), completed('ws/call.ogg')]
  const found = await waitForFinishedCall(async () => answers.shift() ?? completed('ws/call.ogg'), 1_000_000, async () => {}, opts)
  expect((found as { call: { recording_key: string } }).call.recording_key).toBe('ws/call.ogg')

  clock = 0
  const never = await waitForFinishedCall(async () => completed(null), 1_000_000, async () => {}, opts)
  expect((never as { call: { recording_key: null } }).call.recording_key).toBeNull()
  expect(clock).toBeGreaterThanOrEqual(30_000)
  expect(clock).toBeLessThan(40_000)
})

test('greeting from pickup: the business agent\'s own timing, checked against 2.5 s', () => {
  const setup = { steps: { connected: 310, caller: 311, session: 893, 'greeting audio': 925 }, greeting: 'cached' }
  expect(greetingCheck(setup)).toEqual({ ok: true, label: 'greeting from pickup', detail: '0.9 s (target 2.5 s)' })
  expect(greetingCheck({ steps: { 'greeting audio': 2600 }, greeting: 'synthesized' }).ok).toBe(false)
  expect(greetingCheck(null)).toMatchObject({ ok: false, detail: 'not measured' })
  expect(formatAgentSetup(setup)).toBe('Greeting from pickup (business agent): 0.9 s (greeting cached); steps: connected 0.3 s, caller 0.3 s, session 0.9 s, greeting audio 0.9 s')
  expect(formatAgentSetup(null)).toContain('not measured')
})
