// A demo support mailbox (LIN-642): Brightwater Plumbing & Heating's support mail, made up, for tests and for running
// the support mail analysis without a real Gmail or Microsoft 365 account (`pnpm --filter @linedesk/api mail:demo`).
// It behaves as the adapters do: newest first, `after` and paging honored, read only.
import type { ListOptions, MailMessage, MailPage, MailProvider } from './provider.ts'

export const DEMO_MAILBOX = 'help@brightwaterplumbing.example'

type DemoThread = {
  topic: string
  /** The customer's question, then support's answer; a third line is the customer's reply, a fourth support's again. */
  messages: string[]
  /** The sender has no reply from support (a newsletter, a receipt): not a support conversation. */
  automated?: boolean
}

const CUSTOMERS = [
  'Jane Porter <jane.porter@example.com>',
  'Tom Alvarez <tom.alvarez@example.net>',
  'Priya Shah <priya.s@example.org>',
  'Dave Kim <davekim@example.com>',
  'Laura Chen <laura.chen@example.net>',
  'Sam Okafor <sam.okafor@example.org>',
]

const THREADS: DemoThread[] = [
  {
    topic: 'Water heater leaking',
    messages: [
      'Hi, my water heater is leaking from the bottom since this morning. Can someone come today? I live at 412 Oak St, call me at (503) 555-0142. Thanks, Jane',
      'Hi Jane, sorry to hear that. Please turn off the cold water valve on top of the heater and the power or gas. We can send a technician between 2 and 5 pm today. The call-out fee is $89, which we credit toward the repair. How old is the heater, and is it gas or electric?',
      'It is gas, about 11 years old.',
      'Thanks. At 11 years a replacement may be cheaper than a repair; the technician will give you both prices on site. See you this afternoon. Mike, Brightwater Plumbing',
    ],
  },
  {
    topic: 'No hot water',
    messages: [
      'We have had no hot water since last night. Tank is 6 years old, electric. Can you help? Tom',
      'Hi Tom, for an electric heater please first check the breaker for the water heater in your panel. If it has not tripped, we can come tomorrow morning between 8 and 11. The call-out fee is $89. What is your address and a phone number for the technician?',
    ],
  },
  {
    topic: 'Quote for tankless water heater',
    messages: [
      'Hello, how much does it cost to switch from a tank to a tankless water heater? House in Beaverton, 3 bathrooms.',
      'Hi Priya, a tankless install usually runs $3,200 to $4,800 depending on gas line size and venting. For 3 bathrooms we recommend a 199,000 BTU unit. We do free estimates on site: would Thursday or Friday work? Please send your address and a good time.',
      'Friday after 3 works.',
      'Booked for Friday 3:30 pm. You will get a text when the estimator is on the way.',
    ],
  },
  {
    topic: 'Tankless water heater price',
    messages: [
      'What do you charge for a tankless water heater including installation? Gas, 2 bathrooms.',
      'Hi Dave, for 2 bathrooms a gas tankless install is typically $3,200 to $4,000 with the unit. The exact price depends on venting and the gas line, so we do a free estimate first. Which day suits you, and what is your address?',
    ],
  },
  {
    topic: 'Do you service Vancouver WA?',
    messages: [
      'Do you come to Vancouver, Washington? Need a faucet replaced.',
      'Hi Laura, yes, we cover Vancouver WA up to the 205, with a $25 travel charge north of Mill Plain. A faucet replacement is $185 plus the faucet, or $145 if you supply it. When would you like us to come?',
    ],
  },
  {
    topic: 'Service area question',
    messages: [
      'Hi, are you able to come out to Hillsboro? Our kitchen sink is clogged.',
      'Hi Sam, Hillsboro is in our service area, no travel charge. A drain clearing is $165 for the first drain. We have openings tomorrow at 9 am or 1 pm. Please send your address and which time you prefer.',
    ],
  },
  {
    topic: 'Coverage in Gresham',
    messages: ['Do you work in Gresham?', 'Yes, Gresham is in our service area. What do you need help with?'],
  },
  {
    topic: 'Burst pipe!!',
    messages: [
      'URGENT a pipe burst under the kitchen sink, water everywhere',
      'Please shut off the main water valve right away (usually where the water line enters the house, or at the meter). Call our 24/7 line at (503) 555-0100 now; emergency calls after hours are $149 call-out. A technician can be there within 90 minutes.',
    ],
  },
  {
    topic: 'Emergency - toilet overflowing',
    messages: [
      'Toilet overflowing and won’t stop, it is Sunday night. Can anyone come?',
      'Turn the valve behind the toilet clockwise to stop the water. For tonight please call our 24/7 line at (503) 555-0100: weekend emergency call-out is $149. If it can wait, Monday morning is the regular $89.',
    ],
  },
  {
    topic: 'Reschedule appointment',
    messages: [
      'I need to move my appointment on Wednesday to next week. It is for 412 Oak St.',
      'Hi Jane, no problem. We have Tuesday 10 am or Thursday 2 pm next week. Which works? There is no fee for rescheduling more than 24 hours ahead.',
      'Thursday 2 pm please.',
      'Done: Thursday 2 pm. You will get a reminder the day before.',
    ],
  },
  {
    topic: 'Cancel my visit',
    messages: [
      'Please cancel tomorrow’s appointment, we fixed it ourselves.',
      'Hi Tom, cancelled. Since it is more than 24 hours ahead there is no charge. Glad it is fixed!',
    ],
  },
  {
    topic: 'Change appointment time',
    messages: [
      'Can the technician come in the afternoon instead of the morning on Friday?',
      'Hi Priya, we moved you to Friday 1 to 4 pm. Same technician. Let us know if anything changes.',
    ],
  },
  {
    topic: 'Invoice question',
    messages: [
      'My invoice says $340 but I was quoted $280. Why the difference? Invoice 10482.',
      'Hi Dave, the extra $60 is the shut-off valve the technician replaced; he should have asked you first, so we have taken $30 off. Your new total is $310. You can pay by card on the link in the invoice, or by check.',
    ],
  },
  {
    topic: 'Payment options',
    messages: [
      'Can I pay my bill in installments? The repipe was more than expected.',
      'Hi Laura, yes: for jobs over $1,500 we offer 6 or 12 months at 0% through our financing partner. Reply with your invoice number and we will send the application link.',
    ],
  },
  {
    topic: 'Do you install water softeners?',
    messages: [
      'Do you install water softeners? And what brands?',
      'Hi Sam, we do not install water softeners. We recommend Rose City Water Treatment for that. We can do the plumbing connection if their installer needs it.',
    ],
  },
  {
    topic: 'Septic tank',
    messages: [
      'Can you pump our septic tank?',
      'Sorry, we do not do septic pumping. Johnson Septic in Portland handles that.',
    ],
  },
  {
    topic: 'Opening hours',
    messages: [
      'What are your hours on Saturday?',
      'We are open Saturday 8 am to 2 pm for regular appointments; outside that our 24/7 line handles emergencies at (503) 555-0100.',
    ],
  },
  {
    topic: 'Hours',
    messages: [
      'Are you open on weekends?',
      'Saturdays 8 to 2, closed Sundays except emergencies (24/7 line, $149 call-out).',
    ],
  },
  { topic: 'Your November newsletter', messages: ['10 tips to winterize your pipes'], automated: true },
  { topic: 'Receipt for your payment', messages: ['Thanks for your payment of $89.00'], automated: true },
]

