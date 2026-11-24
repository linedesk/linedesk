import type { TranscriptSegment } from '@linedesk/db/types'
import { expect, test } from 'vitest'
import {
  applyChunk,
  FINAL_LINE_TTL_MS,
  finishLine,
  type LiveLines,
  pendingLines,
  pruneLines,
} from './liveTranscript.ts'

const row = (speaker: TranscriptSegment['speaker'], text: string, n = 0) =>
  ({
    id: `r${n}-${text}`,
    call_id: 'c',
    speaker,
    text,
    at_ms: n,
    tool_event: null,
    version: n,
  }) as unknown as TranscriptSegment

const chunk = (
  id: string,
  speaker: 'caller' | 'agent',
  text: string,
  extra: Partial<Parameters<typeof applyChunk>[1]> = {},
) => ({
  id,
  speaker,
  text,
  mode: speaker === 'agent' ? ('append' as const) : ('replace' as const),
  final: false,
  now: 1000,
  rowsBefore: 0,
  ...extra,
})

test("the caller's recognised speech replaces the line, the assistant's words add to it", () => {
  let lines: LiveLines = []
  lines = applyChunk(lines, chunk('u1', 'caller', 'my sink'))
  lines = applyChunk(lines, chunk('u1', 'caller', 'my sink is leaking'))
  lines = applyChunk(lines, chunk('a1', 'agent', 'Sorry to '))
  lines = applyChunk(lines, chunk('a1', 'agent', 'hear that.'))
  expect(lines.map(l => [l.speaker, l.text])).toEqual([
    ['caller', 'my sink is leaking'],
    ['agent', 'Sorry to hear that.'],
  ])
})

test('a line disappears once its transcript row has synced in', () => {
  const lines = applyChunk([], chunk('u1', 'caller', 'My sink is leaking', { final: true }))
  expect(pendingLines(lines, [], 1000)).toHaveLength(1)
  expect(pendingLines(lines, [row('caller', 'My sink is leaking.')], 1000)).toHaveLength(0)
})

test('an interrupted reply matches the row of the full reply', () => {
  const lines = finishLine(applyChunk([], chunk('a1', 'agent', 'We can come by on')), 'a1', 1000)
  expect(pendingLines(lines, [row('agent', 'We can come by on Tuesday at nine.')], 1000)).toHaveLength(0)
})

test('an earlier row with the same words does not hide a new line', () => {
  const rows = [row('caller', 'Yes', 1)]
  const lines = applyChunk([], chunk('u2', 'caller', 'yes', { rowsBefore: 1 }))
  expect(pendingLines(lines, rows, 1000)).toHaveLength(1)
  expect(pendingLines(lines, [...rows, row('caller', 'Yes.', 2)], 1000)).toHaveLength(0)
})

test('a finished line without a row is dropped after a while; one still spoken stays', () => {
  let lines = applyChunk([], chunk('u1', 'caller', 'hello', { final: true, now: 0 }))
  lines = applyChunk(lines, chunk('a1', 'agent', 'Hi there', { now: 0 }))
  expect(pendingLines(lines, [], FINAL_LINE_TTL_MS - 1)).toHaveLength(2)
  expect(pendingLines(lines, [], FINAL_LINE_TTL_MS).map(l => l.id)).toEqual(['a1'])
  expect(pruneLines(lines, [], FINAL_LINE_TTL_MS).map(l => l.id)).toEqual(['a1'])
})

test('empty text is never shown', () => {
  expect(pendingLines(applyChunk([], chunk('u1', 'caller', '  ')), [], 0)).toHaveLength(0)
})
