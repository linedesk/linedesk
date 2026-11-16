import { llm } from '@livekit/agents'
import { describe, expect, it, test, vi } from 'vitest'
import { nudgeIfQuiet, saidMeanwhile, stepFacts, syncCallerSilence } from './collect-tools.ts'
import { askedAgainAfterPutOff, putsOff } from './collect-task.ts'
import { ASK_FIRST, Collection, describeOutcome, MAX_ATTEMPTS, outcomeEvent } from './collection.ts'
import {
  addressCollector,
  emailCollector,
  isWholePhoneNumber,
  nameCollector,
  partialPhoneNumberIn,
  parseDate,
  phoneCollector,
  stateCode,
  toE164,
  todayFact,
} from './collectors.ts'
import { readDigits, readLetters, spokenDigits, spokenEmail, spokenLetters } from './spoken.ts'

describe('spoken input', () => {
  it('turns spoken digits into digits', () => {
    expect(spokenDigits('five oh three, five five five, oh one four two')).toBe('5035550142')
    expect(spokenDigits('area code 503, double five five, zero one four two')).toBe('5035550142')
    expect(spokenDigits('503-555-0142')).toBe('5035550142')
    expect(spokenDigits('plus one five oh three 555 0142')).toBe('+15035550142')
    expect(spokenDigits('twenty one, nineteen, five hundred')).toBe('2119500')
    expect(spokenDigits('triple seven')).toBe('777')
    expect(spokenDigits('um, nothing')).toBe('')
  })

  it('reads letters spelled one by one, with the NATO alphabet or "as in"', () => {
    expect(spokenLetters('R U I Z')).toBe('ruiz')
    expect(spokenLetters('Romeo Uniform India Zulu')).toBe('ruiz')
    expect(spokenLetters('Ruiz, R as in Robert, U, I as in India, Z')).toBe('ruiz')
    expect(spokenLetters('B for Bravo R E double N A N')).toBe('brennan')
    expect(spokenLetters('O apostrophe B R I E N')).toBe("o'brien")
    expect(spokenLetters('Ruiz')).toBeNull()
    // Callers of other alphabets spell in their own letters.
    expect(spokenLetters('С М И Р Н О В А')).toBe('смирнова')
    expect(spokenLetters('J Ü R G E N')).toBe('jürgen')
  })

  it('turns a spoken email address into an address', () => {
    expect(spokenEmail('dana dot ruiz at gmail dot com')).toBe('dana.ruiz@gmail.com')
    expect(spokenEmail('my email is sam underscore patel two two at outlook dot com')).toBe('sam_patel22@outlook.com')
    expect(spokenEmail('d as in delta a n a at yahoo dot com')).toBe('dana@yahoo.com')
    expect(spokenEmail('dana.ruiz@gmail.com')).toBe('dana.ruiz@gmail.com')
  })

  it('reads digits in groups and letters one by one', () => {
    expect(readDigits('5035550142', [3, 3])).toBe('5 0 3, 5 5 5, 0 1 4 2')
    expect(readLetters("O'Brien")).toBe('O, apostrophe, B, R, I, E, N')
  })
})

