// Fixtures for the LLM test suite (LIN-391): one assistant and workspace as a call sees them, built from demo data
// (Brightwater Plumbing & Heating, Portland; assistant Maya; owner Mike Brennan; 555 test numbers). A case picks
// knobs (hours, booking, transfers, caller, languages, ...) and gets everything buildInstructions and the tools need.
import type { BookingContext, CallerHistory } from '@linedesk/actions'
import type { Assistant, CallerDetails, TransferContact, WebhookLookup } from '@linedesk/db/types'
import type { BusinessHours } from '../call-session.ts'
import { type CallerContext, forHours } from '../prompt.ts'
import { transferContactsFor } from '../transfer.ts'

export const TIME_ZONE = 'America/Los_Angeles'
/** Tuesday, November 17, 2026, 10:30 AM in Portland (PST, UTC-8). */
export const OPEN_NOW = Date.UTC(2026, 10, 17, 18, 30)
/** The same Tuesday, 8:00 PM in Portland. */
export const CLOSED_NOW = Date.UTC(2026, 10, 18, 4, 0)
/** Tuesday, November 24, 2026, 10:30 AM in Portland, during the Thanksgiving break. */
export const CLOSURE_NOW = Date.UTC(2026, 10, 24, 18, 30)

export const CALLER_NUMBER = '+15035550142'
export const OWNER_NUMBER = '+15035550100'
export const OFFICE_NUMBER = '+15035550123'

const HOURS = 'Opening hours: Monday to Friday 7:00 AM–5:00 PM.'

/** As the API words them (packages/calendar business-hours.ts, apps/api handlers.ts closureNow). */
export const HOURS_OPEN: BusinessHours = { openNow: true, summary: `${HOURS} Open now, until 5:00 PM.` }
export const HOURS_CLOSED: BusinessHours = {
  openNow: false,
  summary: `${HOURS} Closed now; opens tomorrow at 7:00 AM.`,
}
export const HOURS_CLOSURE: BusinessHours = {
  openNow: false,
  summary: 'Closed for a break from Monday, November 23 to Sunday, November 29, back on Monday, November 30.',
  closure: {
    greeting:
      "Thanks for calling Brightwater Plumbing & Heating. We're closed for Thanksgiving week and back on Monday, November 30. How can I help?",
  },
}

/** What the owner wrote in "About the business". */
export const BUSINESS_TEXT = [
  'Brightwater Plumbing & Heating is a family plumbing and heating company in Portland, Oregon. The owner is Mike Brennan.',
  'Services: leak and pipe repair, drain cleaning, water heater repair and installation, furnace and boiler service, emergency plumbing.',
  'Service area: Portland, Beaverton, Gresham, Lake Oswego and Milwaukie.',
  'Address: 2210 SE Division St, Portland, OR 97202.',
  'Prices: a service call (diagnostic visit) is $89. Drain cleaning starts at $149.',
  'A burst pipe, flooding or no heat in winter is urgent.',
  'We do not do roofing or electrical work.',
].join('\n')

export const GREETING = 'Thanks for calling Brightwater Plumbing & Heating, this is Maya. How can I help?'
export const GREETING_OUTSIDE =
  'Thanks for calling Brightwater Plumbing & Heating. We are closed right now, but this is Maya, and I can take a message. How can I help?'

export function baseAssistant(over: Partial<Assistant> = {}): Assistant {
  return {
    id: 'as_llm_test',
    workspace_id: 'ws_llm_test',
    name: 'Maya',
    greeting: GREETING,
    greeting_outside: GREETING_OUTSIDE,
    ai_disclosure: 'when_asked',
    communication_style: 'standard',
    business_profile: { instructions: BUSINESS_TEXT },
    languages: { main: 'en', mode: 'english', allowed: [] },
    behaviours: {},
    transfers: [],
    ...over,
  } as unknown as Assistant
}

export function contact(over: Partial<TransferContact> = {}): TransferContact {
  return {
    id: 'tc_mike',
    name: 'Mike Brennan',
    number: OWNER_NUMBER,
    condition: 'The caller has an emergency like a burst pipe or flooding, or asks for Mike',
    hours_only: false,
    ring_seconds: 20,
    if_no_answer: 'message',
    enabled: true,
    ...over,
  } as TransferContact
}

export const MIKE = contact()
/** Billing questions go to the office, only while it is open. */
export const OFFICE_HOURS_ONLY = contact({
  id: 'tc_office',
  name: 'the office',
  number: OFFICE_NUMBER,
  condition: 'The caller has a question about an invoice or a payment',
  hours_only: true,
})

export function bookingContext(now: number, over: Partial<BookingContext> = {}): BookingContext {
  const today = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now)
  const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now)
  return {
    timeZone: TIME_ZONE,
    today,
    todayDate,
    appointmentTypes: [
      {
        id: 'at_repair',
        name: 'Repair visit',
        duration_min: 60,
        required_fields: ['name', 'address'],
        instruction: 'the caller needs something repaired or checked',
      },
      {
        id: 'at_estimate',
        name: 'Estimate',
        duration_min: 30,
        required_fields: ['name', 'email'],
        instruction: 'the caller wants a quote for a new installation, like a new water heater',
      },
    ],
    calendars: [{ id: 'acal_service', name: 'Service calendar', instruction: '', is_default: true }],
    upcoming: [],
    canChangeBookings: true,
    ...over,
  }
}

