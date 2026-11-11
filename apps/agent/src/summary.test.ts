import { expect, test, vi } from 'vitest'
import { mergeToolResults, summarizeCall, unsummarizedResult, type CompleteJson, type TranscriptLine } from './summary.ts'

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
    lead: { callerName: 'Elena Novak' },
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

test('a taken message makes the call a message, unless the summary says callback or spam', () => {
  const tools = { messages: ['Call Lena back about the faucet quote'], urgent: false }
  expect(mergeToolResults({ outcome: 'answered', urgency: 'normal' }, tools).outcome).toBe('message')
  expect(mergeToolResults({ outcome: 'hangup', urgency: 'normal' }, tools).outcome).toBe('message')
  expect(mergeToolResults({ outcome: 'callback', urgency: 'normal' }, tools).outcome).toBe('callback')
  expect(mergeToolResults({ outcome: 'answered', urgency: 'normal' }, { messages: [], urgent: false }).outcome).toBe('answered')
})

test('without a summary, a long message is cut to a title at a word boundary', () => {
  const long = `Dana Ruiz at 1450 Southeast Division Street has a burst pipe under the kitchen sink and needs a plumber as soon as possible. Main valve is off.`
  const result = unsummarizedResult([], [long])
  expect(result.title!.length).toBeLessThanOrEqual(80)
  expect(result.title!.endsWith('…')).toBe(true)
  expect(result).toMatchObject({ outcome: 'message', summary: long })
})

const fields = [
  { id: 'cf_size', label: 'Home size', type: 'choice' as const, options: ['Small', 'Large'], ask_caller: true, instruction: null },
  { id: 'cf_pets', label: 'Pets', type: 'boolean' as const, options: [], ask_caller: false, instruction: 'Any dogs on site?' },
]

test('extracts the lead, the tag and the custom fields; unknown or empty fields are dropped, a bad tag is ignored', async () => {
  const complete = vi.fn<CompleteJson>(async () => JSON.stringify({
    ...llmAnswer, address: '12 Oak St', job_type: 'Burst pipe', callback_number: null, tag: 'new_lead',
    custom_fields: { cf_size: 'Large', cf_pets: null, cf_gone: 'x' },
  }))
  const result = await summarizeCall(transcript, complete, [], fields)
  expect(result.lead).toEqual({ callerName: 'Elena Novak', address: '12 Oak St', jobType: 'Burst pipe' })
  expect(result.tag).toBe('new_lead')
  expect(result.customValues).toEqual({ cf_size: 'Large' })
  expect(complete.mock.calls[0]![0]).toContain('"cf_pets": Pets (true or false). Any dogs on site?')

  const odd = await summarizeCall(transcript, async () => JSON.stringify({ ...llmAnswer, tag: 'vip' }))
  expect(odd.tag).toBeUndefined()
  expect(odd.title).toBe('Burst pipe in basement')
})

test('tools set the tag and their lead details win over the summary', () => {
  const result = { outcome: 'message' as const, tag: 'new_lead' as const, lead: { callerName: 'Elena', address: 'somewhere' } }
  expect(mergeToolResults(result, { messages: [], urgent: false, bookings: ['Repair'], lead: { callerName: 'Elena Novak' } })).toMatchObject({
    tag: 'booked', lead: { callerName: 'Elena Novak', address: 'somewhere' },
  })
  expect(mergeToolResults(result, { messages: [], urgent: false, transferred: true })).toMatchObject({ tag: 'transferred' })
  expect(mergeToolResults(result, { messages: [], urgent: false })).toMatchObject({ tag: 'new_lead' })
})
