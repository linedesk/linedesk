// A step's decline and wrong_* need the caller's answer to the step's own question (B4: a step declined 2.4 s after
// it started, with no caller line in between, and the assistant went on without a callback number).
import { expect, test } from 'vitest'
import { phoneStep } from './collect-tools.ts'
import { ASK_FIRST, Collection, describeOutcome, MAX_ATTEMPTS, noCallerIdRule, TEST_CALL_NO_NUMBER } from './collection.ts'
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

// LIN-277: on a browser test call the caller said "use the number I'm calling from"; the number step asked for the area
// code, gave up, and the assistant was told to ask once more, although a test call has no number to give.
test('a number step without caller ID knows the number the caller is calling from is not known', () => {
  const base = phoneCollector().instructions
  expect(phoneStep({ callerId: '+15035550142' }, 'callback number').instructions).toBe(base)
  const withheld = phoneStep({ callerId: null }, 'callback number').instructions
  expect(withheld).toBe(`${base}\n${noCallerIdRule(false)}`)
  expect(withheld).toMatch(/cannot see the number the caller is calling from.*ask them to say it/)
  const testCall = phoneStep({ callerId: null, testCall: true }, 'callback number').instructions
  expect(testCall).toBe(`${base}\n${noCallerIdRule(true)}`)
  expect(testCall).toContain(`call decline with the reason "${TEST_CALL_NO_NUMBER}"`)
  // The label and the country stay the step's own.
  expect(phoneStep({ callerId: null, country: 'DE' }, 'work number').label).toBe('work number')
})

test('a declined callback number on a test call: noted as test call, no caller ID, and not asked for again', () => {
  const step = new Collection(phoneCollector())
  step.heardCaller()
  const outcome = step.decline(TEST_CALL_NO_NUMBER).outcome!
  expect(describeOutcome(outcome, { callerId: null, testCall: true })).toBe(
    'This is a test call from the app, with no caller ID: there is no callback number to get (test call, no caller ID). Do not ask for it again; put "test call, no caller ID" in take_message and go on.',
  )
  // On a phone call with a withheld number the assistant still asks once more.
  expect(describeOutcome(outcome, { callerId: null })).toMatch(/ask once more\.$/)
  // A number that is not for calling back (an account number) is as before.
  const digits = new Collection(emailCollector)
  digits.heardCaller()
  expect(describeOutcome(digits.decline('has none').outcome!, { testCall: true })).toMatch(/Go on without it\.$/)
})

// On a realtime call LiveKit reports no caller turns (onUserTurnCompleted runs only with its own turn detection), so
// hand_back, decline and wrong_* were refused for good there. The step's question having played stands in.
test('on realtime (turns not counted) the step counts as heard once its question has played', () => {
  const step = new Collection(phoneCollector())
  step.uncountedTurns()
  expect(step.handBack('Can the owner call me back?')).toEqual({ say: ASK_FIRST })
  expect(step.decline('no')).toEqual({ say: ASK_FIRST })
  step.askedQuestion()
  expect(step.handBack('Are you open on Saturday?').outcome).toMatchObject({ status: 'question', question: 'Are you open on Saturday?' })
  // With turns counted, a played question alone is not enough.
  const counted = new Collection(phoneCollector())
  counted.askedQuestion()
  expect(counted.decline('no')).toEqual({ say: ASK_FIRST })
})
