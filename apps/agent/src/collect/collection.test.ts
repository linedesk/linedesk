// A step's decline and wrong_* need the caller's answer to the step's own question (B4: a step declined 2.4 s after
// it started, with no caller line in between, and the assistant went on without a callback number).
import { expect, test } from 'vitest'
import { ASK_FIRST, Collection, describeOutcome, MAX_ATTEMPTS } from './collection.ts'
import { emailCollector, phoneCollector } from './collectors.ts'

test('decline before any caller turn in the step is refused: "Ask the caller first."', () => {
  const step = new Collection(phoneCollector())
  expect(step.decline('caller said "yeah"')).toEqual({ say: ASK_FIRST })
  expect(ASK_FIRST).toBe('Ask the caller first.')
  expect(step.outcome).toBeNull()
  step.heardCaller()
  const declined = step.decline("I'd rather not give my number")
  expect(declined.outcome).toEqual({
    status: 'declined',
    label: 'callback number',
    reason: "I'd rather not give my number",
  })
})

test('wrong_* before any caller turn is refused and does not use up a try', () => {
  const step = new Collection(phoneCollector())
  step.record({ phone_number: '5035550142' }) // a number given earlier in the call, read back by the step
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) expect(step.reject()).toEqual({ say: ASK_FIRST })
  expect(step.attemptsLeft).toBe(MAX_ATTEMPTS)
  expect(step.outcome).toBeNull()
  step.heardCaller()
  expect(step.reject().say).toMatch(/not right/)
  expect(step.attemptsLeft).toBe(MAX_ATTEMPTS - 1)
})

test('a declined callback number without caller ID: the assistant says the team cannot call back, and asks once more', () => {
  const step = new Collection(phoneCollector())
  step.heardCaller()
  const outcome = step.decline("doesn't want to say").outcome!
  expect(describeOutcome(outcome)).toBe(
    "The caller did not give the callback number (doesn't want to say). Tell the caller the team cannot call back without a number, and ask once more.",
  )
  // With caller ID the team has a number: go on without the other one.
  expect(describeOutcome(outcome, { callerId: '+15035550142' })).toMatch(/Go on without it\.$/)
  // Other steps are as before.
  const email = new Collection(emailCollector)
  email.heardCaller()
  expect(describeOutcome(email.decline('has no email').outcome!)).toMatch(/Go on without it\.$/)
})
