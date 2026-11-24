// The sample calls a new workspace can try ("Try with sample calls"). Unlike the demo morning
// (demo-calls.ts, a plumber's), they fit any trade: no pipes, no owner's name, nothing a
// salon, an electrician or a dental office would not hear. Their words are keys in the server
// catalog (`server.sample.*`), so sample.add files them in the language of the person who adds them,
// with the workspace's own business and assistant names in the greeting.
import type { MessageKey } from '@linedesk/i18n'
import type { SeedCall } from './demo-calls.ts'

// i18n-dynamic: server.sample.*
type Speaker = SeedCall['lines'][number][0]

/** One sample call: the facts here, every word a catalog key. */
export type SampleCall = Omit<SeedCall, 'name' | 'title' | 'summary' | 'next' | 'fields' | 'lines'> & {
  /** The caller's name; null for a caller who never said it. Calls from the same phone share it. */
  name: MessageKey | null
  title: MessageKey
  summary: MessageKey
  next?: MessageKey
  /** A field the assistant took down: its label, and its value (written in the same language, such as an email address that fits the name). */
  fields?: { label: MessageKey; value: MessageKey }[]
  /** `greeting` is the assistant's greeting with the workspace's business and assistant names. */
  lines: ([speaker: Speaker, text: MessageKey] | 'greeting')[]
}

const URGENT: MessageKey = 'server.sample.event.urgent'
const MESSAGE: MessageKey = 'server.sample.event.message'

export const sampleMorning: SampleCall[] = [
  {
    name: 'server.sample.urgent.caller',
    phone: '+15035550117',
    minutesAgo: 22,
    durationSec: 128,
    outcome: 'callback',
    urgency: 'urgent',
    title: 'server.sample.urgent.title',
    summary: 'server.sample.urgent.summary',
    next: 'server.sample.urgent.next',
    lines: [
      'greeting',
      ['caller', 'server.sample.urgent.line1'],
      ['agent', 'server.sample.urgent.line2'],
      ['system', URGENT],
      ['agent', 'server.sample.urgent.line3'],
      ['caller', 'server.sample.urgent.line4'],
      ['system', MESSAGE],
      ['agent', 'server.sample.urgent.line5'],
    ],
  },
  {
    name: 'server.sample.appointment.caller',
    phone: '+15035550163',
    minutesAgo: 95,
    durationSec: 96,
    outcome: 'message',
    title: 'server.sample.appointment.title',
    summary: 'server.sample.appointment.summary',
    next: 'server.sample.appointment.next',
    lines: [
      'greeting',
      ['caller', 'server.sample.appointment.line1'],
      ['agent', 'server.sample.appointment.line2'],
      ['caller', 'server.sample.appointment.line3'],
      ['system', MESSAGE],
      ['agent', 'server.sample.appointment.line4'],
    ],
  },
  {
    name: 'server.sample.quote.caller',
    phone: '+15035550188',
    minutesAgo: 140,
    durationSec: 88,
    outcome: 'message',
    title: 'server.sample.quote.title',
    summary: 'server.sample.quote.summary',
    next: 'server.sample.quote.next',
    fields: [{ label: 'server.sample.quote.emailLabel', value: 'server.sample.quote.email' }],
    lines: [
      'greeting',
      ['caller', 'server.sample.quote.line1'],
      ['agent', 'server.sample.quote.line2'],
      ['caller', 'server.sample.quote.line3'],
      ['system', MESSAGE],
      ['agent', 'server.sample.quote.line4'],
    ],
  },
  {
    name: 'server.sample.dropped.caller',
    phone: '+15035550134',
    minutesAgo: 190,
    durationSec: 41,
    outcome: 'callback',
    title: 'server.sample.dropped.title',
    summary: 'server.sample.dropped.summary',
    next: 'server.sample.dropped.next',
    lines: [
      'greeting',
      ['caller', 'server.sample.dropped.line1'],
      ['agent', 'server.sample.dropped.line2'],
      ['caller', 'server.sample.dropped.line3'],
      ['system', MESSAGE],
      ['agent', 'server.sample.dropped.line4'],
    ],
  },
  {
    name: 'server.sample.dropped.caller',
    phone: '+15035550134',
    minutesAgo: 186,
    durationSec: 18,
    outcome: 'hangup',
    title: 'server.sample.hungUp.title',
    summary: 'server.sample.hungUp.summary',
    unread: false,
    lines: ['greeting'],
  },
  {
    name: 'server.sample.price.caller',
    phone: '+15035550152',
    minutesAgo: 60 * 24 + 30,
    durationSec: 73,
    outcome: 'callback',
    title: 'server.sample.price.title',
    summary: 'server.sample.price.summary',
    next: 'server.sample.price.next',
    unread: false,
    lines: [
      'greeting',
      ['caller', 'server.sample.price.line1'],
      ['agent', 'server.sample.price.line2'],
      ['caller', 'server.sample.price.line3'],
      ['system', MESSAGE],
      ['agent', 'server.sample.price.line4'],
    ],
  },
  {
    name: 'server.sample.hours.caller',
    phone: '+15035550171',
    minutesAgo: 60 * 24 + 200,
    durationSec: 35,
    outcome: 'answered',
    title: 'server.sample.hours.title',
    summary: 'server.sample.hours.summary',
    unread: false,
    lines: [
      'greeting',
      ['caller', 'server.sample.hours.line1'],
      ['agent', 'server.sample.hours.line2'],
      ['caller', 'server.sample.hours.line3'],
    ],
  },
  {
    name: null,
    phone: '+15035550199',
    minutesAgo: 60 * 24 * 2,
    durationSec: 22,
    outcome: 'spam',
    title: 'server.sample.spam.title',
    summary: 'server.sample.spam.summary',
    unread: false,
    lines: ['greeting', ['caller', 'server.sample.spam.line1']],
  },
]