export const JOB_STATUS_LOOKUP: WebhookLookup = {
  name: 'job_status',
  when: 'the caller asks about the status of a repair job or when the technician arrives',
  fields: [
    {
      name: 'job_number',
      type: 'text',
      description: 'The job number from the confirmation, like BW-1234.',
      required: true,
    },
  ],
}

export type HoursKind = 'open' | 'closed' | 'closure' | 'none'
export type CallerKind = 'callerId' | 'contact' | 'withheld' | 'testCall'

export type SetupOptions = {
  /** Fields of the assistant row (name, ai_disclosure, communication_style, languages, behaviours, ...). */
  assistant?: Partial<Assistant>
  /** Replaces the owner's "About the business" text ('' for none). */
  businessText?: string
  hours?: HoursKind
  /** The booking setup; true: the default one. */
  booking?: boolean | Partial<BookingContext>
  transfers?: TransferContact[]
  /** Who calls: caller ID only (default), a saved contact, a withheld number or the app's test call. */
  caller?: CallerKind
  callerName?: string
  notes?: string
  history?: CallerHistory
  callerDetails?: CallerDetails
  lookups?: WebhookLookup[]
  teamLanguage?: string
}

/** Everything one simulated call needs: what buildInstructions takes, and what the tools are built from. */
export type Setup = {
  assistant: Assistant
  hours: BusinessHours | null
  booking: BookingContext | null
  /** The contacts transfer_call offers now (transferContactsFor: none outside hours for "hours only" ones). */
  transfers: TransferContact[]
  caller: CallerContext | null
  callerDetails: CallerDetails | null
  lookups: WebhookLookup[]
  timeZone: string
  now: number
  teamLanguage: string
  /** The assistant's first line: its greeting for the hours (forHours). */
  greeting: string
  /** A few lines for the judge and the report: what this call's setup is. */
  description: string[]
}

const HOURS_BY_KIND = { open: HOURS_OPEN, closed: HOURS_CLOSED, closure: HOURS_CLOSURE, none: null } as const
const NOW_BY_KIND = { open: OPEN_NOW, closed: CLOSED_NOW, closure: CLOSURE_NOW, none: OPEN_NOW } as const

function callerOf(o: SetupOptions): CallerContext | null {
  const kind = o.caller ?? 'callerId'
  if (kind === 'withheld') return null
  if (kind === 'testCall') return { name: null, note: null, phone: null, testCall: true } as CallerContext
  return {
    name: kind === 'contact' ? (o.callerName ?? 'Dana Ruiz') : null,
    note: o.notes ?? null,
    phone: CALLER_NUMBER,
    history: o.history ?? null,
  } as CallerContext
}

export function setup(o: SetupOptions = {}): Setup {
  const hoursKind = o.hours ?? 'open'
  const hours = HOURS_BY_KIND[hoursKind]
  const now = NOW_BY_KIND[hoursKind]
  const assistant = baseAssistant({
    ...(o.businessText !== undefined ? { business_profile: { instructions: o.businessText } } : {}),
    transfers: o.transfers ?? [],
    ...o.assistant,
  } as Partial<Assistant>)
  const caller = callerOf(o)
  const booking = o.booking
    ? bookingContext(now, { canChangeBookings: !!caller?.phone, ...(o.booking === true ? {} : o.booking) })
    : null
  const transfers = transferContactsFor(assistant, hours)
  const greeting = forHours(assistant, hours)?.greeting || GREETING
  const languages = assistant.languages as { main?: string; mode?: string; allowed?: string[] }
  const description = [
    `Business: Brightwater Plumbing & Heating, Portland. Assistant: ${assistant.name}. Owner: Mike Brennan.`,
    `Owner's business text: ${o.businessText === '' ? 'none' : 'services, service area, address, prices ($89 service call, drain cleaning from $149), what is urgent'}.`,
    `Opening hours: ${hoursKind === 'none' ? 'none set' : hoursKind === 'open' ? 'open now' : hoursKind === 'closed' ? 'closed now (opens tomorrow 7 AM)' : 'closed for a break until Monday, November 30'}.`,
    `Booking: ${booking ? `on (types: ${booking.appointmentTypes.map(t => `${t.name} asks for ${t.required_fields.join(', ')}`).join('; ')}; changing bookings ${booking.canChangeBookings ? 'allowed' : 'not allowed'})` : 'off (it cannot book; asking which day and time suit and putting that in the message is right)'}.`,
    `Transfer contacts reachable now: ${transfers.length ? transfers.map(t => `${t.name} (${t.condition})`).join('; ') : 'none'}.`,
    `Caller: ${caller?.phone ? `caller ID ${caller.phone}${caller.name ? `, saved contact "${caller.name}"` : ''}` : caller?.testCall ? 'test call from the app, no caller ID' : 'number withheld'}.`,
    `Languages: main ${languages.main ?? 'en'}, mode ${languages.mode ?? 'english'}${languages.allowed?.length ? ` (${languages.allowed.join(', ')})` : ''}. AI disclosure: ${assistant.ai_disclosure}.`,
    ...(o.lookups?.length ? [`Lookups: ${o.lookups.map(l => `lookup_${l.name} (${l.when})`).join('; ')}.`] : []),
    ...(o.notes ? ['The owner has a note about this caller.'] : []),
    ...(o.history ? ["The caller's earlier calls are known."] : []),
  ]
  return {
    assistant,
    hours,
    booking,
    transfers,
    caller,
    callerDetails: o.callerDetails ?? null,
    lookups: o.lookups ?? [],
    timeZone: TIME_ZONE,
    now,
    teamLanguage: o.teamLanguage ?? 'en',
    greeting,
    description,
  }
}
