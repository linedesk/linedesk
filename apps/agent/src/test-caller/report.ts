// The pass/fail report of a call test, from what the business's side recorded.
import type { CallTestFinding } from '@callfront/actions'
import type { Scenario } from './scenarios.ts'

export type Check = { ok: boolean; label: string; detail: string }

export function evaluateCall(finding: CallTestFinding, scenario: Scenario, { expectRecording = false } = {}): Check[] {
  const { call, turns } = finding
  if (!call) return [{ ok: false, label: 'call in the inbox', detail: 'no call from the test number arrived' }]
  const checks: Check[] = [
    { ok: true, label: 'call in the inbox', detail: `${call.id} in workspace ${finding.workspaceId}` },
    { ok: call.status === 'completed', label: 'call finished', detail: `${call.status}${call.duration_sec !== null ? `, ${call.duration_sec} s` : ''}` },
    { ok: turns.agent >= 2 && turns.caller >= 1, label: 'transcript', detail: `${turns.agent} assistant, ${turns.caller} caller, ${turns.system} tool lines` },
    { ok: Boolean(call.title && call.summary), label: 'summary', detail: call.title ? `"${call.title}": ${call.summary ?? ''}` : 'none' },
  ]
  const { outcome, urgency } = scenario.expect
  if (outcome) checks.push({ ok: call.outcome !== null && outcome.includes(call.outcome), label: 'outcome', detail: `${call.outcome ?? 'none'} (expected ${outcome.join(' or ')})` })
  if (urgency) checks.push({ ok: call.urgency === urgency, label: 'urgency', detail: `${call.urgency} (expected ${urgency})` })
  checks.push({ ok: !expectRecording || Boolean(call.recording_key), label: 'recording', detail: call.recording_key ? 'stored' : expectRecording ? 'missing' : 'none (recording not expected)' })
  return checks
}

export const formatReport = (checks: Check[]) =>
  [...checks.map(c => `${c.ok ? 'PASS' : 'FAIL'}  ${c.label}: ${c.detail}`), checks.every(c => c.ok) ? 'Call test passed.' : 'Call test failed.'].join('\n')
