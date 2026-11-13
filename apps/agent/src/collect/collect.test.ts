import { llm } from '@livekit/agents'
import { describe, expect, it, test, vi } from 'vitest'
import { addedToMessage, nudgeIfQuiet, saidMeanwhile } from './collect-tools.ts'
import { Collection, describeOutcome, MAX_ATTEMPTS, outcomeEvent } from './collection.ts'
import { addressCollector, dateCollector, digitsCollector, emailCollector, isWholePhoneNumber, nameCollector, partialPhoneNumberIn, parseDate, phoneCollector, stateCode, toE164, upcomingDates } from './collectors.ts'
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
    expect(emailCollector.parse({ email: 'dana dot ruiz at gmail dot com' })).toEqual({ ok: true, value: 'dana.ruiz@gmail.com' })
    expect(emailCollector.parse({ email: 'dana ruiz' }).ok).toBe(false)
    expect(emailCollector.readBack('d.r@gmail.com')).toBe('D, dot, R, at, gmail dot com')
  })

  it('addresses are US: street with a number, a state, a 5-digit ZIP', () => {
    const parsed = addressCollector.parse({ street: '1450 SE Division Street', city: 'portland', state: 'Oregon', zip: 'nine seven two oh two' })
    expect(parsed).toEqual({ ok: true, value: { street: '1450 SE Division Street', unit: '', city: 'Portland', state: 'OR', zip: '97202' } })
    if (parsed.ok) {
      expect(addressCollector.display(parsed.value)).toBe('1450 SE Division Street, Portland, OR 97202')
      expect(addressCollector.readBack(parsed.value)).toBe('1450 SE Division Street, Portland, Oregon, ZIP 9 7 2 0 2')
    }
    expect(addressCollector.parse({ street: 'Division Street', city: 'Portland', state: 'OR' }).ok).toBe(false)
    expect(addressCollector.parse({ street: '1 Main St', city: 'Portland', state: 'Narnia' }).ok).toBe(false)
    expect(addressCollector.parse({ street: '1 Main St', city: 'Portland', state: 'OR', zip: '972' }).ok).toBe(false)
    expect(stateCode('n.y.')).toBe('NY')
  })

  it('dates: ISO, US and spoken forms; impossible dates and bounds refused', () => {
    expect(parseDate('2026-11-14', '2026-11-11')).toBe('2026-11-14')
    expect(parseDate('11/14', '2026-11-11')).toBe('2026-11-14')
    expect(parseDate('January 15th 1990', '2026-11-11')).toBe('1990-01-15')
    expect(parseDate('the 15th of Jan 90', '2026-11-11')).toBe('1990-01-15')
    expect(parseDate('February 30', '2026-11-11')).toBeNull()
    const day = dateCollector({ what: 'preferred day', today: '2026-11-11', notBefore: '2026-11-11' })
    expect(day.parse({ date: '2026-11-10' }).ok).toBe(false)
    expect(day.readBack('2026-11-14')).toBe('Saturday, November 14, 2026')
  })

  it('digits, with a length', () => {
    const zip = digitsCollector({ what: 'ZIP code', minDigits: 5, maxDigits: 5 })
    expect(zip.parse({ digits: 'nine seven two oh two' })).toEqual({ ok: true, value: '97202' })
    expect(zip.parse({ digits: '9720' }).ok).toBe(false)
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
    const declined = new Collection(emailCollector).decline('has no email')
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
  expect(saidMeanwhile(ctx.items)).toBe(' While you got it the caller said: "K I M. When do you open?" If they asked or wanted anything else, answer that now before you go on.')
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
  const closed = { agentState: 'listening', userState: 'listening', generateReply: vi.fn(() => { throw new Error('AgentSession is closing, cannot use generateReply()') }) }
  nudgeIfQuiet(closed)
  expect(() => vi.advanceTimersByTime(3000)).not.toThrow()
  vi.useRealTimers()
})

test('a phone number confirmed after the message was saved is added to it; nothing else is', async () => {
  const added: string[] = []
  const addToMessage = async (detail: string) => {
    added.push(detail)
    return true
  }
  const ctx = { addToMessage } as unknown as Parameters<typeof addedToMessage>[0]
  const confirmed = { status: 'confirmed', label: 'callback number', value: '+15035550142' } as const
  expect(await addedToMessage(ctx, phoneCollector(), confirmed)).toMatch(/added to the message/)
  expect(added).toEqual(['Callback number: +15035550142 (confirmed with the caller).'])
  expect(await addedToMessage(ctx, phoneCollector(), { status: 'incomplete', label: 'callback number', partial: '50355' })).toBe('')
  expect(await addedToMessage(ctx, nameCollector, { status: 'confirmed', label: 'name', value: 'Sam Patel' })).toBe('')
  // No message saved yet: the assistant puts the number into take_message itself.
  const none = { addToMessage: async () => false } as unknown as Parameters<typeof addedToMessage>[0]
  expect(await addedToMessage(none, phoneCollector(), confirmed)).toBe('')
  expect(added).toHaveLength(1)
})

test('the date step lists the next days with their weekday and date, so the model never counts days', () => {
  expect(upcomingDates('2026-11-12', 7)).toBe(
    'Today is Thursday 2026-11-12. The days after it: Friday 2026-11-13; Saturday 2026-11-14; Sunday 2026-11-15; Monday 2026-11-16; Tuesday 2026-11-17; Wednesday 2026-11-18; Thursday 2026-11-19.',
  )
  // Across a month and a year.
  expect(upcomingDates('2026-12-30', 3)).toContain('Thursday 2026-12-31; Friday 2027-01-01; Saturday 2027-01-02.')
  const day = dateCollector({ what: 'preferred day', today: '2026-11-12' })
  expect(day.instructions).toContain('Wednesday 2026-11-18')
  expect(day.instructions).toContain('never count days yourself')
})
