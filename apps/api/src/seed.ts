// Demo workspace: Brightwater Plumbing & Heating (Portland), assistant Maya, owner Mike Brennan.
// Idempotent: the base data is created once; business hours and the demo recording are added to an existing demo too.
// `pnpm db:seed -- --reset` replaces an existing demo's calls and contacts with these (drops old test calls).
import {
  appointment_types,
  assistants,
  availability_exceptions,
  availability_rules,
  bookings,
  calls,
  contacts,
  organization,
  phone_numbers,
  transcript_segments,
  user,
  workspace_settings,
} from '@callfront/db'
import { recordingKey } from '@callfront/actions'
import { asc, eq } from 'drizzle-orm'
import { auth } from './auth.ts'
import { db, pool } from './db.ts'
import { demoRecordingWav, writeDemoRecording } from './demo-recording.ts'
import { recordingsDirFromEnv } from './recording-store.ts'

export const DEMO = { email: 'mike@brightwater.example', password: 'brightwater-demo', number: '+15035550142' }

type SeedCall = {
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
  lines: [speaker: 'agent' | 'caller' | 'system', text: string][]
}

const GREETING = 'Thanks for calling Brightwater Plumbing & Heating. This is Maya, the AI assistant. How can I help?'
const greet: SeedCall['lines'][number] = ['agent', GREETING]

