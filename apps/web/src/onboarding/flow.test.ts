import { resumeStep } from '@linedesk/actions'
import { expect, test } from 'vitest'
import {
  assistantChanges,
  buyQuestion,
  carriers,
  firstHoursDraft,
  firstPickup,
  formatNumber,
  forwardingCode,
  forwardingDigits,
  forwardingOffer,
  NO_PICKUP_MEMORY,
  nextStep,
  oldForwardingAfter,
  phoneOptionSetup,
  phoneOptions,
  phoneSetupInput,
  pickupNeedsHours,
  pickupNumberMode,
  pickupSettings,
  previousStep,
  progress,
  renameInGreeting,
  toE164,
} from './flow.ts'

test('steps run business → assistant → pick-up → phone → done, and back', () => {
  expect(nextStep('business')).toBe('assistant')
  expect(nextStep('assistant')).toBe('pickup')
  expect(nextStep('pickup')).toBe('phone')
  expect(nextStep('phone')).toBe('done')
  expect(nextStep('done')).toBe('done')
  expect(previousStep('business')).toBeNull()
  expect(previousStep('pickup')).toBe('assistant')
  expect(previousStep('done')).toBe('phone')
  expect(progress('business', false)).toBe(0)
  expect(progress('assistant', true)).toBe(40)
  expect(progress('done', true)).toBe(100)
})

test('a workspace on a step of the earlier flow resumes at the step that took its place', () => {
  expect(resumeStep('hours')).toBe('pickup')
  expect(resumeStep('calendar')).toBe('assistant')
  expect(resumeStep('test_call')).toBe('assistant')
  expect(resumeStep('phone')).toBe('phone')
  expect(resumeStep('business')).toBe('business')
})

test("pick-up: when I can't answer by default; every call forwards all; only after hours asks for hours", () => {
  expect(firstPickup(null)).toBe('no_answer')
  expect(firstPickup({ pickupMode: null })).toBe('no_answer')
  expect(firstPickup({ pickupMode: 'always' })).toBe('always')
  // Never chosen, but the number already forwards every call: that is what the step shows, not a silent switch.
  expect(firstPickup({ pickupMode: null }, 'forward_all')).toBe('always')
  expect(firstPickup({ pickupMode: null }, 'forward_conditional')).toBe('no_answer')
  expect(firstPickup({ pickupMode: 'no_answer' }, 'forward_all')).toBe('no_answer')
  expect(pickupNumberMode('no_answer')).toBe('forward_conditional')
  expect(pickupNumberMode('after_hours')).toBe('forward_conditional')
  expect(pickupNumberMode('always')).toBe('forward_all')
  expect(pickupNeedsHours('after_hours')).toBe(true)
  expect(pickupNeedsHours('no_answer')).toBe(false)
  expect(pickupNeedsHours('always')).toBe(false)
})

test('only when closed turns the hours on, and leaving it turns them back', () => {
  const none = NO_PICKUP_MEMORY
  // Hours were off: turned on, remembered as off, and off again when another choice follows.
  const on = pickupSettings({ pickupMode: null, businessHoursOn: false }, 'after_hours', none)
  expect(on).toEqual({ input: { pickupMode: 'after_hours', businessHoursOn: true }, hoursOnBefore: false })
  expect(
    pickupSettings({ pickupMode: 'after_hours', businessHoursOn: true }, 'no_answer', {
      ...none,
      hoursOnBefore: false,
    }),
  ).toEqual({ input: { pickupMode: 'no_answer', businessHoursOn: false }, hoursOnBefore: null })
  // Hours were on before: they stay on.
  expect(
    pickupSettings({ pickupMode: 'after_hours', businessHoursOn: true }, 'always', { ...none, hoursOnBefore: true })
      .input,
  ).toEqual({ pickupMode: 'always', businessHoursOn: true })
  // Not known (a reload in between): onboarding turned them on, so off.
  expect(pickupSettings({ pickupMode: 'after_hours', businessHoursOn: true }, 'always', none).input).toEqual({
    pickupMode: 'always',
    businessHoursOn: false,
  })
  // The other choices leave the hours alone.
  expect(pickupSettings({ pickupMode: 'no_answer', businessHoursOn: true }, 'always', none).input).toEqual({
    pickupMode: 'always',
  })
})

