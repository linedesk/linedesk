// Demo workspace: Brightwater Plumbing & Heating (Portland), assistant Maya, owner Mike Brennan.
// Idempotent: the base data is created once; the calendar setup is added to an existing demo too.
import {
  appointment_types, assistants, availability_exceptions, availability_rules, calls, contacts, organization, phone_numbers,
  transcript_segments, user, workspace_settings,
} from '@callfront/db'
import { eq } from 'drizzle-orm'
import { auth } from './auth.ts'
import { db, pool } from './db.ts'

export const DEMO = { email: 'mike@brightwater.example', password: 'brightwater-demo', number: '+15035550142' }

type SeedCall = {
  name: string | null; phone: string; minutesAgo: number; durationSec: number
  outcome: (typeof calls.$inferInsert)['outcome']; urgency?: 'urgent' | 'normal' | 'low'
  title: string; summary: string; next?: string; unread?: boolean
  lines: [speaker: 'agent' | 'caller' | 'system', text: string][]
}

const seedCalls: SeedCall[] = [
  { name: 'Sarah Whitfield', phone: '+15035550117', minutesAgo: 22, durationSec: 141, outcome: 'callback', urgency: 'urgent',
    title: 'Burst pipe under the kitchen sink', summary: 'Water is spraying under the sink; she shut off the main valve. Wants someone today.',
    next: 'Call back within 15 minutes', lines: [
      ['agent', 'Thanks for calling Brightwater Plumbing & Heating. This is Maya, the AI assistant. How can I help?'],
      ['caller', 'Hi, a pipe under my kitchen sink just burst, there is water everywhere.'],
      ['agent', 'I am sorry, that sounds stressful. Have you been able to shut off the main water valve?'],
      ['caller', 'Yes, just now.'],
      ['system', 'Flagged as urgent'],
      ['agent', 'Good. I have marked this as urgent and Mike will call you back within fifteen minutes. Is this the best number?'],
      ['caller', 'Yes, this one. Thank you.'],
    ] },
  { name: 'Daniel Okafor', phone: '+15035550163', minutesAgo: 95, durationSec: 204, outcome: 'booked',
    title: 'Water heater maintenance', summary: 'Annual flush for a 50-gallon gas water heater. Booked Thursday 9:00 am.',
    lines: [
      ['agent', 'Thanks for calling Brightwater Plumbing & Heating. This is Maya, the AI assistant. How can I help?'],
      ['caller', 'I would like to get my water heater serviced.'],
      ['system', 'Checked availability · 3 slots'],
      ['agent', 'I have Thursday at 9 am, Thursday at 1 pm or Friday at 10 am. Which works best?'],
      ['caller', 'Thursday at nine.'],
      ['system', 'Booked · Thu 9:00 am'],
      ['agent', 'You are booked for Thursday at 9 am. You will get a text confirmation shortly.'],
    ] },
  { name: 'Priya Raman', phone: '+15035550188', minutesAgo: 180, durationSec: 96, outcome: 'message',
    title: 'Quote for bathroom remodel', summary: 'Wants a rough quote for moving a toilet and adding a second sink. Prefers email.',
    next: 'Send quote by email', lines: [
      ['agent', 'Thanks for calling Brightwater Plumbing & Heating. This is Maya, the AI assistant. How can I help?'],
      ['caller', 'I am remodeling my bathroom and need a quote for moving the toilet and adding a sink.'],
      ['agent', 'Happy to pass that on. Mike prepares quotes himself. What is the best way to reach you?'],
      ['caller', 'Email is best.'],
      ['system', 'Took a message'],
    ] },
  { name: null, phone: '+15035550104', minutesAgo: 260, durationSec: 9, outcome: 'hangup', urgency: 'low',
    title: 'Hung up before speaking', summary: 'The caller hung up after the greeting.', lines: [
      ['agent', 'Thanks for calling Brightwater Plumbing & Heating. This is Maya, the AI assistant. How can I help?'],
    ] },
  { name: 'Tom Alvarez', phone: '+15035550139', minutesAgo: 60 * 26, durationSec: 118, outcome: 'answered', unread: false,
    title: 'Service area question', summary: 'Asked whether Brightwater serves Lake Oswego. It does; he will call back to book.',
    lines: [
      ['caller', 'Do you guys come out to Lake Oswego?'],
      ['agent', 'Yes, Lake Oswego is in our service area. Would you like to book a visit?'],
      ['caller', 'Not yet, I will call back.'],
    ] },
  { name: 'Grace Lindqvist', phone: '+15035550171', minutesAgo: 60 * 28, durationSec: 187, outcome: 'booked', unread: false,
    title: 'Dripping shower faucet', summary: 'Shower faucet has been dripping for a week. Booked Monday 2:00 pm.',
    lines: [
      ['caller', 'My shower faucet keeps dripping.'],
      ['system', 'Checked availability · 4 slots'],
      ['agent', 'I can offer Monday at 2 pm. Does that work?'],
      ['caller', 'Perfect.'],
      ['system', 'Booked · Mon 2:00 pm'],
    ] },
  { name: null, phone: '+18885550199', minutesAgo: 60 * 30, durationSec: 31, outcome: 'spam', urgency: 'low', unread: false,
    title: 'Sales call: business listing', summary: 'Automated pitch about a business listing upgrade.',
    lines: [['caller', 'This is an important message about your business listing.']] },
  { name: 'Marcus Bell', phone: '+15035550126', minutesAgo: 60 * 50, durationSec: 152, outcome: 'callback', unread: false,
    title: 'No hot water since this morning', summary: 'Tankless heater shows error code 11. Wants a call back about same-week service.',
    next: 'Call back about error code 11', lines: [
      ['caller', 'We have had no hot water since this morning, the heater shows error 11.'],
      ['agent', 'Thanks, I have noted the error code. Mike will call you back today to find a time this week.'],
      ['system', 'Took a message'],
    ] },
]

