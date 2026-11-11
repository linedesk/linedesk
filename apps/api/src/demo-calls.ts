// The demo calls: a believable morning at Brightwater Plumbing & Heating. The seed files them in the
// demo workspace; sample.add files them, renamed to the workspace's business and assistant, as samples.
import type { calls } from '@linedesk/db'

export const DEMO_BUSINESS = 'Brightwater Plumbing & Heating'
export const DEMO_ASSISTANT = 'Maya'

export type SeedCall = {
  name: string | null
  phone: string
  minutesAgo: number
  durationSec: number
  outcome: (typeof calls.$inferInsert)['outcome']
  urgency?: 'urgent' | 'normal' | 'low'
  title: string
  summary: string
  next?: string
  unread?: boolean
  fields?: { label: string; value: string }[]
  lines: [speaker: 'agent' | 'caller' | 'human' | 'system', text: string][]
}

export const GREETING = `Thanks for calling ${DEMO_BUSINESS}. This is ${DEMO_ASSISTANT}, the AI assistant. How can I help?`
const greet: SeedCall['lines'][number] = ['agent', GREETING]

// v1: the assistant takes a message and flags urgent calls; it never books, quotes or transfers.
// A believable morning: urgent, callbacks, messages, a price question, a repeat caller, spam, a wrong number.
export const seedCalls: SeedCall[] = [
  {
    name: 'Sarah Whitfield',
    phone: '+15035550117',
    minutesAgo: 22,
    durationSec: 141,
    outcome: 'callback',
    urgency: 'urgent',
    title: 'Burst pipe under the kitchen sink',
    summary: 'Water is spraying under the sink; she shut off the main valve. Wants someone today.',
    next: 'Call Sarah back right away',
    fields: [{ label: 'Address', value: '3127 SE Division St, Portland' }],
    lines: [
      greet,
      ['caller', 'Hi, a pipe under my kitchen sink just burst, there is water everywhere.'],
      ['agent', 'I am sorry, that sounds stressful. Have you been able to shut off the main water valve?'],
      ['caller', 'Yes, just now.'],
      ['system', 'Flagged as urgent'],
      [
        'agent',
        'Good. I have flagged this as urgent for Mike. What is the address, and is this the best number to reach you?',
      ],
      ['caller', '3127 Southeast Division Street, and yes, this number.'],
      ['system', 'Took a message'],
      ['agent', 'Thank you, Sarah. Mike has your message and will call you back on this number.'],
    ],
  },
  {
    name: 'Daniel Okafor',
    phone: '+15035550163',
    minutesAgo: 95,
    durationSec: 104,
    outcome: 'message',
    title: 'Water heater maintenance',
    summary: 'Annual flush for a 50-gallon gas water heater. Mornings suit him best, ideally Thursday.',
    next: 'Call Daniel to set a time',
    lines: [
      greet,
      ['caller', 'I would like to get my water heater serviced, just the yearly flush.'],
      ['agent', 'Happy to pass that on. Which days and times suit you best?'],
      ['caller', 'Mornings, Thursday would be ideal.'],
      ['system', 'Took a message'],
      ['agent', 'Got it. I have noted Thursday morning, and Mike will call you back to set a time.'],
    ],
  },
  {
    name: 'Priya Raman',
    phone: '+15035550188',
    minutesAgo: 180,
    durationSec: 96,
    outcome: 'message',
    title: 'Quote for bathroom remodel',
    summary: 'Wants a rough quote for moving a toilet and adding a second sink. Prefers email.',
    next: 'Send Priya a quote by email',
    fields: [{ label: 'Email', value: 'priya.raman@example.com' }],
    lines: [
      greet,
      ['caller', 'I am remodeling my bathroom and need a quote for moving the toilet and adding a sink.'],
      ['agent', 'Happy to pass that on. Mike prepares quotes himself. What is the best way to reach you?'],
      ['caller', 'Email is best, priya.raman@example.com.'],
      ['system', 'Took a message'],
      ['agent', 'Thank you, Priya. Mike will email you about the quote.'],
    ],
  },
  // A repeat caller: two dropped calls, then a message. The inbox folds them into one row.
  {
    name: 'Linda Park',
    phone: '+15035550122',
    minutesAgo: 248,
    durationSec: 6,
    outcome: 'hangup',
    urgency: 'low',
    title: 'Hung up before speaking',
    summary: 'The caller hung up after the greeting.',
    lines: [greet],
  },
  {
    name: 'Linda Park',
    phone: '+15035550122',
    minutesAgo: 246,
    durationSec: 11,
    outcome: 'hangup',
    urgency: 'low',
    title: 'Hung up before speaking',
    summary: 'The caller hung up after the greeting.',
    lines: [greet],
  },
  {
    name: 'Linda Park',
    phone: '+15035550122',
    minutesAgo: 243,
    durationSec: 88,
    outcome: 'callback',
    title: 'Garbage disposal jammed',
    summary: 'Her phone kept dropping. The kitchen disposal hums but does not turn; she tried the reset button.',
    next: 'Call Linda back about the disposal',
    lines: [
      greet,
      ['caller', 'Sorry, my phone keeps cutting out. My garbage disposal just hums and will not turn.'],
      ['agent', 'No problem. Have you tried the reset button on the bottom of the unit?'],
      ['caller', 'Yes, twice. Nothing.'],
      ['system', 'Took a message'],
      ['agent', 'Thanks, Linda. I have noted it, and Mike will call you back on this number.'],
    ],
  },
  {
    name: 'Tom Alvarez',
    phone: '+15035550139',
    minutesAgo: 60 * 26,
    durationSec: 72,
    outcome: 'message',
    unread: false,
    title: 'Price for clearing a kitchen drain',
    summary: 'Asked what clearing a slow kitchen drain costs in Lake Oswego. Wants a price before deciding.',
    next: 'Call Tom back with a price',
    lines: [
      greet,
      ['caller', 'How much do you charge to clear a kitchen drain? I am in Lake Oswego.'],
      [
        'agent',
        'Lake Oswego is in our service area. I cannot quote prices, but Mike can give you one. Shall I take a message?',
      ],
      ['caller', 'Sure, have him call me.'],
      ['system', 'Took a message'],
      ['agent', 'Done. Mike will call you back with a price.'],
    ],
  },
  {
    name: 'Grace Lindqvist',
    phone: '+15035550171',
    minutesAgo: 60 * 28,
    durationSec: 87,
    outcome: 'answered',
    unread: false,
    title: 'Dripping shower faucet',
    summary: 'Shower faucet has been dripping for a week. Not urgent; she will call again if it gets worse.',
    lines: [
      greet,
      ['caller', 'My shower faucet has been dripping for a week. Is that something to worry about?'],
      ['agent', 'It is not urgent. Would you like me to take a message so Mike can call you about a visit?'],
      ['caller', 'Not yet, I will call back if it gets worse.'],
    ],
  },
  {
    name: null,
    phone: '+15035550153',
    minutesAgo: 60 * 29,
    durationSec: 24,
    outcome: 'answered',
    urgency: 'low',
    unread: false,
    title: 'Wrong number',
    summary: 'Was trying to reach a dental office. Maya told her she had reached Brightwater.',
    lines: [
      greet,
      ['caller', 'Oh, is this not Rose City Dental?'],
      ['agent', 'No, this is Brightwater Plumbing & Heating. I think you have the wrong number.'],
      ['caller', 'Sorry about that, bye.'],
    ],
  },
  {
    name: null,
    phone: '+18885550199',
    minutesAgo: 60 * 30,
    durationSec: 31,
    outcome: 'spam',
    urgency: 'low',
    unread: false,
    title: 'Sales call: business listing',
    summary: 'Automated pitch about a business listing upgrade.',
    lines: [greet, ['caller', 'This is an important message about your business listing.']],
  },
  {
    name: 'Marcus Bell',
    phone: '+15035550126',
    minutesAgo: 60 * 50,
    durationSec: 112,
    outcome: 'callback',
    unread: false,
    title: 'No hot water since this morning',
    summary: 'Tankless heater shows error code 11. Wants a call back about service this week.',
    next: 'Call Marcus back about error code 11',
    lines: [
      greet,
      ['caller', 'We have had no hot water since this morning, the heater shows error 11.'],
      ['system', 'Took a message'],
      ['agent', 'Thanks, I have noted the error code. Mike will call you back to talk about service this week.'],
    ],
  },
]
