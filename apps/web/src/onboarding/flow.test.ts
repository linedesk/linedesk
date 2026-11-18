import { forwardingGuideById, resumeStep, stepFor } from '@linedesk/actions'
import { DEFAULT_TRANSFERS, type TransferContact } from '@linedesk/db/types'
import { describe, expect, it, test } from 'vitest'
import {
  activationSteps,
  activationTimeline,
  trialSteps,
  EMERGENCY_NOTE,
  ALSO_PERSON,
  areaCodeIn,
  areaCodeOf,
  assistantChanges,
  billedNumberNote,
  doneState,
  rejectionStep,
  urgentCasesFrom,
  buyQuestion,
  buyingCountry,
  buyUnavailableText,
  carrierName,
  DEFAULT_URGENT_CONDITION,
  dialPath,
  existingLinkText,
  FALLBACK_OWNER_NAME,
  firstHoursDraft,
  firstPickup,
  firstWhoHears,
  formatNumber,
  isNoneFreeText,
  phoneSetupErrorText,
  priceCountry,
  priceNote,
  forwardingOffer,
  mobileErrorText,
  NO_PICKUP_MEMORY,
  nextStep,
  onboardingSteps,
  offersBuying,
  oldForwardingAfter,
  phoneOptionSetup,
  phoneOptionText,
  phoneOptions,
  phoneSetupInput,
  pickupNeedsHours,
  pickupNumberMode,
  pickupSettings,
  previousStep,
  progress,
  renameInGreeting,
  toE164,
  turnOffFirst,
  URGENT_CONTACT_ID,
  type WhoHearsDraft,
  whoHearsProblem,
  whoHearsTransfers,
} from './flow.ts'

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

test('an existing number from the phone field is sent in E.164, in any country', () => {
  expect(phoneSetupInput({ kind: 'existing', number: '+15035550142' })).toEqual({
    input: { e164: '+15035550142', purchase: false },
  })
  expect(phoneSetupInput({ kind: 'existing', number: '+4930123456' }, 'forward_all')).toEqual({
    input: { e164: '+4930123456', purchase: false, mode: 'forward_all' },
  })
  // Never read as a US number (toE164 alone would make +4930123456 into +14930123456).
  expect(phoneSetupInput({ kind: 'existing', number: '+4930' })).toEqual({
    problem: "This number doesn't look complete for Germany.",
  })
  expect(phoneSetupInput({ kind: 'existing', number: '' })).toEqual({
    problem: 'Enter the number with its area code, like +1 503 555 0100.',
  })
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
  // Two cards for everyone; a number already in the carrier account is a link (admins only), not a card.
  expect(phoneOptions).toEqual(['forward', 'new'])
  expect(existingLinkText('Telnyx')).toBe('Already have a number in Telnyx? Use it')
  expect(existingLinkText(null)).toBe('Already have a number? Use it')
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
  // Only an area code from the list: not toll-free, N11 or 555.
  for (const areaCode of ['800', '411', '555'])
    expect(phoneSetupInput({ kind: 'new', areaCode, confirmed: true })).toEqual({
      problem: 'Pick an area code for the new number from the list.',
    })
  expect(phoneSetupInput({ kind: 'new', areaCode: '503', confirmed: true })).toEqual({
    input: { areaCode: '503', purchase: true, mode: 'new' },
  })
})