const id = (prefix: string, n: number) => `${prefix}_demo_${String(n).padStart(2, '0')}`

const DEMO_SLUG = 'brightwater'

// Mon–Fri 7 am – 6 pm Pacific, closed on two holidays, three things callers can book.
async function seedCalendar(workspace_id: string) {
  await db.insert(workspace_settings).values({ workspace_id, timezone: 'America/Los_Angeles' }).onConflictDoNothing()
  await db.insert(availability_rules).values([1, 2, 3, 4, 5].map(weekday => (
    { id: id('ar', weekday), workspace_id, weekday, start_time: '07:00', end_time: '18:00' }
  ))).onConflictDoNothing()
  await db.insert(availability_exceptions).values([
    { id: id('ae', 0), workspace_id, date: '2026-11-26' }, // Thanksgiving
    { id: id('ae', 1), workspace_id, date: '2026-12-25' },
  ]).onConflictDoNothing()
  await db.insert(appointment_types).values([
    { id: 'at_demo_service', workspace_id, name: 'Service visit', duration_min: 90, buffer_min: 30, min_notice_hours: 2, max_days_ahead: 30, location: 'on_site' },
    { id: 'at_demo_estimate', workspace_id, name: 'On-site estimate', duration_min: 60, buffer_min: 30, min_notice_hours: 24, max_days_ahead: 30, location: 'on_site' },
    { id: 'at_demo_phone', workspace_id, name: 'Phone consultation', duration_min: 15, buffer_min: 0, min_notice_hours: 1, max_days_ahead: 14, location: 'phone' },
  ]).onConflictDoNothing()
}

async function seed() {
  const [existing] = await db.select().from(user).where(eq(user.email, DEMO.email))
  if (existing) {
    const [workspace] = await db.select().from(organization).where(eq(organization.slug, DEMO_SLUG))
    if (!workspace) throw new Error(`demo user exists but workspace "${DEMO_SLUG}" does not`)
    await seedCalendar(workspace.id)
    return console.log('demo data already there (calendar setup checked)')
  }

  const signUp = await auth.api.signUpEmail({ body: { name: 'Mike Brennan', email: DEMO.email, password: DEMO.password }, returnHeaders: true })
  const cookie = signUp.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  const org = await auth.api.createOrganization({ body: { name: 'Brightwater Plumbing & Heating', slug: DEMO_SLUG }, headers: new Headers({ cookie }) })
  const workspace_id = org!.id

  await db.insert(assistants).values({
    id: 'as_demo', workspace_id, name: 'Maya',
    greeting: 'Thanks for calling Brightwater Plumbing & Heating. This is Maya, the AI assistant. How can I help?',
    business_profile: {
      description: 'Family-run plumbing and heating company in Portland, Oregon.',
      services: ['Leak repair', 'Water heaters', 'Drain cleaning', 'Bathroom remodels', 'Furnace service'],
      service_area: 'Portland metro: Portland, Beaverton, Lake Oswego, Tigard, Milwaukie',
      hours: 'Mon–Fri 7 am – 6 pm, emergencies 24/7',
    },
  })
  await db.insert(phone_numbers).values({ id: 'pn_demo', workspace_id, e164: DEMO.number, provider: 'dev', mode: 'forward_conditional', verified_at: new Date().toISOString() })

  for (const [i, c] of seedCalls.entries()) {
    const started = new Date(Date.now() - c.minutesAgo * 60_000)
    await db.insert(contacts).values({ id: id('ct', i), workspace_id, name: c.name, phone: c.phone })
    await db.insert(calls).values({
      id: id('call', i), workspace_id, contact_id: id('ct', i), from_number: c.phone, to_number: DEMO.number,
      started_at: started.toISOString(), ended_at: new Date(started.getTime() + c.durationSec * 1000).toISOString(),
      duration_sec: c.durationSec, status: 'completed', outcome: c.outcome, urgency: c.urgency ?? 'normal',
      title: c.title, summary: c.summary, action_items: c.next ? [{ text: c.next }] : [], unread: c.unread ?? true,
    })
    const step = Math.floor((c.durationSec * 1000) / (c.lines.length + 1))
    await db.insert(transcript_segments).values(c.lines.map(([speaker, text], n) => ({
      id: `${id('seg', i)}_${n}`, workspace_id, call_id: id('call', i), speaker, text, at_ms: n * step,
      tool_event: speaker === 'system' ? { tool: 'system', label: text } : null,
    })))
  }
  await seedCalendar(workspace_id)
  console.log(`seeded ${seedCalls.length} calls. Sign in: ${DEMO.email} / ${DEMO.password}`)
}

await seed()
await pool.end()
