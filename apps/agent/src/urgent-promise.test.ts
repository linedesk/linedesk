import { expect, test, vi } from 'vitest'
import { urgentPromiseCheck } from './test-caller/report.ts'
import { URGENT_FLAGGED_REPLY } from './tool-replies.ts'
import { promisesUrgent, urgentFlagger } from './urgent-promise.ts'

test('sentences that say the call is flagged as urgent are promises', () => {
  for (const said of [
    "I'm very sorry to hear that, Tom. I'll flag this call as urgent. What is the best number to reach you?",
    'Okay, Tom. I will mark this as urgent for the team.',
    "Okay, I'll let the team know this is urgent.",
    URGENT_FLAGGED_REPLY,
  ])
    expect(promisesUrgent(said), said).toBe(true)
})

test('questions, refusals and other sentences are not', () => {
  for (const said of [
    'Is this an emergency?',
    'Should I mark this as urgent?',
    "That doesn't sound urgent, so I won't flag it as urgent.",
    "Thanks, I've passed your message on.",
    'Thanks for calling Brightwater Plumbing & Heating.',
  ])
    expect(promisesUrgent(said), said).toBe(false)
})

test('the call is flagged once, from the tool and the guard together', async () => {
  const flag = vi.fn(async () => {})
  const flagUrgent = urgentFlagger(flag)
  await Promise.all([flagUrgent(), flagUrgent()])
  await flagUrgent()
  expect(flag).toHaveBeenCalledTimes(1)
})

test('a failed flag can be tried again', async () => {
  const flag = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(undefined)
  const flagUrgent = urgentFlagger(flag)
  await expect(flagUrgent()).rejects.toThrow('timeout')
  await flagUrgent()
  expect(flag).toHaveBeenCalledTimes(2)
})

const line = (speaker: string, text: string, at_ms: number) => ({ speaker, text, at_ms })

test('the call test fails when the assistant says urgent and never flags, or flags much later', () => {
  const promise = line('agent', "I'll flag this as urgent.", 22_000)
  expect(urgentPromiseCheck([promise], false)?.ok).toBe(false)
  expect(urgentPromiseCheck([promise, line('system', 'Flagged as urgent', 35_000)], false)?.ok).toBe(false)
  expect(urgentPromiseCheck([promise, line('system', 'Flagged as urgent', 23_000)], false)?.ok).toBe(true)
  expect(urgentPromiseCheck([line('system', 'Flagged as urgent', 18_000), promise], false)?.ok).toBe(true)
})

test('without a promise the check only runs when the scenario requires the flag', () => {
  expect(urgentPromiseCheck([line('agent', 'How can I help?', 1000)], false)).toBeNull()
  expect(urgentPromiseCheck([line('agent', 'How can I help?', 1000)], true)?.ok).toBe(false)
})
