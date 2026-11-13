import { resumeStep } from '@linedesk/actions'
import { expect, test } from 'vitest'
import {
  assistantChanges,
  buyQuestion,
  carriers,
  firstHoursDraft,
  firstPickup,
  DEFAULT_URGENT_CONDITION,
  FALLBACK_OWNER_NAME,
  firstWhoHears,
  formatNumber,
  phoneSetupErrorText,
  forwardingCode,
  mobileErrorText,
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
  URGENT_CONTACT_ID,
  whoHearsProblem,
  whoHearsTransfers,
} from './flow.ts'
import { DEFAULT_TRANSFERS, type TransferContact } from '@linedesk/db/types'

test('steps run business → assistant → pick-up → who hears → phone → done, and back', () => {
  expect(nextStep('business')).toBe('assistant')
  expect(nextStep('assistant')).toBe('pickup')
  expect(nextStep('pickup')).toBe('notify')
  expect(nextStep('notify')).toBe('phone')
  expect(nextStep('phone')).toBe('done')
  expect(nextStep('done')).toBe('done')
  expect(previousStep('business')).toBeNull()
  expect(previousStep('pickup')).toBe('assistant')
  expect(previousStep('notify')).toBe('pickup')
  expect(previousStep('phone')).toBe('notify')
  expect(previousStep('done')).toBe('phone')
  expect(progress('business', false)).toBe(0)
  expect(progress('assistant', true)).toBe(33)
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

const settingsContact: TransferContact = {
  id: 'tc_2',
  name: 'Dana',
  number: '+15035550188',
  condition: 'Billing questions',
  hours_only: false,
  ring_seconds: 25,
  if_no_answer: 'message',
  enabled: true,
}

const withNumber = (c: TransferContact, number: string | null): TransferContact => ({ ...c, number })
const person = DEFAULT_TRANSFERS[0]!

test("who hears: a new workspace starts empty with urgent calls on; only the person contact's number is offered", () => {
  expect(firstWhoHears(DEFAULT_TRANSFERS)).toEqual({ mobile: '', urgentOn: true, condition: DEFAULT_URGENT_CONDITION })
  // Dana's billing line is not the owner's mobile.
  expect(firstWhoHears([...DEFAULT_TRANSFERS, settingsContact]).mobile).toBe('')
  expect(firstWhoHears([withNumber(person, '+15035550177'), settingsContact]).mobile).toBe('+1 503 555 0177')
})

test('who hears: the mobile must be a US mobile or landline; urgent calls need one and a condition', () => {
  const ok = { mobile: '(503) 555-0142', urgentOn: true, condition: 'Flooding' }
  const field = (d: typeof ok, list: TransferContact[] = []) => whoHearsProblem(d, list)
  expect(field(ok)).toBeNull()
  expect(field({ ...ok, mobile: '555-0142' })).toMatchObject({
    field: 'mobile',
    message: expect.stringMatching(/area code/),
  })
  expect(field({ ...ok, mobile: '900 555 0142' })?.message).toMatch(/Premium-rate/)
  expect(field({ ...ok, mobile: '800 555 0142' })?.message).toMatch(/Toll-free/)
  expect(field({ ...ok, mobile: '' })).toMatchObject({
    field: 'mobile',
    message: expect.stringMatching(/turn urgent calls off/),
  })
  // An empty condition is the condition's problem, not the mobile's.
  expect(field({ ...ok, condition: '  ' })?.field).toBe('condition')
  expect(field({ mobile: '', urgentOn: false, condition: '' })).toBeNull()
  // A full list cannot take the step's contact.
  const full = Array.from({ length: 10 }, (_, i) => ({ ...settingsContact, id: `tc_${i}`, name: `Contact ${i}` }))
  expect(field(ok, full)?.field).toBe('list')
})

test('who hears: in a new workspace its contact goes first, rings at any hour, takes a message', () => {
  const draft = { mobile: '503-555-0142', urgentOn: true, condition: ' Flooding ' }
  const saved = whoHearsTransfers(DEFAULT_TRANSFERS, draft, 'Mike Brennan')!
  expect(saved.map(c => c.id)).toEqual([URGENT_CONTACT_ID, 'person'])
  expect(saved[0]).toEqual({
    id: URGENT_CONTACT_ID,
    name: 'Mike Brennan',
    number: '+15035550142',
    condition: 'Flooding',
    hours_only: false,
    ring_seconds: 25,
    if_no_answer: 'message',
    enabled: true,
  })
  expect(saved[1]).toEqual(person)
  // Back on the step: its own contact shows, and saving it unchanged changes nothing.
  expect(firstWhoHears(saved)).toEqual({ mobile: '+1 503 555 0142', urgentOn: true, condition: 'Flooding' })
  expect(whoHearsTransfers(saved, firstWhoHears(saved), 'Mike Brennan')).toBeNull()
  // Turned off: the number stays on a switched-off contact, in the same place.
  const off = whoHearsTransfers(saved, { ...firstWhoHears(saved), urgentOn: false }, 'Mike Brennan')!
  expect(off[0]).toMatchObject({ id: URGENT_CONTACT_ID, enabled: false, number: '+15035550142' })
  expect(off).toHaveLength(2)
})

test('who hears: contacts set up in Settings keep their place; the new one goes last', () => {
  const draft = { mobile: '503-555-0142', urgentOn: true, condition: 'Flooding' }
  const saved = whoHearsTransfers([...DEFAULT_TRANSFERS, settingsContact], draft, 'Mike Brennan')!
  expect(saved.map(c => c.id)).toEqual(['person', 'tc_2', URGENT_CONTACT_ID])
  expect(saved[1]).toEqual(settingsContact)
})

test('who hears: nothing to save without a mobile; a taken, long or missing name gets a free one', () => {
  expect(whoHearsTransfers(DEFAULT_TRANSFERS, { mobile: '', urgentOn: false, condition: '' }, 'Mike')).toBeNull()
  const draft = { mobile: '5035550142', urgentOn: true, condition: 'Flooding' }
  expect(whoHearsTransfers(DEFAULT_TRANSFERS, draft, 'owner')![0]!.name).toBe('owner 2')
  expect(whoHearsTransfers(DEFAULT_TRANSFERS, draft, 'x'.repeat(80))![0]!.name).toHaveLength(60)
  const unnamed = whoHearsTransfers(DEFAULT_TRANSFERS, draft, '  ')!
  expect(unnamed[0]!.name).toBe(FALLBACK_OWNER_NAME)
  // Once the member's name is known, the contact gets it.
  expect(whoHearsTransfers(unnamed, firstWhoHears(unnamed), 'Mike Brennan')![0]!.name).toBe('Mike Brennan')
  expect(whoHearsTransfers(unnamed, firstWhoHears(unnamed), '')).toBeNull()
})

test("who hears: refusals about its own contact read as the step's own words; others as the server says", () => {
  expect(mobileErrorText("Mike's number is a Linedesk number; enter the person's own phone", 'Mike')).toMatch(
    /Enter your own mobile/,
  )
  expect(mobileErrorText("Mike's number forwards its calls to Linedesk; enter the person's own phone", 'Mike')).toMatch(
    /That number forwards its calls/,
  )
  const other = "Dana's number is a Linedesk number; enter the person's own phone"
  expect(mobileErrorText(other, 'Mike')).toBe(other)
  expect(mobileErrorText('Confirm your email first', 'Mike')).toMatch(/Confirm your email address/)
})

test('a carrier failure says what it is and who fixes it (LIN-111)', () => {
  expect(phoneSetupErrorText('telnyx: POST /number_orders: Authentication failed (HTTP 401)')).toBe(
    'The phone carrier rejected the key it was given. Ask whoever runs this server to check the key.',
  )
  expect(phoneSetupErrorText('telnyx: POST /number_orders: Insufficient balance (HTTP 402)', 'admin')).toMatch(
    /^The phone carrier has used up its quota or credit\. .*Admin › Providers\.$/,
  )
  expect(phoneSetupErrorText('telnyx: POST /number_orders: number is not valid (HTTP 422)')).toBe(
    "The number couldn't be connected. Try again in a moment.",
  )
})

test('a missing phone carrier sends admins to Admin › Providers (LIN-111)', () => {
  expect(phoneSetupErrorText('phone setup is not configured', 'admin')).toMatch(/under Admin › Providers\.$/)
  expect(phoneSetupErrorText('phone setup is not configured', 'member')).toMatch(/Ask whoever runs it/)
})
