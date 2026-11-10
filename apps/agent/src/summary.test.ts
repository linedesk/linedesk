import { expect, test, vi } from 'vitest'
import { mergeToolResults, summarizeCall, type CompleteJson, type TranscriptLine } from './summary.ts'

const transcript: TranscriptLine[] = [
  { speaker: 'agent', text: 'Thanks for calling Brightwater. How can I help?' },
  { speaker: 'caller', text: 'A pipe burst in my basement, I need someone now. This is Elena Novak.' },
  { speaker: 'system', text: 'Flagged as urgent' },
  { speaker: 'agent', text: 'Mike will call you back within fifteen minutes.' },
]

const llmAnswer = {
  title: 'Burst pipe in basement', summary: 'A pipe burst in the basement; she needs someone right away.',
  outcome: 'callback', urgency: 'urgent', action_items: ['Call Elena back within 15 minutes'], caller_name: 'Elena Novak',
}

test('summarizes a transcript with one LLM call', async () => {
  const complete = vi.fn<CompleteJson>(async () => JSON.stringify(llmAnswer))
  const result = await summarizeCall(transcript, complete)

  expect(result).toEqual({
    title: 'Burst pipe in basement', summary: 'A pipe burst in the basement; she needs someone right away.',
    outcome: 'callback', urgency: 'urgent', actionItems: [{ text: 'Call Elena back within 15 minutes' }], callerName: 'Elena Novak',
  })
  expect(complete).toHaveBeenCalledTimes(1)
  const [system, user] = complete.mock.calls[0]!
  expect(system).toContain('"outcome": one of booked, rescheduled')
  expect(user).toBe(`Transcript:\n${transcript.map(l => `${l.speaker}: ${l.text}`).join('\n')}\n\nAction items already saved:\n(none)`)
})

test('a call where the caller said nothing is a hang-up, without an LLM call', async () => {
  const complete = vi.fn<CompleteJson>()
  const result = await summarizeCall([transcript[0]!], complete)
  expect(result).toMatchObject({ outcome: 'hangup', urgency: 'low' })
  expect(complete).not.toHaveBeenCalled()
})

test('rejects an answer that is not valid JSON or has an unknown outcome', async () => {
  await expect(summarizeCall(transcript, async () => 'Sure! Here is the summary')).rejects.toThrow()
  await expect(summarizeCall(transcript, async () => JSON.stringify({ ...llmAnswer, outcome: 'sold' }))).rejects.toThrow()
})

test('missing action items and caller name are fine', async () => {
  const { action_items: _a, caller_name: _c, ...minimal } = llmAnswer
  const result = await summarizeCall(transcript, async () => JSON.stringify(minimal))
  expect(result.actionItems).toEqual([])
  expect(result.callerName).toBeUndefined()
})

test('tools used during the call win over the summary', () => {
  const summary = { outcome: 'message' as const, urgency: 'normal' as const, actionItems: [{ text: 'Send the quote' }, { text: 'Call back about the leak' }] }
  expect(mergeToolResults(summary, { messages: ['Call back about the leak'], urgent: true })).toMatchObject({
    urgency: 'urgent', actionItems: [{ text: 'Call back about the leak' }, { text: 'Send the quote' }],
  })
  expect(mergeToolResults(summary, { messages: [], urgent: false }).urgency).toBe('normal')
})

test('the LLM is given the action items already saved and told not to repeat them', async () => {
  const complete = vi.fn<CompleteJson>(async () => JSON.stringify(llmAnswer))
  await summarizeCall(transcript, complete, ['Elena Novak needs a plumber now, call back on this number'])
  const [system, user] = complete.mock.calls[0]!
  expect(system).toContain('never repeat or rephrase them')
  expect(user).toContain('Action items already saved:\n- Elena Novak needs a plumber now, call back on this number')
})

test('a title that is too long is cut, not rejected', async () => {
  const result = await summarizeCall(transcript, async () => JSON.stringify({ ...llmAnswer, title: 'x'.repeat(200) }))
  expect(result.title).toBe('x'.repeat(80))
  expect(result.summary).toBe(llmAnswer.summary)
})