describe('collectors', () => {
  it('phone numbers become US E.164', () => {
    expect(toE164('five oh three five five five oh one four two')).toEqual({ ok: true, value: '+15035550142' })
    expect(toE164('1 503 555 0142')).toEqual({ ok: true, value: '+15035550142' })
    expect(toE164('+44 20 7946 0958')).toEqual({ ok: true, value: '+442079460958' })
    expect(toE164('555 0142').ok).toBe(false)
    expect(toE164('103 555 0142').ok).toBe(false) // area codes start with 2–9
    expect(phoneCollector().readBack('+15035550142')).toBe('5 0 3, 5 5 5, 0 1 4 2')
  })

  it('names need the last name spelled, and the spelling wins', () => {
    const asked = nameCollector.parse({ first_name: 'Dana', last_name: 'Reese' })
    expect(asked.ok).toBe(false)
    if (!asked.ok) expect(asked.problem).toMatch(/spell the last name/)
    const spelled = nameCollector.parse({ first_name: 'dana', last_name: 'Reese', last_name_spelled: 'R U I Z' })
    expect(spelled).toEqual({ ok: true, value: { first: 'Dana', last: 'Ruiz' } })
    if (spelled.ok) expect(nameCollector.readBack(spelled.value)).toBe('Dana Ruiz, last name spelled R, U, I, Z')
    expect(nameCollector.parse({ first_name: '12345', last_name: 'x', last_name_spelled: 'a b' }).ok).toBe(false)
    expect(nameCollector.parse({ first_name: 'null', last_name: 'Ruiz' }).ok).toBe(false)
  })

  it('emails are checked and spelled back', () => {
    expect(emailCollector.parse({ email: 'dana dot ruiz at gmail dot com' })).toEqual({
      ok: true,
      value: 'dana.ruiz@gmail.com',
    })
    expect(emailCollector.parse({ email: 'dana ruiz' }).ok).toBe(false)
    expect(emailCollector.readBack('d.r@gmail.com')).toBe('D, dot, R, at, gmail dot com')
  })

  it('addresses are US: street with a number, a state, a 5-digit ZIP', () => {
    const parsed = addressCollector.parse({
      street: '1450 SE Division Street',
      city: 'portland',
      state: 'Oregon',
      zip: 'nine seven two oh two',
    })
    expect(parsed).toEqual({
      ok: true,
      value: { street: '1450 SE Division Street', unit: '', city: 'Portland', state: 'OR', zip: '97202' },
    })
    if (parsed.ok) {
      expect(addressCollector.display(parsed.value)).toBe('1450 SE Division Street, Portland, OR 97202')
      expect(addressCollector.readBack(parsed.value)).toBe('1450 SE Division Street, Portland, Oregon, ZIP 9 7 2 0 2')
    }
    expect(addressCollector.parse({ street: 'Division Street', city: 'Portland', state: 'OR' }).ok).toBe(false)
    expect(addressCollector.parse({ street: '1 Main St', city: 'Portland', state: 'Narnia' }).ok).toBe(false)
    expect(addressCollector.parse({ street: '1 Main St', city: 'Portland', state: 'OR', zip: '972' }).ok).toBe(false)
    expect(stateCode('n.y.')).toBe('NY')
  })

  it('dates: ISO, US and spoken forms; impossible dates refused', () => {
    expect(parseDate('2026-11-14', '2026-11-11')).toBe('2026-11-14')
    expect(parseDate('11/14', '2026-11-11')).toBe('2026-11-14')
    expect(parseDate('January 15th 1990', '2026-11-11')).toBe('1990-01-15')
    expect(parseDate('the 15th of Jan 90', '2026-11-11')).toBe('1990-01-15')
    expect(parseDate('February 30', '2026-11-11')).toBeNull()
  })
})

describe('a collection step', () => {
  it('records, reads back and completes on confirmation', () => {
    const step = new Collection(phoneCollector())
    expect(step.confirm().say).toMatch(/Nothing to confirm/)
    const heard = step.record({ phone_number: 'five oh three five five five oh one four two' })
    expect(heard.say).toContain('"5 0 3, 5 5 5, 0 1 4 2"')
    const done = step.confirm()
    expect(done.outcome).toEqual({ status: 'confirmed', label: 'callback number', value: '+15035550142' })
    expect(describeOutcome(done.outcome!)).toMatch(/confirmed the callback number: \+15035550142/)
  })

  it('gives up after the tries and hands back the best guess', () => {
    const step = new Collection(phoneCollector())
    step.heardCaller() // the caller answers the step's question
    step.record({ phone_number: '555 0142' })
    step.record({ phone_number: '5035550142' })
    step.reject()
    expect(step.outcome).toBeNull()
    const last = step.record({ phone_number: '503 555' })
    expect(last.outcome).toEqual({ status: 'incomplete', label: 'callback number', partial: '503 555' })
    expect(describeOutcome(last.outcome!)).toMatch(/someone will call them back/)
    expect(outcomeEvent(last.outcome!)).toBe('Callback number not confirmed')
    expect(MAX_ATTEMPTS).toBe(3)
  })

  it('a confirmed value gets one transcript line, and a decline ends the step', () => {
    const step = new Collection(phoneCollector())
    step.record({ phone_number: '5035550142' })
    const done = step.confirm()
    expect(outcomeEvent(done.outcome!)).toBe('Callback number confirmed')
    const email = new Collection(emailCollector)
    email.heardCaller()
    const declined = email.decline('has no email')
    expect(describeOutcome(declined.outcome!)).toMatch(/did not want to give the email address \(has no email\)/)
  })
})

test('a callback number is whole only with 10 digits (or 11 with a leading 1, or + and a country code)', () => {
  expect(isWholePhoneNumber('503-555-0142')).toBe(true)
  expect(isWholePhoneNumber('five zero three five five five zero one four two')).toBe(true)
  expect(isWholePhoneNumber('503-551-42')).toBe(false)
  expect(isWholePhoneNumber('the number I am calling from')).toBe(false)
  expect(partialPhoneNumberIn('Sam Patel wants a call back on 503-551-42 about the water heater.')).toBe('503-551-42')
  expect(partialPhoneNumberIn('Call back on 503-555-0142, ZIP 97211, after 2 PM.')).toBeNull()
  expect(partialPhoneNumberIn('Leak at 1450 Southeast Division Street, Portland 97202.')).toBeNull()
})

test('what the caller said during a step is passed back, so their question is answered', () => {
  const ctx = llm.ChatContext.empty()
  ctx.addMessage({ role: 'assistant', content: 'Could you spell your last name?' })
  ctx.addMessage({ role: 'user', content: 'K I M. When do you open?' })
  expect(saidMeanwhile(ctx.items)).toBe(
    ' While you got it the caller said: "K I M. When do you open?" If they asked or wanted anything else, answer that now before you go on.',
  )
  expect(saidMeanwhile([])).toBe('')
})

