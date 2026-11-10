// The report of a call test, from what the business's side recorded: transcript, summary,
// pass/fail per check, and how quickly the assistant answered.
import type { CallTestFinding } from '@callfront/actions'
import type { LatencySample } from './latency.ts'
import type { Scenario } from './scenarios.ts'

export type Check = { ok: boolean; label: string; detail: string }
type Line = CallTestFinding['lines'][number]

const assistantText = (lines: Line[]) => lines.filter(l => l.speaker === 'agent').map(l => l.text).join(' ')
/** What the assistant said once the caller had spoken: answers, not the fixed greeting. */
const assistantReplies = (lines: Line[]) => {
  const first = lines.findIndex(l => l.speaker === 'caller')
  return first < 0 ? '' : assistantText(lines.slice(first + 1))
}

export function evaluateCall(finding: CallTestFinding, scenario: Scenario, { expectRecording = false } = {}): Check[] {
  const { call, turns, lines } = finding
  if (!call) return [{ ok: false, label: 'call in the inbox', detail: 'no call from the test caller arrived' }]
  const expect = scenario.expect
  const transcriptOk = expect.silentCaller ? turns.agent >= 1 && turns.caller === 0 : turns.agent >= 2 && turns.caller >= 1
  const checks: Check[] = [
    { ok: true, label: 'call in the inbox', detail: `${call.id} in workspace ${finding.workspaceId}` },
    { ok: call.status === 'completed', label: 'call finished', detail: `${call.status}${call.duration_sec !== null ? `, ${call.duration_sec} s` : ''}` },
    { ok: transcriptOk, label: 'transcript', detail: `${turns.agent} assistant, ${turns.caller} caller, ${turns.system} tool lines${expect.silentCaller ? ' (silent caller expected)' : ''}` },
    { ok: Boolean(call.title && call.summary), label: 'summary', detail: call.title ? `"${call.title}"` : 'none' },
  ]
  if (expect.outcome) checks.push({ ok: call.outcome !== null && expect.outcome.includes(call.outcome), label: 'outcome', detail: `${call.outcome ?? 'none'} (expected ${expect.outcome.join(' or ')})` })
  if (expect.urgency) checks.push({ ok: call.urgency === expect.urgency, label: 'urgency', detail: `${call.urgency} (expected ${expect.urgency})` })
  if (expect.actionItems) checks.push({ ok: call.action_items >= expect.actionItems, label: 'message taken', detail: `${call.action_items} action item${call.action_items === 1 ? '' : 's'}` })
  const said = assistantText(lines)
  if (expect.assistantSays) checks.push({ ok: expect.assistantSays.test(assistantReplies(lines)), label: 'assistant says', detail: `${expect.assistantSays} (after the caller spoke)` })
  if (expect.assistantAvoids) {
    const match = said.match(expect.assistantAvoids)
    checks.push({ ok: !match, label: 'assistant avoids', detail: match ? `said "${match[0]}"` : `${expect.assistantAvoids} not said` })
  }
  checks.push({ ok: !expectRecording || Boolean(call.recording_key), label: 'recording', detail: call.recording_key ? 'stored' : expectRecording ? 'missing' : 'none (not expected)' })
  return checks
}

export type Latency = { greetingMs: number | null; replyGapsMs: number[] }

/**
 * Approximate timings from when transcript lines were written: the greeting after the call started,
 * and for each caller turn the time until the assistant's next line. Lines are written once a turn
 * is complete, so a gap includes the assistant's speaking time.
 */
export function latencyOf(lines: Line[]): Latency {
  const greeting = lines.find(l => l.speaker === 'agent')
  const replyGapsMs: number[] = []
  lines.forEach((line, i) => {
    if (line.speaker !== 'caller') return
    const reply = lines.slice(i + 1).find(l => l.speaker === 'agent')
    if (reply) replyGapsMs.push(reply.at_ms - line.at_ms)
  })
  return { greetingMs: greeting?.at_ms ?? null, replyGapsMs }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/** The value below which `p` percent of the samples fall (nearest rank). */
export function percentile(samples: number[], p: number): number | null {
  if (!samples.length) return null
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

/** What the caller heard: time to the greeting and from the end of each caller turn to the reply. */
export function formatCallerLatency(sample: LatencySample | null): string {
  if (!sample) return 'Latency heard by the caller: not measured'
  const replies = sample.replyMs
  const stats = replies.length ? `p50 ${seconds(percentile(replies, 50)!)}, p90 ${seconds(percentile(replies, 90)!)}, max ${seconds(Math.max(...replies))} over ${replies.length} replies (${replies.map(seconds).join(', ')})` : 'no replies'
  return `Latency heard by the caller: greeting after ${sample.greetingMs === null ? 'none' : seconds(sample.greetingMs)}; reply ${stats}`
}

export function formatReport(finding: CallTestFinding, checks: Check[], heard: LatencySample | null = null): string {
  const out: string[] = []
  if (finding.lines.length) {
    out.push('Transcript:', ...finding.lines.map(l => `  [${seconds(l.at_ms)}] ${l.speaker === 'agent' ? 'assistant' : l.speaker}: ${l.text}`))
  }
  if (finding.call?.summary) out.push(`Summary: ${finding.call.title ?? ''}: ${finding.call.summary}`)
  const { greetingMs, replyGapsMs } = latencyOf(finding.lines)
  if (greetingMs !== null) {
    const gaps = replyGapsMs.length ? `${replyGapsMs.map(seconds).join(', ')} (median ${seconds([...replyGapsMs].sort((a, b) => a - b)[Math.floor(replyGapsMs.length / 2)]!)})` : 'none'
    out.push(`Transcript timing (lines are written after each turn, so this includes speaking time): greeting ${seconds(greetingMs)}; caller turn to next assistant line: ${gaps}`)
  }
  out.push(formatCallerLatency(heard))
  out.push('Checks:', ...checks.map(c => `  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}: ${c.detail}`))
  out.push(checks.every(c => c.ok) ? 'Call test passed.' : 'Call test failed.')
  return out.join('\n')
}
