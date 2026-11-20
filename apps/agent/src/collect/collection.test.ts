// A step's decline and wrong_* need the caller's answer to the step's own question (B4: a step declined 2.4 s after
// it started, with no caller line in between, and the assistant went on without a callback number).
import { expect, test } from 'vitest'
import type { CallLog } from '../call-log.ts'
import { collectTools, PHONE_TOOL, PHONE_TOOL_WITH_CALLER_ID, phoneStep } from './collect-tools.ts'
import {
  ASK_FIRST,
  Collection,
  describeOutcome,
  handBackFirst,
  MAX_ATTEMPTS,
  noCallerIdRule,
  TEST_CALL_NO_NUMBER,
} from './collection.ts'
import { emailCollector, nameCollector, nameCollectorFor, phoneCollector } from './collectors.ts'

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

test('a declined callback number without caller ID: the assistant says nobody can call back, and asks once more', () => {
  const step = new Collection(phoneCollector())
  step.heardCaller()
  const outcome = step.decline("doesn't want to say").outcome!
  expect(describeOutcome(outcome)).toBe(
    "The caller did not give the callback number (doesn't want to say). Tell the caller nobody can call them back without a number, and ask once more.",
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

// LIN-386: with caller ID the assistant asks whether that number is the best one; another number the caller wants is
// read back and confirmed by the phone step, never taken as heard. Asking for a number is still not its use (LIN-99).
test('with caller ID the phone step is only for another number the caller wants', () => {
  const tools = (callerId: string | null) => collectTools({ log: {} as CallLog, today: () => '2026-11-17', callerId })
  expect(tools('+15035550142').get_phone_number.description).toBe(PHONE_TOOL_WITH_CALLER_ID)
  expect(PHONE_TOOL_WITH_CALLER_ID).toMatch(
    /^The number the caller is calling from is already their callback number\. Only when the caller says they want to be reached on a different number.*Never call it otherwise, also not to take a message\.$/,
  )
  expect(tools(null).get_phone_number.description).toBe(PHONE_TOOL)
  // LIN-670: with caller ID the model must quote the caller's words asking for another number, or the call is refused.
  expect(tools('+15035550142').get_phone_number.parameters.safeParse({ what: 'callback number' }).success).toBe(false)
  expect(tools('+15035550142').get_phone_number.parameters.safeParse({ caller_asked: 'call my cell instead' }).success).toBe(true)
  expect(tools(null).get_phone_number.parameters.safeParse({ what: 'callback number' }).success).toBe(true)
})

test('a declined callback number on a test call: noted as test call, no caller ID, and not asked for again', () => {
  const step = new Collection(phoneCollector())
  step.heardCaller()
  const outcome = step.decline(TEST_CALL_NO_NUMBER).outcome!
  expect(describeOutcome(outcome, { callerId: null, testCall: true })).toBe(
    'This is a test call from the app, with no caller ID: there is no callback number to get (test call, no caller ID). Do not ask for it again; go on.',
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
  expect(step.handBack('Can the owner call me back?')).toEqual({ say: handBackFirst('callback number') })
  expect(step.decline('no')).toEqual({ say: ASK_FIRST })
  step.askedQuestion()
  expect(step.handBack('Are you open on Saturday?').outcome).toMatchObject({ status: 'question', question: 'Are you open on Saturday?' })
  // With turns counted, a played question alone is not enough.
  const counted = new Collection(phoneCollector())
  counted.askedQuestion()
  expect(counted.decline('no')).toEqual({ say: ASK_FIRST })
})

test('a step in another language reads the name back without English words (LIN-323: "last name spelled" in a German call)', () => {
  const english = new Collection(nameCollector)
  expect(english.record({ first_name: 'Dana', last_name: 'Reese', last_name_spelled: 'R U I Z' }).say).toBe(
    'Heard name: Dana Ruiz. Read it back to the caller exactly like this: "Dana Ruiz, last name spelled R, U, I, Z", and ask if it is right. Do not call confirm_name until the caller said yes.',
  )
  const german = new Collection(nameCollector)
  german.englishOnly = false
  const said = german.record({ first_name: 'Jürgen', last_name: 'Haselberg', last_name_spelled: 'H A S E L B A C H' }).say
  expect(said).toBe(
    'Heard name: Jürgen Haselbach. Read it back to the caller in the language you are speaking, in that language\'s words: the name "Jürgen Haselbach", then the last name letter by letter, "H, A, S, E, L, B, A, C, H", and ask if it is right. Do not call confirm_name until the caller said yes.',
  )
  expect(said).not.toMatch(/last name spelled/)
  // The number: digits in groups, in the language spoken (LIN-386: the English read-back is in English words).
  const phone = new Collection(phoneCollector())
  phone.englishOnly = false
  expect(phone.record({ phone_number: '5035550142' }).say).toMatch(
    /in the language you are speaking, digit by digit in these groups: "5 0 3, 5 5 5, 0 1 4 2"/,
  )
  // Collectors without a version for other languages read back as before.
  const email = new Collection(emailCollector)
  email.englishOnly = false
  expect(email.record({ email: 'd.r@gmail.com' }).say).toMatch(/exactly like this: "D, dot, R, at, gmail dot com"/)
})

test('Japanese, Chinese, Korean and Hindi names are taken as heard, never spelled; other languages spell', () => {
  expect(nameCollectorFor('en')).toBe(nameCollector)
  expect(nameCollectorFor('de')).toBe(nameCollector)
  expect(nameCollectorFor('ru')).toBe(nameCollector)
  expect(nameCollectorFor(undefined)).toBe(nameCollector)
  const ja = nameCollectorFor('ja')
  expect(ja.instructions).toMatch(/never ask the caller to spell their name/)
  expect(ja.instructions).toMatch(/In the record tool write it in katakana.*never ask them for katakana/)
  expect(ja.instructions).not.toMatch(/letter by letter \(/)
  expect(ja.ask).toBe('Ask for their full name.')
  const step = new Collection(ja)
  step.englishOnly = false
  expect(step.record({ first_name: 'ハナコ', last_name: 'サトウ' }).say).toBe(
    'Heard name: サトウ ハナコ. Read it back to the caller exactly like this: "サトウ ハナコ", and ask if it is right. Do not call confirm_name until the caller said yes.',
  )
  expect(step.confirm().outcome).toEqual({ status: 'confirmed', label: 'name', value: 'サトウ ハナコ' })
  const ko = nameCollectorFor('ko')
  expect(ko.instructions).not.toMatch(/katakana/)
  expect(ko.parse({ first_name: '민지', last_name: '김' })).toEqual({ ok: true, value: { first: '민지', last: '김' } })
  expect(ko.readBack({ first: '민지', last: '김' })).toBe('김 민지')
  expect(nameCollectorFor('hi').readBack({ first: 'राहुल', last: 'शर्मा' })).toBe('राहुल शर्मा')
  expect(nameCollectorFor('zh').parse({ first_name: '伟', last_name: '' })).toEqual({ ok: false, problem: 'The family name is missing. Ask for it.' })
})
