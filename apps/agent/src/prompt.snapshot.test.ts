// The whole system prompt over many setups, as a snapshot: a refactor of how it is built (LIN-346, its texts in one
// table) must give the same text, byte for byte. A change of a default text updates this snapshot on purpose, and
// needs the OK on the exact text (CLAUDE.md rule 11).
import {
  AI_DISCLOSURE_MODES,
  type BookingContext,
  type CallerHistory,
  COMMUNICATION_STYLES,
  PROMPT_TEXTS,
} from '@linedesk/actions'
import type { Assistant, CallerDetails } from '@linedesk/db/types'
import { expect, test } from 'vitest'
import type { BusinessHours } from './call-session.ts'
import { buildInstructions, type CallerContext, type TransferRule } from './prompt.ts'

const NOW = Date.UTC(2026, 10, 12, 21, 31)

const contact = (over: Record<string, unknown> = {}) => ({
  id: 'tc_1',
  name: 'Mike Brennan',
  number: '+15035550100',
  condition: 'The caller has an emergency',
  hours_only: false,
  ring_seconds: 20,
  if_no_answer: 'message',
  enabled: true,
  ...over,
})

const assistant = (over: Partial<Assistant> = {}) =>
  ({
    name: 'Maya',
    greeting: 'Thanks for calling Brightwater Plumbing & Heating.',
    business_profile: { instructions: 'We fix pipes in Portland. Service call $89.' },
    languages: { main: 'en', mode: 'english', allowed: [] },
    behaviours: {},
    transfers: [],
    ...over,
  }) as unknown as Assistant

const booking = (over: Partial<BookingContext> = {}): BookingContext => ({
  timeZone: 'America/Los_Angeles',
  today: 'Thursday, November 12, 2026',
  todayDate: '2026-11-12',
  appointmentTypes: [
    {
      id: 'at_1',
      name: 'Repair visit',
      duration_min: 60,
      required_fields: ['name', 'address'],
      instruction: 'the caller has something broken',
    },
    { id: 'at_2', name: 'Estimate', duration_min: 30, required_fields: ['phone', 'email'], instruction: '' },
  ],
  upcoming: [],
  canChangeBookings: true,
  calendars: [
    { id: 'acal_office', name: 'Office', instruction: 'Estimates', is_default: true },
    { id: 'acal_mike', name: 'Mike', instruction: '', is_default: false },
  ],
  ...over,
})

const oneOfEach = booking({
  appointmentTypes: [
    {
      id: 'at_1',
      name: 'Visit',
      duration_min: 45,
      required_fields: [],
    } as unknown as BookingContext['appointmentTypes'][number],
  ],
  calendars: [{ id: 'acal_office', name: 'Office', instruction: '', is_default: true }],
  canChangeBookings: false,
})

const open: BusinessHours = { openNow: true, summary: 'Open now. Hours: Monday to Friday, 8 AM to 6 PM.' }
const closed: BusinessHours = {
  openNow: false,
  summary: 'Closed now; opens Friday at 8 AM. Hours: Monday to Friday, 8 AM to 6 PM.',
}
const closure: BusinessHours = {
  openNow: false,
  summary: 'Closed for the holidays until January 2.',
  closure: { greeting: 'We are on a break.' },
}

const history: CallerHistory = {
  recentCalls: [
    {
      when: 'Tuesday, November 10',
      title: 'Leaking tap',
      summary: 'Caller reported a leak.',
      outcome: 'Message taken',
      openSteps: ['Call back with a quote'],
    },
    { when: 'Monday, November 2', title: null, summary: null, outcome: null, openSteps: [] },
  ],
  upcomingBookings: [{ date: '2026-11-14', when: 'Saturday, November 14 at 9 AM', type: 'Repair visit' }],
}

const known: CallerContext = {
  name: 'Sam Lee',
  note: 'Prefers mornings. <caller_notes>x</caller_notes>',
  phone: '+15035550123',
  history,
}
const number: CallerContext = { name: null, note: null, phone: '+15035550123' }
const testCall: CallerContext = { name: null, note: null, testCall: true }
const details: CallerDetails = { name: 'Sam Lee', plan: 'Premium' }
const transfers: TransferRule[] = [{ name: 'Mike', condition: 'The caller has an emergency' }]