test('an earlier forwarding is turned off with its own codes, or where it was set', () => {
  const tmobile = forwardingGuideById('tmobile')!
  expect(turnOffFirst(tmobile, 'forward_all', '+15035550142')).toBe(
    'Dialled the earlier code already? Turn that forwarding off first with ##21#.',
  )
  expect(turnOffFirst(tmobile, 'forward_conditional', '+15035550142')).toMatch(/##61#, ##67#, ##62#\.$/)
  expect(turnOffFirst(forwardingGuideById('ringcentral')!, 'forward_all', '+15035550142')).toBe(
    'Set up the earlier forwarding already? Turn it off first in the RingCentral app or admin portal.',
  )
  // Google Fi has no missed-calls forwarding: nothing to name.
  expect(turnOffFirst(forwardingGuideById('google-fi')!, 'forward_conditional', '+15035550142')).toBe(
    'Turned on forwarding earlier? Turn it off first.',
  )
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

describe('dialPath', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15'
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'
  it('copies on an iPhone or iPad, since iOS may not open tel: links with * or #', () => {
    expect(dialPath(iphone, 5, true)).toBe('copy')
    expect(dialPath(ipad, 5, true)).toBe('copy')
  })
  it('dials on Android and shows the QR code on a laptop', () => {
    expect(dialPath(android, 5, true)).toBe('dial')
    expect(dialPath(ipad, 0, false)).toBe('qr')
  })
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

test("who hears: a new workspace starts with no urgent-matter choice; only the person contact's number is offered", () => {
  // Nothing saved yet: "Take a message and alert me" is chosen, so Continue works without picking first.
  expect(firstWhoHears(DEFAULT_TRANSFERS)).toEqual({
    urgent: 'message',
    mobile: '',
    condition: DEFAULT_URGENT_CONDITION,
  })
  // Dana's billing line is not the owner's mobile.
  expect(firstWhoHears([...DEFAULT_TRANSFERS, settingsContact]).mobile).toBe('')
  expect(firstWhoHears([withNumber(person, '+15035550177'), settingsContact]).mobile).toBe('+1 503 555 0177')
})

test('who hears: Continue needs a choice; only "put through" needs a valid mobile and a condition', () => {
  const ok = { urgent: 'transfer' as const, mobile: '(503) 555-0142', condition: 'Flooding' }
  const field = (d: WhoHearsDraft, list: TransferContact[] = []) => whoHearsProblem(d, list)
  expect(field(ok)).toBeNull()
  expect(field({ ...ok, urgent: null })).toMatchObject({ field: 'choice', message: expect.stringMatching(/Choose/) })
  // "Take a message" needs no number, also with an empty or broken one left in the hidden field.
  expect(field({ urgent: 'message', mobile: '', condition: '' })).toBeNull()
  expect(field({ urgent: 'message', mobile: '555', condition: '' })).toBeNull()
  expect(field({ ...ok, mobile: '' })).toMatchObject({ field: 'mobile', message: expect.stringMatching(/mobile/) })
  expect(field({ ...ok, mobile: '555-0142' })).toMatchObject({
    field: 'mobile',
    message: expect.stringMatching(/area code/),
  })
  expect(field({ ...ok, mobile: '900 555 0142' })?.message).toMatch(/Premium-rate/)
  expect(field({ ...ok, mobile: '800 555 0142' })?.message).toMatch(/Toll-free/)
  // An empty condition is the condition's problem, not the mobile's.
  expect(field({ ...ok, condition: '  ' })?.field).toBe('condition')
  // A full list cannot take the step's contact; "take a message" still can go on.
  const full = Array.from({ length: 10 }, (_, i) => ({ ...settingsContact, id: `tc_${i}`, name: `Contact ${i}` }))
  expect(field(ok, full)?.field).toBe('list')
  expect(field({ ...ok, urgent: 'message' }, full)).toBeNull()
})

test('who hears: "put through" in a new workspace: one contact for urgent calls and callers who ask for a person', () => {
  const draft = { urgent: 'transfer' as const, mobile: '503-555-0142', condition: ' Flooding ' }
  const saved = whoHearsTransfers(DEFAULT_TRANSFERS, draft, 'Mike Brennan')!
  // The default "asks for a person" contact had no number: the owner's mobile serves it too, as one contact.
  expect(saved.map(c => c.id)).toEqual([URGENT_CONTACT_ID])
  expect(saved[0]).toEqual({
    id: URGENT_CONTACT_ID,
    name: 'Mike Brennan',
    number: '+15035550142',
    condition: `Flooding\n${ALSO_PERSON}`,
    hours_only: false,
    ring_seconds: 25,
    if_no_answer: 'message',
    enabled: true,
    // The owner's own mobile is announced too, like every new contact; Settings › Transfers turns it off.
    briefing: true,
  })
  // Back on the step: its own contact shows with its choice, and saving it unchanged changes nothing.
  expect(firstWhoHears(saved)).toEqual({ urgent: 'transfer', mobile: '+1 503 555 0142', condition: 'Flooding' })
  expect(whoHearsTransfers(saved, firstWhoHears(saved), 'Mike Brennan')).toBeNull()
  // Switched to "take a message": the contact is off and keeps its number and condition in the same place, even
  // when the hidden field was edited before switching.
  const off = whoHearsTransfers(saved, { urgent: 'message', mobile: '503 555 0199', condition: '' }, 'Mike Brennan')!
  expect(off[0]).toMatchObject({
    id: URGENT_CONTACT_ID,
    enabled: false,
    number: '+15035550142',
    condition: `Flooding\n${ALSO_PERSON}`,
  })
  expect(off).toHaveLength(1)
  // Edited on the step again: the person line stays.
  const edited = whoHearsTransfers(saved, { ...firstWhoHears(saved), condition: 'No heat' }, 'Mike Brennan')!
  expect(edited[0]!.condition).toBe(`No heat\n${ALSO_PERSON}`)
  expect(firstWhoHears(off).urgent).toBe('message')
})

test('who hears: contacts set up in Settings keep their place; the new one goes last', () => {
  const draft = { urgent: 'transfer' as const, mobile: '503-555-0142', condition: 'Flooding' }
  const saved = whoHearsTransfers([...DEFAULT_TRANSFERS, settingsContact], draft, 'Mike Brennan')!
  // The person contact without a number is taken over; Dana's stays where it was.
  expect(saved.map(c => c.id)).toEqual(['tc_2', URGENT_CONTACT_ID])
  // A person contact with its own number stays its own contact.
  const kept = whoHearsTransfers([withNumber(person, '+15035550177'), settingsContact], draft, 'Mike Brennan')!
  expect(kept.map(c => c.id)).toEqual(['person', 'tc_2', URGENT_CONTACT_ID])
  expect(kept[2]!.condition).toBe('Flooding')
  expect(saved[0]).toEqual(settingsContact)
})

test('who hears: nothing to save without a choice or for a first "take a message"; names stay free', () => {
  const draft = { urgent: 'transfer' as const, mobile: '5035550142', condition: 'Flooding' }
  expect(whoHearsTransfers(DEFAULT_TRANSFERS, { ...draft, urgent: null }, 'Mike')).toBeNull()
  // A number typed and then hidden by "take a message" is not saved.
  expect(whoHearsTransfers(DEFAULT_TRANSFERS, { ...draft, urgent: 'message' }, 'Mike')).toBeNull()
  expect(whoHearsTransfers([withNumber(person, '+15035550177')], draft, 'owner')![1]!.name).toBe('owner 2')
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

test('"Urgent means" starts from the urgent cases the common calls name', () => {
  const instructions =
    'We fix pipes.\n\nCommon calls:\n- When a caller has a leak, flooding or no heat, treat it as urgent: take their address.\n- When a caller asks about prices, give them.'
  expect(urgentCasesFrom(instructions)).toBe('A leak, flooding or no heat')
  expect(urgentCasesFrom('- When a caller has a court deadline this week, mark the message urgent.')).toBe(
    'A court deadline this week',
  )
  expect(urgentCasesFrom('We fix pipes.')).toBeNull()
  expect(firstWhoHears(DEFAULT_TRANSFERS, 'A leak').condition).toBe('A leak')
})

test('the area code comes from a number the owner gave, never an example', () => {
  expect(areaCodeOf('US', null, '+15035550142')).toBe('503')
  expect(areaCodeOf('US', '(206) 555-0100', '+15035550142')).toBe('206')
  expect(areaCodeOf('US', undefined, 'not a number')).toBe('')
  // A toll-free business number has no area code a number can be bought in: the next number gives it.
  expect(areaCodeOf('US', '+18005550100', '+15035550142')).toBe('503')
  expect(areaCodeOf('US', '+18885550100')).toBe('')
  // Another country's number is never read as a US one: +49 30 123456 has ten digits, but no area code 493.
  expect(areaCodeOf('US', '+4930123456')).toBe('')
  expect(areaCodeOf('US', '+4930123456', '+15035550142')).toBe('503')
  expect(areaCodeOf('US', '+442079460750')).toBe('')
  // Only the workspace country's codes: a Canadian number gives none in the US, its code in Canada.
  expect(areaCodeOf('US', '+14165550100')).toBe('')
  expect(areaCodeOf('CA', '+14165550100')).toBe('416')
  expect(areaCodeOf('CA', '+15035550142', '+16135550100')).toBe('613')
  expect(areaCodeOf('PR', '+17875550100')).toBe('787')
  // Jamaica's 876 is in no list.
  expect(areaCodeOf(null, '+18765550100')).toBe('')
  // While the country loads, any code a number can be bought in.
  expect(areaCodeOf(null, '+14165550100')).toBe('416')
  expect(areaCodeIn('416', 'CA')).toBe(true)
  expect(areaCodeIn('416', 'US')).toBe(false)
  expect(areaCodeIn('939', 'pr')).toBe(true)
  expect(areaCodeIn('416', null)).toBe(true)
  expect(areaCodeIn('876', null)).toBe(false)
  expect(phoneOptionSetup('new', { number: '', areaCode: '416', confirmed: true }, undefined as never)).toEqual({
    input: { areaCode: '416', purchase: true, mode: 'new' },
  })
  expect(phoneOptionSetup('new', { number: '', areaCode: '', confirmed: true }, undefined as never)).toEqual({
    problem: 'Pick an area code for the new number from the list.',
  })
})

test('a refused save names the step it came from', () => {
  expect(rejectionStep('assistant.update', { transfers: [] }, 'phone')).toBe('notify')
  expect(rejectionStep('assistant.update', { business_profile: {} }, 'pickup')).toBe('business')
  expect(rejectionStep('assistant.update', { greeting: 'Hi' }, 'pickup')).toBe('assistant')
  expect(rejectionStep('workspace.updateSettings', { pickupMode: 'always' }, 'phone')).toBe('pickup')
  expect(rejectionStep('businessHours.set', { hours: [] }, 'business')).toBe('business')
  expect(rejectionStep('push.subscribe', {}, 'phone')).toBe('notify')
  expect(rejectionStep('onboarding.setStep', { step: 'phone' }, 'notify')).toBeNull()
})

test('done says live only when calls are really answered', () => {
  const base = { voiceMissing: false, forwardingVerified: false, admin: false, assistant: 'Maya' }
  expect(doneState({ ...base, number: null })).toMatchObject({ live: false, left: [{ href: '#workspace/phone' }] })
  const forwarded = { e164: '+15035550142', mode: 'forward_conditional' as const }
  const almost = doneState({ ...base, number: forwarded })
  expect(almost.live).toBe(false)
  expect(almost.lede).toBe('Maya answers +1 503 555 0142 once forwarding is on.')
  expect(doneState({ ...base, number: forwarded, forwardingVerified: true }).title).toBe("You're live.")
  expect(doneState({ ...base, number: { ...forwarded, mode: 'new' } }).live).toBe(true)
  const noVoice = doneState({ ...base, number: { ...forwarded, mode: 'new' }, voiceMissing: true })
  expect(noVoice.left).toEqual([
    { label: "The voice service isn't working yet: ask whoever runs this server", href: null },
  ])
  expect(
    doneState({ ...base, admin: true, number: { ...forwarded, mode: 'new' }, voiceMissing: true }).left[0]!.href,
  ).toBe('#admin/providers/answering')
})

test('the phone options read the same in onboarding and Settings › Phone numbers', () => {
  expect(phoneOptionText('forward', 'Maya', 'Telnyx').title).toBe('Keep my number')
  expect(phoneOptionText('new', 'Maya', null).title).toBe('Give callers a new number')
  expect(phoneOptionText('existing', 'Maya', 'Twilio').title).toBe('Use a number you have in Twilio')
  expect(existingLinkText(null)).toBe('Already have a number? Use it')
})

test('carrier names come from the provider registry', () => {
  expect(carrierName('twilio')).toBe('Twilio')
  expect(carrierName('telnyx')).toBe('Telnyx')
  for (const none of ['dev', 'deepgram', 'nope', null, undefined]) expect(carrierName(none), String(none)).toBeNull()
})

test('a carrier failure says what it is and who fixes it (LIN-111)', () => {
  expect(phoneSetupErrorText('telnyx: POST /number_orders: Authentication failed (HTTP 401)')).toBe(
    'The phone carrier rejected the key it was given. Ask whoever runs this server to check the key.',
  )
  expect(phoneSetupErrorText('telnyx: POST /number_orders: Insufficient balance (HTTP 402)', 'admin')).toMatch(
    /^The phone carrier has used up its quota or credit\. .*Server admin › Providers\.$/,
  )
  expect(phoneSetupErrorText('telnyx: POST /number_orders: number is not valid (HTTP 422)')).toBe(
    "The number couldn't be connected. Try again in a moment.",
  )
})

test('buying a number is offered in the US, Canada and Puerto Rico, and as before while the country loads (LIN-300)', () => {
  for (const country of ['US', 'us', 'CA', 'PR']) expect(offersBuying(country), country).toBe(true)
  expect(offersBuying(null)).toBe(true)
  for (const country of ['DE', 'GB', 'MX', 'JM']) expect(offersBuying(country), country).toBe(false)
  expect(buyUnavailableText('Telnyx', true)).toBe(
    'Buying numbers is available in the US, Canada and Puerto Rico for now. Connect a number you already have in Telnyx.',
  )
  expect(buyUnavailableText(null, true)).toMatch(/Connect a number you already have with your carrier\.$/)
  expect(buyUnavailableText('Telnyx', false)).toMatch(/connect your own carrier account in Settings › Phone numbers\.$/)
  // The server's refusal (apps/api/src/number-purchases.ts) in the same words.
  expect(
    phoneSetupErrorText(
      'Buying numbers is available in the US, Canada and Puerto Rico for now; this workspace is in DE. Connect a number already in the carrier account instead: give its number (e164) without purchase.',
    ),
  ).toBe(buyUnavailableText(null, true))
  expect(
    phoneSetupErrorText(
      "Area code 416 is in Canada, but this workspace is in the United States: pick an area code there, or change the workspace's country first.",
    ),
  ).toBe('That area code is in another country than this workspace. Pick one from the list.')
  expect(
    phoneSetupErrorText(
      "Number +18765550100 is in Jamaica, but this workspace is in Canada: buy a number there, or change the workspace's country first.",
    ),
  ).toBe(
    "That number is in another country than this workspace, so it can't be bought here. Pick an area code from the list.",
  )
  // Carrier refusals in the server's own words (NUMBERS_NEED_DOCUMENTS, NUMBER_NOT_ACTIVATED): honest, no "try again".
  expect(
    phoneSetupErrorText("Numbers in this country can't be bought here yet: connect a number the business already has."),
  ).toBe("Numbers in this country can't be bought here yet. Connect a number the business already has.")
  expect(phoneSetupErrorText('This number could not be activated: try another area code.')).toBe(
    "That number couldn't be activated. Try another area code.",
  )
})

test('with no country set yet, the picker offers every buyable area code and the picked one sets the price', () => {
  expect(buyingCountry(null)).toBeNull()
  expect(buyingCountry({ country: 'US', known: false })).toBeNull()
  expect(buyingCountry({ country: 'CA', known: true })).toBe('CA')
  expect(areaCodeIn('787', buyingCountry({ country: 'US', known: false }))).toBe(true)
  expect(areaCodeIn('787', buyingCountry({ country: 'US', known: true }))).toBe(false)
  expect(priceCountry('787', null)).toBe('PR')
  expect(priceCountry('416', 'US')).toBe('CA')
  expect(priceCountry('', 'CA')).toBe('CA')
  expect(priceCountry('', null)).toBeNull()
})

test("the price note is the carrier's list price in the workspace's country", () => {
  expect(priceNote('telnyx')).toBe('About $1 a month plus call minutes, billed by Telnyx.')
  expect(priceNote('telnyx', 'CA')).toBe('About $1 a month plus call minutes, billed by Telnyx.')
  expect(priceNote('telnyx', 'PR')).toBe('About $3 a month plus call minutes, billed by Telnyx.')
  expect(priceNote('twilio', 'US')).toBe('About $1.15 a month plus call minutes, billed by Twilio.')
  expect(priceNote('twilio', 'PR')).toBe('About $3.25 a month plus call minutes, billed by Twilio.')
  expect(priceNote('twilio', 'DE')).toBe('A monthly fee plus call minutes, billed by Twilio.')
  expect(priceNote('dev', 'CA')).toBe('Development mode: nothing is bought, the number is not real.')
  expect(priceNote(null, 'CA')).toBe('A monthly fee plus call minutes, billed by your carrier.')
})

test('a missing phone carrier sends admins to Server admin › Providers (LIN-111)', () => {
  expect(phoneSetupErrorText('phone setup is not configured', 'admin')).toMatch(/under Server admin › Providers\.$/)
  expect(phoneSetupErrorText('phone setup is not configured', 'member')).toMatch(/Ask whoever runs it/)
})

test('the emergency note under "Urgent means" names the workspace country\'s number', () => {
  expect(EMERGENCY_NOTE('Maya')).toBe(
    'Emergencies (danger to people, fire, a gas smell): Maya tells the caller to hang up and call 911.',
  )
  expect(EMERGENCY_NOTE('Maya', 'AU')).toContain('call 000.')
  expect(EMERGENCY_NOTE('Maya', 'BR')).toContain('call the local emergency number.')
})

test('"no number available in area code" becomes the sentence that offers the nearby area codes (LIN-313)', () => {
  const text = phoneSetupErrorText('no number available in area code 416')
  expect(text).toBe('No number is free in that area code right now. Try a nearby one.')
  expect(isNoneFreeText(text)).toBe(true)
  expect(isNoneFreeText(phoneSetupErrorText('telnyx: POST /number_orders: Authentication failed (HTTP 401)'))).toBe(
    false,
  )
  expect(isNoneFreeText(null)).toBe(false)
})

test('on a bill, the price line says the first number is included and what each extra one costs', () => {
  expect(billedNumberNote(300, 'telnyx', 0)).toBe('Your first number is included in your plan.')
  expect(billedNumberNote(300, 'telnyx', 1)).toBe('Each extra number is $3 a month, paid from your balance.')
  expect(billedNumberNote(350, 'telnyx', 2)).toBe('Each extra number is $3.50 a month, paid from your balance.')
  // Off billing, a comped bill or the workspace's own carrier (null), and development mode: the carrier's line.
  expect(billedNumberNote(null, 'telnyx', 1)).toBeNull()
  expect(billedNumberNote(300, 'dev', 1)).toBeNull()
})

describe('the activation step (docs/billing.md §3.2)', () => {
  test('before the trial the steps end at activate; once it runs, activate is gone and the number follows', () => {
    expect(activationSteps).toEqual(['business', 'assistant', 'pickup', 'notify', 'activate'])
    expect(onboardingSteps).toEqual(['business', 'assistant', 'pickup', 'notify', 'phone', 'done'])
    expect(nextStep('notify', activationSteps)).toBe('activate')
    expect(nextStep('notify', onboardingSteps)).toBe('phone')
    expect(stepFor('phone', true)).toBe('activate')
    expect(stepFor('notify', true)).toBe('notify')
    expect(stepFor('activate', false)).toBe('phone')
  })

  test('a trial sign-up counts one way through: activate is step 5 of 7, the number 6 of 7', () => {
    expect(trialSteps).toEqual(['business', 'assistant', 'pickup', 'notify', 'activate', 'phone', 'done'])
    expect(trialSteps.indexOf('activate') + 1).toBe(5)
    expect(trialSteps.indexOf('phone') + 1).toBe(6)
  })

  test('the timeline: today (day 1) the trial, one line for the reminders 7 days and 1 day before, the first charge on day 15', () => {
    const now = new Date('2026-11-17T12:00:00Z')
    const firstChargeAt = '2026-12-01T12:00:00.000Z'
    expect(activationTimeline({ trialDays: 14, firstChargeAt, reminderDays: [1, 7] }, now)).toEqual([
      { kind: 'start', day: 1, at: now },
      {
        kind: 'reminders',
        before: [7, 1],
        at: [new Date('2026-11-24T12:00:00Z'), new Date('2026-11-30T12:00:00Z')],
      },
      { kind: 'charge', day: 15, at: new Date(firstChargeAt) },
    ])
    // A reminder day the trial is too short for is left out.
    expect(activationTimeline({ trialDays: 5, firstChargeAt, reminderDays: [7, 1] }, now)[1]).toEqual({
      kind: 'reminders',
      before: [1],
      at: [new Date('2026-11-30T12:00:00Z')],
    })
    // No reminder day fits: no reminder line.
    expect(activationTimeline({ trialDays: 1, firstChargeAt, reminderDays: [7, 1] }, now).map(e => e.kind)).toEqual([
      'start',
      'charge',
    ])
  })

  test('without a trial (one refused before): the charge today, nothing else', () => {
    const now = new Date('2026-11-17T12:00:00Z')
    expect(activationTimeline({ trialDays: null, firstChargeAt: null, reminderDays: [] }, now)).toEqual([
      { kind: 'charge', day: 1, at: now },
    ])
  })
})
