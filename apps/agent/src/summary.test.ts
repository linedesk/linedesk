import { CALLER_NAME_MAX, callFinish } from '@linedesk/actions'
import { expect, test, vi } from 'vitest'
import { MAX_UNSUMMARIZED_LENGTH, mergeToolResults, summarizeCall, unsummarizedResult, type CompleteJson, type TranscriptLine } from './summary.ts'

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
  expect(user).toBe(`Transcript:\n${transcript.map(l => `${l.speaker}: ${l.text}`).join('\n')}\n\nAction items already saved:\n(none)\n\nDetails the caller gave:\n(none)`)
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

test('a caller name longer than call.finish takes is cut, so the summary is still saved; a blank one is none', async () => {
  const long = await summarizeCall(transcript, async () => JSON.stringify({ ...llmAnswer, caller_name: ` ${'n'.repeat(200)}` }))
  expect(long.callerName).toBe('n'.repeat(CALLER_NAME_MAX))
  expect(callFinish.input.safeParse({ callId: 'c_1', callerName: long.callerName }).success).toBe(true)
  expect(callFinish.input.safeParse({ callId: 'c_1', callerName: 'n'.repeat(CALLER_NAME_MAX + 1) }).success).toBe(false)
  expect((await summarizeCall(transcript, async () => JSON.stringify({ ...llmAnswer, caller_name: '  ' }))).callerName).toBeUndefined()
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

test('a caller who gives up during a step still leaves a call back with what was gathered (LIN-103)', () => {
  const gaveUp = { outcome: 'hangup' as const, urgency: 'low' as const, title: 'Water heater maintenance', summary: 'Sam Patel wants a water heater maintenance visit next Wednesday morning.', actionItems: [] }
  const tools = { messages: [], urgent: false, collecting: 'callback number', confirmedName: 'Sam Patel', confirmedNumbers: [] }
  const result = mergeToolResults(gaveUp, tools)
  expect(result.outcome).toBe('callback')
  expect(result.actionItems).toEqual([
    { text: 'Call the caller back (Sam Patel): the call ended while the assistant was asking for the callback number. Sam Patel wants a water heater maintenance visit next Wednesday morning.' },
  ])
  // No step open, or a message already saved: as before.
  expect(mergeToolResults(gaveUp, { ...tools, collecting: null }).outcome).toBe('hangup')
  expect(mergeToolResults(gaveUp, { ...tools, messages: ['Call Sam back'] }).actionItems).toEqual([{ text: 'Call Sam back' }])
})

test('a call back the summary left without an action item gets one from the summary', () => {
  const callback = { outcome: 'callback' as const, urgency: 'normal' as const, title: 'Maintenance visit', summary: 'Sam Patel wants a water heater visit on Wednesday morning.', actionItems: [] }
  expect(mergeToolResults(callback, { messages: [], urgent: false }).actionItems).toEqual([{ text: 'Call the caller back: Sam Patel wants a water heater visit on Wednesday morning.' }])
  // An answered question needs nothing.
  expect(mergeToolResults({ ...callback, outcome: 'answered' }, { messages: [], urgent: false }).actionItems).toEqual([])
})

test('without a callback number (no caller ID, none given) no action item says "Call back" or that the number is missing', async () => {
  // call_21bd: a test call, no number given, and the summary asked the owner to call back. A missing number is not a
  // next step either (Tim, 2026-11-16): the items say what the caller wants, and the call is filed as a message.
  const answer = { ...llmAnswer, action_items: ['Call back Elena Novak to get her message and phone number', 'Call the caller back: she wants a plumber on Tuesday', 'Check the basement valve'] }
  const complete = vi.fn<CompleteJson>(async () => JSON.stringify(answer))
  const summary = await summarizeCall(transcript, complete, [], 'en', { callbackKnown: false })
  expect(complete.mock.calls[0]![1]).toContain('never write an action item to call them back. Write the action items about what the caller wants, and say in the summary that the caller left no number.')
  const result = mergeToolResults(summary, { messages: [], urgent: false }, false)
  expect(result.actionItems).toEqual([{ text: 'She wants a plumber on Tuesday' }, { text: 'Check the basement valve' }])
  expect(result.actionItems!.some(item => /call\b.*\bback|callback number/i.test(item.text))).toBe(false)
  expect(result.outcome).toBe('message')

  // The fallback item of a call back without one: what the call was about.
  const bare = { outcome: 'callback' as const, urgency: 'normal' as const, title: 'Leak', summary: 'Elena Novak has a burst pipe.', actionItems: [] }
  const fallback = mergeToolResults(bare, { messages: [], urgent: false }, false)
  expect(fallback.actionItems).toEqual([{ text: 'Elena Novak has a burst pipe.' }])
  expect(fallback.outcome).toBe('message')
  // Hung up during the number step.
  const midStep = mergeToolResults({ ...bare, outcome: 'hangup' }, { messages: [], urgent: false, collecting: 'callback number' }, false)
  expect(midStep.actionItems).toEqual([
    { text: 'The call ended while the assistant was asking for the callback number. Elena Novak has a burst pipe.' },
  ])
  expect(midStep.outcome).toBe('message')

  // With a number the summary is unchanged.
  const known = await summarizeCall(transcript, async () => JSON.stringify(answer))
  const withNumber = mergeToolResults(known, { messages: [], urgent: false })
  expect(withNumber.actionItems![0]).toEqual({ text: 'Call back Elena Novak to get her message and phone number' })
  expect(complete.mock.calls.length).toBe(1)
})

// No take_message tool: the summary writes the owner's next step, from the details the collection steps got.
test('the LLM is given the details the caller gave, marked when not confirmed, and told to use only those numbers', async () => {
  const complete = vi.fn<CompleteJson>(async () => JSON.stringify(llmAnswer))
  const details = [
    { label: 'name', value: 'Dana Reyes', confirmed: true },
    { label: 'callback number', value: '+15035550183', confirmed: true },
    { label: 'address', value: '22 Oak St', confirmed: false },
  ]
  await summarizeCall(transcript, complete, [], 'en', { details })
  const [system, user] = complete.mock.calls[0]!
  expect(system).toContain('Never write a phone number that is not listed there')
  expect(system).toContain('each request the caller left is one item')
  expect(user).toContain('Details the caller gave:\n- name: Dana Reyes\n- callback number: +15035550183\n- address (not confirmed): 22 Oak St')
})

test('a confirmed callback number makes a call the summary calls answered a call back', () => {
  const answered = { outcome: 'answered' as const, urgency: 'normal' as const, summary: 'Asked about the water heater.', actionItems: [] }
  expect(mergeToolResults(answered, { messages: [], urgent: false, confirmedNumbers: ['+15035550183'] }).outcome).toBe('callback')
  expect(mergeToolResults(answered, { messages: [], urgent: false }).outcome).toBe('answered')
  // A booking still wins.
  expect(mergeToolResults(answered, { messages: [], urgent: false, confirmedNumbers: ['+15035550183'], bookings: ['Repair'] }).outcome).toBe('booked')
})

test('without a summary, confirmed details still leave a call back for the team', () => {
  const lines: TranscriptLine[] = [{ speaker: 'caller', text: 'My water heater is leaking.' }]
  const result = unsummarizedResult(lines, [], 'en', [
    { label: 'name', value: 'Dana Reyes', confirmed: true },
    { label: 'callback number', value: '+15035550183', confirmed: true },
  ])
  expect(result.outcome).toBe('callback')
  expect(result.actionItems?.[0]?.text).toContain('Dana Reyes, +15035550183')
  expect(unsummarizedResult(lines).outcome).toBe('answered')
})

test('without a summary, the summary is everything the caller said, not only their first "hello" (demo retest fr-1)', () => {
  const lines: TranscriptLine[] = [
    { speaker: 'agent', text: 'Thanks for calling. How can I help?' },
    { speaker: 'caller', text: 'Bonjour.' },
    { speaker: 'caller', text: 'Le chauffage de mon appartement ne marche plus.' },
    { speaker: 'system', text: 'Flagged as urgent' },
    { speaker: 'caller', text: 'Je m\'appelle Elodie Marchand.' },
  ]
  expect(unsummarizedResult(lines).summary).toBe("Bonjour. Le chauffage de mon appartement ne marche plus. Je m'appelle Elodie Marchand.")
  const long = unsummarizedResult([{ speaker: 'caller', text: 'word '.repeat(400) }]).summary!
  expect(long.length).toBeLessThanOrEqual(MAX_UNSUMMARIZED_LENGTH)
  expect(long.endsWith('word…')).toBe(true)
})