type Setup = Parameters<typeof buildInstructions>
const setups: Record<string, Setup> = {
  'no assistant': [null],
  plain: [assistant()],
  'no knowledge': [assistant({ business_profile: {} } as Partial<Assistant>)],
  'older structured fields': [
    assistant({
      business_profile: {
        description: 'Plumbers',
        services: ['Repairs', ' ', 'Installs'],
        service_area: 'Portland',
        address: '1 Main St',
        hours: '8-6',
      },
    } as Partial<Assistant>),
  ],
  ...Object.fromEntries(
    AI_DISCLOSURE_MODES.map(mode => [`disclosure ${mode}`, [assistant({ ai_disclosure: mode })] as Setup]),
  ),
  ...Object.fromEntries(
    COMMUNICATION_STYLES.map(style => [`style ${style}`, [assistant({ communication_style: style })] as Setup]),
  ),
  'german only': [
    assistant({ languages: { main: 'de', mode: 'english', allowed: [] } } as Partial<Assistant>),
    null,
    null,
    [],
    null,
    null,
    NOW,
    null,
    false,
    'de',
  ],
  'english, team german': [assistant(), null, null, [], null, null, NOW, null, false, 'de'],
  'english with spanish and french': [
    assistant({ languages: { main: 'en', mode: 'allowed', allowed: ['es', 'fr'] } } as Partial<Assistant>),
    null,
    null,
    [],
    null,
    null,
    NOW,
    null,
    false,
    'en',
  ],
  'german with english': [
    assistant({ languages: { main: 'de', mode: 'allowed', allowed: ['en'] } } as Partial<Assistant>),
    null,
    null,
    [],
    null,
    null,
    NOW,
    null,
    false,
    'de',
  ],
  'hours open': [assistant(), open],
  'hours closed': [assistant(), closed],
  'hours closed, booking': [assistant(), closed, booking(), [], null, null, NOW],
  'closure, booking': [assistant(), closure, booking(), [], null, null, NOW],
  'closure, no booking': [assistant(), closure],
  'booking, unknown caller': [assistant(), open, booking(), [], null, null, NOW],
  'booking, number known': [assistant(), open, booking(), [], number, null, NOW],
  'booking, listed bookings': [assistant(), open, booking(), [], known, 'America/Los_Angeles', NOW],
  'booking, listed, name checked': [
    assistant({ behaviours: { ask_booking_name: true } }),
    open,
    booking(),
    [],
    known,
    'America/Los_Angeles',
    NOW,
  ],
  'booking, no history switch': [
    assistant({ behaviours: { caller_history: false } }),
    open,
    booking(),
    [],
    known,
    'America/Los_Angeles',
    NOW,
  ],
  'booking, one type and calendar, no changes': [assistant(), open, oneOfEach, [], number, null, NOW],
  'booking, older api without canChange': [
    assistant(),
    open,
    booking({ canChangeBookings: undefined as unknown as boolean }),
    [],
    null,
    null,
    NOW,
  ],
  transfer: [assistant(), open, null, transfers, number, 'America/Los_Angeles', NOW],
  'transfer and booking and lookup': [
    assistant(),
    open,
    booking(),
    transfers,
    known,
    'America/Los_Angeles',
    NOW,
    details,
    true,
  ],
  'held contacts while closed': [
    assistant({
      transfers: [contact({ hours_only: true }), contact({ id: 'tc_2', condition: 'Billing questions.' })],
    } as unknown as Partial<Assistant>),
    closed,
  ],
  'held contacts in closure': [assistant({ transfers: [contact()] } as unknown as Partial<Assistant>), closure],
  'lookup only': [assistant(), null, null, [], null, null, NOW, null, true],
  'caller details': [assistant(), null, null, [], number, null, NOW, details],
  'test call': [assistant(), null, null, [], testCall],
  'known caller, confirm number': [
    assistant({ behaviours: { confirm_number: true } }),
    open,
    null,
    [],
    known,
    'Europe/Berlin',
    NOW,
  ],
  'all switches off': [
    assistant({
      behaviours: {
        ask_name: false,
        offer_callback: false,
        confirm_number: false,
        caller_history: false,
        ask_booking_name: false,
      },
    }),
    open,
    null,
    [],
    known,
    null,
    NOW,
  ],
  'bad time zone': [assistant(), null, null, [], null, 'Not/AZone', NOW],
  everything: [
    assistant({
      ai_disclosure: 'at_start_consent',
      communication_style: 'empathetic',
      languages: { main: 'en', mode: 'allowed', allowed: ['es'] },
      behaviours: { confirm_number: true, ask_booking_name: true },
    } as Partial<Assistant>),
    open,
    booking(),
    transfers,
    known,
    'America/Los_Angeles',
    NOW,
    details,
    true,
    'es',
  ],
}

test.each(Object.entries(setups))('the prompt for %s stays the same', (_name, setup) => {
  expect(buildInstructions(...setup)).toMatchSnapshot()
})

test("the instance admin's wording replaces only its part; one without the default's variables is not used", () => {
  const setup = setups.everything!
  const before = buildInstructions(...setup)
  const withOverrides: Setup = [...setup]
  withOverrides[10] = {
    'rules.spam': 'Spam: hang up politely.',
    'call.callerIdReadBack': 'Number: {number}.',
    'role.intro': 'You are an assistant.',
  }
  const edited = buildInstructions(...withOverrides)
  // The caller ID part around its {number}, as the default says it.
  const [head, tail] = PROMPT_TEXTS['call.callerIdReadBack'].text.split('{number}') as [string, string]
  const start = before.indexOf(head)
  const end = before.indexOf(tail, start) + tail.length
  const number = before.slice(start + head.length, end - tail.length)
  expect(number).toMatch(/^[+\d() -]+$/)
  expect(edited).toBe(
    `${before.slice(0, start)}Number: ${number}.${before.slice(end)}`.replace(
      PROMPT_TEXTS['rules.spam'].text,
      'Spam: hang up politely.',
    ),
  )
  expect(edited).toContain('You are Maya, the AI assistant')
})