test('the old forwarding to turn off is the one dialled first, until the choice goes back to it', () => {
  expect(oldForwardingAfter('forward_all', 'forward_conditional', null)).toBe('forward_all')
  expect(oldForwardingAfter('forward_conditional', 'forward_all', 'forward_all')).toBeNull()
  expect(oldForwardingAfter('forward_all', 'forward_all', 'forward_conditional')).toBe('forward_conditional')
})

test('the assistant step saves only what changed', () => {
  const saved = {
    name: 'Maya',
    greeting: 'Thanks for calling. This is Maya.',
    voice: { provider: 'elevenlabs', voice_id: '' },
  }
  expect(assistantChanges(saved, { ...saved, name: ' Maya ' })).toBeNull()
  expect(assistantChanges(saved, { ...saved, name: 'Ava', greeting: 'Thanks for calling. This is Ava.' })).toEqual({
    name: 'Ava',
    greeting: 'Thanks for calling. This is Ava.',
  })
  expect(assistantChanges(saved, { ...saved, greeting: '  ' })).toBeNull()
  // A rename renames the saved name in the greeting once, on save; an emptied name renames nothing.
  expect(assistantChanges(saved, { ...saved, name: 'Ava' })).toEqual({
    name: 'Ava',
    greeting: 'Thanks for calling. This is Ava.',
  })
  expect(assistantChanges(saved, { ...saved, name: '' })).toBeNull()
  expect(assistantChanges(saved, { ...saved, voice: { provider: 'elevenlabs', voice_id: 'v1' } })).toEqual({
    voice: { provider: 'elevenlabs', voice_id: 'v1' },
  })
})

test('the hours step starts at 9 to 5 on weekdays in the browser zone, or shows what was saved', () => {
  const fresh = firstHoursDraft(
    { businessHours: [], businessHoursOn: false, timeZone: 'America/New_York' },
    'America/Los_Angeles',
  )
  expect(fresh.on).toBe(true)
  expect(fresh.timeZone).toBe('America/Los_Angeles')
  expect(fresh.days.filter(d => d.open).map(d => [d.weekday, d.start, d.end])).toEqual(
    [1, 2, 3, 4, 5].map(w => [w, '09:00', '17:00']),
  )
  expect(
    firstHoursDraft({ businessHours: [], businessHoursOn: false, timeZone: 'America/Denver' }, null).timeZone,
  ).toBe('America/Denver')
  const back = firstHoursDraft(
    {
      businessHours: [{ weekday: 6, start: '10:00', end: '14:00' }],
      businessHoursOn: false,
      timeZone: 'America/Denver',
    },
    'America/Los_Angeles',
  )
  expect(back).toMatchObject({ on: false, timeZone: 'America/Denver' })
  expect(back.days.filter(d => d.open).map(d => d.weekday)).toEqual([6])
})

test('US numbers are read the way people type them', () => {
  expect(toE164('(503) 555-0142')).toBe('+15035550142')
  expect(toE164('+1 503.555.0142')).toBe('+15035550142')
  expect(toE164('15035550142')).toBe('+15035550142')
  expect(toE164('555-0142')).toBeNull()
  expect(formatNumber('+15035550142')).toBe('+1 503 555 0142')
})

test('an existing number is attached and never bought, forwarding as chosen', () => {
  expect(phoneSetupInput({ kind: 'existing', number: '(503) 555-0142' })).toEqual({
    input: { e164: '+15035550142', purchase: false },
  })
  expect(phoneSetupInput({ kind: 'existing', number: '(503) 555-0142' }, 'forward_all')).toEqual({
    input: { e164: '+15035550142', purchase: false, mode: 'forward_all' },
  })
  expect(phoneSetupInput({ kind: 'existing', number: '0142' })).toHaveProperty('problem')
})

test('a bought number the business forwards to is bought with that forwarding, not as a new number to give out', () => {
  expect(phoneSetupInput({ kind: 'new', areaCode: '503', confirmed: true }, 'forward_conditional')).toEqual({
    input: { areaCode: '503', purchase: true, mode: 'forward_conditional' },
  })
  expect(phoneSetupInput({ kind: 'new', areaCode: '503', confirmed: true }, 'forward_all')).toEqual({
    input: { areaCode: '503', purchase: true, mode: 'forward_all' },
  })
})