// v1: the assistant takes a message and flags urgent calls; it never books, quotes or transfers.
// A believable morning: urgent, callbacks, messages, a price question, a repeat caller, spam, a wrong number.
const seedCalls: SeedCall[] = [
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

const id = (prefix: string, n: number) => `${prefix}_demo_${String(n).padStart(2, '0')}`

const DEMO_SLUG = 'brightwater'

// Business hours Mon–Fri 7 am – 6 pm Pacific, closed on two holidays. No booking types: v1 does not book.
async function seedBusinessHours(workspace_id: string) {
  await db.insert(workspace_settings).values({ workspace_id, timezone: 'America/Los_Angeles' }).onConflictDoNothing()
  await db
    .insert(availability_rules)
    .values(
      [1, 2, 3, 4, 5].map(weekday => ({
        id: id('ar', weekday),
        workspace_id,
        weekday,
        start_time: '07:00',
        end_time: '18:00',
      })),
    )
    .onConflictDoNothing()
  await db
    .insert(availability_exceptions)
    .values([
      { id: id('ae', 0), workspace_id, date: '2026-11-26' }, // Thanksgiving
      { id: id('ae', 1), workspace_id, date: '2026-12-25' },
    ])
    .onConflictDoNothing()
}

/** The quote call gets a stand-in recording, so the player can be tried (file store only; S3 is left alone). */
async function seedDemoRecording(workspace_id: string) {
  const dir = recordingsDirFromEnv(process.env)
  const callId = id('call', 2)
  const [call] = await db.select().from(calls).where(eq(calls.id, callId))
  if (!dir || !call?.duration_sec) return
  const key = recordingKey(workspace_id, callId, 'wav')
  const turns = await db
    .select({ at_ms: transcript_segments.at_ms, speaker: transcript_segments.speaker })
    .from(transcript_segments)
    .where(eq(transcript_segments.call_id, callId))
    .orderBy(asc(transcript_segments.at_ms))
  const wav = demoRecordingWav(
    call.duration_sec,
    turns.map(t => ({ atSec: t.at_ms / 1000, speaker: t.speaker })),
  )
  await writeDemoRecording(dir, key, wav)
  await db.update(calls).set({ recording_key: key }).where(eq(calls.id, callId))
}

async function seedCallsAndContacts(workspace_id: string) {
  const contactIds = new Map<string, string>()
  for (const [i, c] of seedCalls.entries()) {
    let contact_id = contactIds.get(c.phone)
    if (!contact_id) {
      contact_id = id('ct', i)
      contactIds.set(c.phone, contact_id)
      await db.insert(contacts).values({ id: contact_id, workspace_id, name: c.name, phone: c.phone })
    }
    const started = new Date(Date.now() - c.minutesAgo * 60_000)
    await db.insert(calls).values({
      id: id('call', i),
      workspace_id,
      contact_id,
      from_number: c.phone,
      to_number: DEMO.number,
      started_at: started.toISOString(),
      ended_at: new Date(started.getTime() + c.durationSec * 1000).toISOString(),
      duration_sec: c.durationSec,
      status: 'completed',
      outcome: c.outcome,
      urgency: c.urgency ?? 'normal',
      title: c.title,
      summary: c.summary,
      action_items: c.next ? [{ text: c.next }] : [],
      fields: c.fields ?? [],
      unread: c.unread ?? true,
    })
    // Turns spread over the call, the first one at 0:00.
    const step = Math.floor((c.durationSec * 1000) / (c.lines.length + 1))
    await db.insert(transcript_segments).values(
      c.lines.map(([speaker, text], n) => ({
        id: `${id('seg', i)}_${n}`,
        workspace_id,
        call_id: id('call', i),
        speaker,
        text,
        at_ms: n * step,
        tool_event: speaker === 'system' ? { tool: 'system', label: text } : null,
      })),
    )
  }
}

/** `--reset`: replace the demo workspace's calls, contacts and booking setup with the seed's (a clean demo). */
async function resetDemo(workspace_id: string) {
  await db.transaction(async tx => {
    await tx.delete(transcript_segments).where(eq(transcript_segments.workspace_id, workspace_id))
    await tx.delete(bookings).where(eq(bookings.workspace_id, workspace_id))
    await tx.delete(calls).where(eq(calls.workspace_id, workspace_id))
    await tx.delete(contacts).where(eq(contacts.workspace_id, workspace_id))
    await tx.delete(appointment_types).where(eq(appointment_types.workspace_id, workspace_id))
  })
  await seedCallsAndContacts(workspace_id)
}

async function seed() {
  const [existing] = await db.select().from(user).where(eq(user.email, DEMO.email))
  if (existing) {
    const [workspace] = await db.select().from(organization).where(eq(organization.slug, DEMO_SLUG))
    if (!workspace) throw new Error(`demo user exists but workspace "${DEMO_SLUG}" does not`)
    if (process.argv.includes('--reset')) {
      await resetDemo(workspace.id)
      console.log(`demo calls and contacts replaced (${seedCalls.length} calls)`)
    } else console.log('demo data already there; run with --reset to replace its calls and contacts')
    await seedBusinessHours(workspace.id)
    await seedDemoRecording(workspace.id)
    return
  }

  const signUp = await auth.api.signUpEmail({
    body: { name: 'Mike Brennan', email: DEMO.email, password: DEMO.password },
    returnHeaders: true,
  })
  // Verified, so an email sign-in link or SSO joins this account instead of resetting its password.
  await db.update(user).set({ emailVerified: true }).where(eq(user.email, DEMO.email))
  const cookie = signUp.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  const org = await auth.api.createOrganization({
    body: { name: 'Brightwater Plumbing & Heating', slug: DEMO_SLUG },
    headers: new Headers({ cookie }),
  })
  const workspace_id = org!.id

  await db.insert(assistants).values({
    id: 'as_demo',
    workspace_id,
    name: 'Maya',
    greeting: GREETING,
    business_profile: {
      description: 'Family-run plumbing and heating company in Portland, Oregon.',
      services: ['Leak repair', 'Water heaters', 'Drain cleaning', 'Bathroom remodels', 'Furnace service'],
      service_area: 'Portland metro: Portland, Beaverton, Lake Oswego, Tigard, Milwaukie',
    },
  })
  await db.insert(phone_numbers).values({
    id: 'pn_demo',
    workspace_id,
    e164: DEMO.number,
    provider: 'dev',
    mode: 'forward_conditional',
    verified_at: new Date().toISOString(),
  })

  await seedCallsAndContacts(workspace_id)
  await seedBusinessHours(workspace_id)
  await seedDemoRecording(workspace_id)
  console.log(`seeded ${seedCalls.length} calls. Sign in: ${DEMO.email} / ${DEMO.password}`)
}

await seed()
await pool.end()