const DAY = 86_400_000

function demoMessages(now: number): MailMessage[] {
  const out: MailMessage[] = []
  THREADS.forEach((thread, t) => {
    const customer = CUSTOMERS[t % CUSTOMERS.length]!
    const sender = thread.automated ? 'Supply House <no-reply@supplyhouse.example>' : customer
    // Spread over the last ten months, newest first in THREADS order; the messages of a thread an hour apart.
    const start = now - (t + 1) * 15 * DAY
    thread.messages.forEach((text, i) => {
      const fromMailbox = !thread.automated && i % 2 === 1
      out.push({
        id: `demo-${t}-${i}`,
        threadId: `demo-thread-${t}`,
        // i18n-ignore: a made-up mail header for tests and the demo, not shown in the app
        from: fromMailbox ? `Brightwater Plumbing <${DEMO_MAILBOX}>` : sender,
        to: [fromMailbox ? sender : DEMO_MAILBOX],
        subject: i === 0 ? thread.topic : `Re: ${thread.topic}`,
        sentAt: new Date(start + i * 3_600_000).toISOString(),
        fromMailbox,
        text,
      })
    })
  })
  return out.sort((a, b) => b.sentAt.localeCompare(a.sentAt))
}

/** The demo mailbox as a MailProvider: twenty threads over the last ten months, two of them automated mail. */
export function createDemoMail(now = Date.now()): MailProvider {
  const all = demoMessages(now)
  const byId = new Map(all.map(m => [m.id, m]))
  return {
    name: 'google',
    async listMessages(options: ListOptions = {}): Promise<MailPage> {
      const max = options.max ?? 100
      const after = options.after ? Date.parse(options.after) : Number.NEGATIVE_INFINITY
      const matching = all.filter(m => Date.parse(m.sentAt) > after)
      const offset = options.pageToken ? Number(options.pageToken) : 0
      const page = matching.slice(offset, offset + max)
      const next = offset + max < matching.length ? String(offset + max) : null
      return { messages: page.map(m => ({ id: m.id, threadId: m.threadId })), nextPageToken: next }
    },
    async getMessage(id: string) {
      return byId.get(id) ?? null
    },
  }
}