test('the phone step leads with keeping the business number; a new number to give out comes last', () => {
  expect(phoneOptions(true)).toEqual(['forward', 'existing', 'new'])
  expect(phoneOptions(false)).toEqual(['forward', 'new'])
  const fields = { number: '(503) 555-0142', areaCode: '503', confirmed: true }
  // Every pick-up choice: keeping the number buys a number to forward to, with the forwarding the choice needs.
  for (const pickup of ['no_answer', 'after_hours', 'always'] as const) {
    const forwarding = pickupNumberMode(pickup)
    expect(phoneOptionSetup('forward', fields, forwarding)).toEqual({
      input: { areaCode: '503', purchase: true, mode: forwarding },
    })
    expect(phoneOptionSetup('existing', fields, forwarding)).toEqual({
      input: { e164: '+15035550142', purchase: false, mode: forwarding },
    })
    // Giving callers a new number is the only way to a number that nothing forwards to.
    expect(phoneOptionSetup('new', fields, forwarding)).toEqual({
      input: { areaCode: '503', purchase: true, mode: 'new' },
    })
  }
  expect(phoneOptionSetup('forward', { ...fields, confirmed: false }, 'forward_conditional')).toEqual({
    problem: 'Confirm the monthly cost first.',
  })
})

test('a new number given out offers forwarding from the current number, as the pick-up choice asks', () => {
  expect(forwardingOffer('new', 'no_answer')).toBe('forward_conditional')
  expect(forwardingOffer('new', 'after_hours')).toBe('forward_conditional')
  expect(forwardingOffer('new', 'always')).toBe('forward_all')
  // Already forwarded to, or moved over: nothing to offer.
  for (const mode of ['forward_conditional', 'forward_all', 'ported'] as const)
    expect(forwardingOffer(mode, 'no_answer')).toBeNull()
})

test('a new number is only requested with purchase after the user confirmed the cost', () => {
  expect(phoneSetupInput({ kind: 'new', areaCode: '503', confirmed: false })).toEqual({
    problem: 'Confirm the monthly cost first.',
  })
  expect(phoneSetupInput({ kind: 'new', areaCode: '50', confirmed: true })).toHaveProperty('problem')
  expect(phoneSetupInput({ kind: 'new', areaCode: '503', confirmed: true })).toEqual({
    input: { areaCode: '503', purchase: true, mode: 'new' },
  })
})

test('forwarding codes per carrier', () => {
  const digits = forwardingDigits('+15035550142')
  expect(digits).toBe('5035550142')
  expect(carriers.map(c => [c.name, c.on(digits), c.off])).toEqual([
    ['Verizon', '*715035550142', '*73'],
    ['AT&T', '**004*5035550142#', '##004#'],
    ['T-Mobile', '**004*5035550142#', '##004#'],
  ])
  const [verizon, att] = carriers
  expect(forwardingCode(verizon!, 'forward_all', '+15035550142')).toEqual({ on: '*725035550142', off: '*73' })
  expect(forwardingCode(att!, 'forward_all', '+15035550142')).toEqual({ on: '**21*5035550142#', off: '##21#' })
  expect(forwardingCode(att!, 'forward_conditional', '+15035550142')).toEqual({
    on: '**004*5035550142#',
    off: '##004#',
  })
})

test('renaming the assistant keeps the greeting in step', () => {
  expect(renameInGreeting('Thanks for calling Brightwater. This is Maya, the AI assistant.', 'Maya', 'Ava')).toBe(
    'Thanks for calling Brightwater. This is Ava, the AI assistant.',
  )
  expect(renameInGreeting('Hi, Mayan Plumbing here.', 'Maya', 'Ava')).toBe('Hi, Mayan Plumbing here.')
  expect(renameInGreeting('Hello', 'Maya', 'Maya')).toBe('Hello')
})

test('the buy question does not speak of a bill in development mode', () => {
  expect(buyQuestion('telnyx', '503')).toMatch(/billed every month/)
  expect(buyQuestion('dev', '503')).not.toMatch(/billed every month/)
})