test('after a step, a quiet assistant is asked once to go on; not while it replies or the caller talks', () => {
  vi.useFakeTimers()
  const session = (agentState: string, userState = 'listening') => ({ agentState, userState, generateReply: vi.fn() })
  const quiet = session('listening')
  const replying = session('thinking')
  const callerTalks = session('listening', 'speaking')
  for (const s of [quiet, replying, callerTalks]) nudgeIfQuiet(s)
  vi.advanceTimersByTime(3000)
  expect(quiet.generateReply).toHaveBeenCalledOnce()
  expect(replying.generateReply).not.toHaveBeenCalled()
  expect(callerTalks.generateReply).not.toHaveBeenCalled()
  // The call ended meanwhile: the closing session throws, the nudge must not.
  const closed = {
    agentState: 'listening',
    userState: 'listening',
    generateReply: vi.fn(() => {
      throw new Error('AgentSession is closing, cannot use generateReply()')
    }),
  }
  nudgeIfQuiet(closed)
  expect(() => vi.advanceTimersByTime(3000)).not.toThrow()
  vi.useRealTimers()
})

test('a step knows today, but no list of days', () => {
  expect(todayFact('2026-11-12')).toBe('Today is Thursday, November 12, 2026.')
})

describe('a question during a step (LIN-103)', () => {
  it('hands the question back to the assistant with what was heard so far', () => {
    const step = new Collection(phoneCollector('callback number'))
    // Before the caller said anything in the step there is nothing to hand back: words from earlier in the call.
    expect(step.handBack('Can the owner call me back?')).toEqual({ say: ASK_FIRST })
    step.heardCaller()
    step.record({ phone_number: '503 555' })
    const reply = step.handBack('Which date is Wednesday next week?')
    expect(reply.outcome).toEqual({
      status: 'question',
      label: 'callback number',
      question: 'Which date is Wednesday next week?',
      partial: '503 555',
    })
    const told = describeOutcome(reply.outcome!)
    expect(told).toContain('the caller asked: "Which date is Wednesday next week?"')
    expect(told).toContain('get it again with the same tool')
    expect(outcomeEvent(reply.outcome!)).toBe("Callback number paused for the caller's question")
  })

  it('never puts the caller off twice in a row: asking again after a put-off goes back to the assistant', () => {
    const putOff = "I'll come back to that in a moment. What's the best number to reach you?"
    expect(putsOff(putOff)).toBe(true)
    expect(putsOff('Could you share the phone number you would like us to use?')).toBe(false)
    expect(askedAgainAfterPutOff(putOff, 'Can you just give me next Friday’s date?')).toBe(true)
    expect(askedAgainAfterPutOff(putOff, 'which date is that')).toBe(true)
    // An answer to the step's question stays in the step; so does a first question.
    expect(askedAgainAfterPutOff(putOff, '503 555 0142')).toBe(false)
    expect(askedAgainAfterPutOff('What is the best number to reach you?', 'Which date is Wednesday?')).toBe(false)
    expect(askedAgainAfterPutOff(undefined, 'Which date is Wednesday?')).toBe(false)
  })

  it('gives the step today and the opening hours to answer from, no list of days', () => {
    const facts = stepFacts({
      today: '2026-11-12',
      hours: 'Open now, until 6 PM.',
      address: ' 1200 SE Morrison St, Portland ',
    })
    expect(facts).toContain('Today is Thursday, November 12, 2026.')
    expect(facts).not.toContain('2026-11-18')
    expect(facts).toContain('Opening hours: Open now, until 6 PM.')
    expect(facts).toContain('Business address: 1200 SE Morrison St, Portland')
    expect(stepFacts({ today: '2026-11-12' })).not.toContain('Business')
  })
})

describe('syncCallerSilence', () => {
  const flag = (isSet: boolean) => ({ isSet, set: vi.fn() })

  it('marks the caller silent on the resumed assistant when the session says they are not talking', () => {
    for (const userState of ['listening', 'away']) {
      const silence = flag(false)
      syncCallerSilence({ userState, _activity: { userSilenceEvent: silence } })
      expect(silence.set).toHaveBeenCalledOnce()
    }
  })

  it('leaves it while the caller talks, when it is set already, or when there is no assistant', () => {
    const talking = flag(false)
    syncCallerSilence({ userState: 'speaking', _activity: { userSilenceEvent: talking } })
    expect(talking.set).not.toHaveBeenCalled()
    const silent = flag(true)
    syncCallerSilence({ userState: 'listening', _activity: { userSilenceEvent: silent } })
    expect(silent.set).not.toHaveBeenCalled()
    expect(() => syncCallerSilence({ userState: 'listening' })).not.toThrow()
  })
})
