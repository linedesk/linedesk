// Test data for one existing account's workspace, for local development: `pnpm db:seed -- --user <email>`.
// Finishes onboarding and fills the workspace like a business a few days in: assistant with instructions,
// business hours, a test number, appointment types, contacts, team, and calls in every inbox view.
// Every row it adds has an id with the workspace's seed tag, so `--reset` replaces exactly those and leaves
// the member's own calls, contacts and settings alone. Fictional data only (555-01xx numbers, .test emails).
import {
  appointment_types,
  assistants,
  availability_exceptions,
  availability_rules,
  bookings,
  calls,
  contacts,
  invitation,
  member,
  organization,
  phone_numbers,
  transcript_segments,
  user,
  workspace_settings,
} from '@linedesk/db'
import { DEFAULT_AI_DISCLOSURE, RING_SECONDS_DEFAULT } from '@linedesk/actions'
import { and, asc, eq, inArray, like } from 'drizzle-orm'
import { db } from './db.ts'
import { DEMO_ASSISTANT, GREETING, type SeedCall, seedCalls } from './demo-calls.ts'
import { renamed } from './sample-calls.ts'

type Booking = { type: string; inDays: number; hour: number; status?: 'confirmed' | 'rescheduled' }
type WorkspaceSeedCall = SeedCall & {
  done?: boolean
  /** A reminder this many hours from now. */
  remindInHours?: number
  assign?: 'owner' | 'teammate'
  transfer?: { result: 'connected' | 'not_answered' }
  booking?: Booking
  source?: 'phone' | 'test'
  blocked?: boolean
}

export type SeedOptions = { email: string; business?: string; reset?: boolean; now?: Date }
export type SeedResult = { workspaceId: string; skipped: boolean; counts: Record<string, number> }

const ONCALL_NUMBER = '+15035550199'
const OFFICE_NUMBER = '+15035550187'
const greet: SeedCall['lines'][number] = ['agent', GREETING]
const HOUR = 60

const INSTRUCTIONS = `We are a family-run plumbing and heating company in Portland, Oregon (Portland, Beaverton, Lake Oswego, Tigard, Milwaukie).
Services: leak repair, water heaters (tank and tankless), drain cleaning, bathroom remodels, furnace service.
Never quote prices for jobs on the phone: Mike sends quotes himself. The one price you may tell callers: the after-hours call-out fee is $150, credited to the job.
Urgent: water that can't be shut off, a sewer backup, or no heat in freezing weather. Mark these calls urgent.`

// On top of the demo morning (demo-calls.ts): bookings, a transfer, reminders, done, assigned, a test call, older history.
const extraCalls: WorkspaceSeedCall[] = [
  {
    name: 'Kevin Marsh',
    phone: '+15035550171',
    minutesAgo: 140,
    durationSec: 164,
    outcome: 'booked',
    title: 'Booked: repair visit for a running toilet',
    summary: 'Upstairs toilet runs constantly. Booked a repair visit for tomorrow at 9 am.',
    fields: [{ label: 'Address', value: '845 NW 23rd Ave, Portland' }],
    booking: { type: 'repair', inDays: 1, hour: 9 },
    lines: [
      greet,
      ['caller', 'Hi, my upstairs toilet keeps running all the time. Can someone come look at it?'],
      ['agent', 'Of course. I can book a repair visit. What is the address?'],
      ['caller', '845 Northwest 23rd Avenue.'],
      ['agent', 'Thanks. Tomorrow at 9 am or Thursday at 1 pm, which suits you better?'],
      ['caller', 'Tomorrow at 9 is great.'],
      ['system', 'Booked Repair visit, tomorrow 9:00'],
      ['agent', 'You are booked for tomorrow at 9 am. You will get a confirmation by text. Anything else?'],
      ['caller', 'No, that is it. Thanks!'],
    ],
  },
  {
    name: 'Anita Gomez',
    phone: '+15035550174',
    minutesAgo: 6 * HOUR,
    durationSec: 97,
    outcome: 'rescheduled',
    unread: false,
    title: 'Estimate moved to Friday',
    summary: 'Moved her free estimate for a tankless water heater from Wednesday to Friday 2 pm.',
    booking: { type: 'estimate', inDays: 3, hour: 14, status: 'rescheduled' },
    lines: [
      greet,
      ['caller', 'I have an estimate on Wednesday but I need to move it, can we do Friday?'],
      ['agent', 'Sure. Friday at 2 pm is open. Shall I move it there?'],
      ['caller', 'Yes please.'],
      ['system', 'Rescheduled Free estimate to Friday 14:00'],
      ['agent', 'Done, your estimate is now Friday at 2 pm.'],
    ],
  },
  {
    name: 'Rob Delgado',
    phone: '+15035550176',
    minutesAgo: 75,
    durationSec: 212,
    outcome: 'transferred',
    urgency: 'urgent',
    done: true,
    title: 'Water heater leaking, valve stuck, put through to Mike',
    summary:
      'Water heater in the garage leaking and the shut-off valve is stuck. Put through to Mike, who talked him through it and is on his way.',
    transfer: { result: 'connected' },
    fields: [{ label: 'Address', value: '2210 SE Hawthorne Blvd, Portland' }],
    lines: [
      greet,
      ['caller', 'My water heater in the garage is leaking and the valve will not turn.'],
      ['agent', 'That sounds urgent. I am putting you through to Mike now.'],
      ['system', 'Flagged as urgent'],
      ['system', `Transferring to ${ONCALL_NUMBER}`],
      ['human', 'Hi Rob, this is Mike. Is the water spreading?'],
      ['caller', 'It is pooling on the floor.'],
      ['human', 'Shut the main water valve by the meter if you can reach it, I will be there in 20 minutes.'],
    ],
  },
  {
    name: 'Helen Brooks',
    phone: '+15035550178',
    minutesAgo: 40,
    durationSec: 133,
    outcome: 'callback',
    urgency: 'urgent',
    title: 'No heat, elderly mother at home',
    summary:
      'Furnace stopped overnight; her 84-year-old mother lives with her. Transfer was not answered, message taken.',
    next: 'Call Helen back first thing',
    transfer: { result: 'not_answered' },
    assign: 'owner',
    lines: [
      greet,
      ['caller', 'Our furnace stopped working last night and my mother is 84, it is getting cold.'],
      ['system', 'Flagged as urgent'],
      ['agent', 'I understand. Let me try to put you through to Mike right away.'],
      ['system', `Transferring to ${ONCALL_NUMBER}`],
      ['system', 'Transfer not answered'],
      [
        'agent',
        'Mike could not pick up right now. I have marked this urgent and he will call you back as soon as possible.',
      ],
    ],
  },
  {
    name: 'Chris Novak',
    phone: '+15035550181',
    minutesAgo: 3 * HOUR,
    durationSec: 81,
    outcome: 'message',
    title: 'Wants a second quote for a sewer line',
    summary: 'Has a quote for a sewer line replacement and wants a second opinion. Available after 4 pm.',
    next: 'Call Chris after 4 pm',
    remindInHours: 5,
    lines: [
      greet,
      ['caller', 'I got a quote for replacing my sewer line and want a second opinion.'],
      ['agent', 'Happy to pass that on. When is a good time to reach you?'],
      ['caller', 'After 4 pm.'],
      ['system', 'Took a message'],
    ],
  },
  {
    name: 'Jenny Cho',
    phone: '+15035550184',
    minutesAgo: 4 * HOUR,
    durationSec: 102,
    outcome: 'message',
    title: 'Dripping shower valve, can wait until next week',
    summary: 'Shower valve drips slowly. Not urgent; next week is fine. Prefers text.',
    next: 'Text Jenny to set a time next week',
    assign: 'teammate',
    lines: [
      greet,
      ['caller', 'My shower keeps dripping a bit. It is not urgent, next week is fine.'],
      ['agent', 'Got it. How should we reach you?'],
      ['caller', 'Text is best.'],
      ['system', 'Took a message'],
    ],
  },
  {
    name: 'Kevin Marsh',
    phone: '+15035550171',
    minutesAgo: 3 * 24 * HOUR,
    durationSec: 58,
    outcome: 'answered',
    unread: false,
    done: true,
    title: 'Asked about the service area',
    summary: 'Asked whether we come to the Pearl District. Yes, it is in the service area.',
    lines: [
      greet,
      ['caller', 'Do you come out to the Pearl District?'],
      ['agent', 'Yes, the Pearl District is in our service area.'],
    ],
  },
  {
    name: 'Olivia Grant',
    phone: '+15035550186',
    minutesAgo: 4 * 24 * HOUR,
    durationSec: 145,
    outcome: 'booked',
    unread: false,
    done: true,
    title: 'Booked: water heater service',
    summary: 'Annual service for a tankless water heater, booked for next Monday at 10 am.',
    booking: { type: 'service', inDays: 5, hour: 10 },
    lines: [
      greet,
      ['caller', 'I need the yearly service on my tankless water heater.'],
      ['agent', 'Next Monday at 10 am is open, does that work?'],
      ['caller', 'Perfect.'],
      ['system', 'Booked Water heater service, Monday 10:00'],
    ],
  },
  {
    name: null,
    phone: '+15035550193',
    minutesAgo: 5 * 24 * HOUR,
    durationSec: 19,
    outcome: 'spam',
    urgency: 'low',
    unread: false,
    blocked: true,
    title: 'Robocall: extended car warranty',
    summary: 'Recorded sales message. The number is blocked.',
    lines: [
      greet,
      ['caller', 'We have been trying to reach you about your car’s extended warranty.'],
      ['system', 'Ended the call'],
    ],
  },
  {
    name: 'Mike Brennan',
    phone: ONCALL_NUMBER,
    minutesAgo: 2 * 24 * HOUR,
    durationSec: 66,
    outcome: 'answered',
    unread: false,
    source: 'test',
    title: 'Test call: opening hours',
    summary: 'Test call from the settings: asked about Saturday hours.',
    lines: [greet, ['caller', 'Are you open on Saturdays?'], ['agent', 'Yes, Saturdays from 8 am to noon.']],
  },
]

// Contacts without calls yet, so Contacts has notes, companies and emails to look at.
const extraContacts = [
  {
    name: 'Northside Property Management',
    company: 'Northside PM',
    phone: '+15035550152',
    email: 'office@northside-pm.test',
    note: 'Manages 14 rentals in NE Portland. Net 30 invoices.',
  },
  {
    name: 'Dana Whitaker',
    company: null,
    phone: '+15035550154',
    email: 'dana.whitaker@example.com',
    address: '1501 SW Jefferson St, Portland',
    note: 'Prefers morning appointments. Dog in the yard.',
  },
  {
    name: 'Lakeside Café',
    company: 'Lakeside Café',
    phone: '+15035550156',
    email: 'manager@lakeside-cafe.test',
    address: '40 N State St, Lake Oswego',
    note: 'Grease trap service every quarter.',
  },
]

const appointmentTypes = [
  {
    key: 'repair',
    name: 'Repair visit',
    duration_min: 60,
    buffer_min: 30,
    min_notice_hours: 2,
    location: 'on_site' as const,
    required_fields: ['address', 'phone'] as const,
  },
  {
    key: 'estimate',
    name: 'Free estimate',
    duration_min: 45,
    buffer_min: 15,
    min_notice_hours: 24,
    location: 'on_site' as const,
    required_fields: ['address', 'email'] as const,
  },
  {
    key: 'service',
    name: 'Water heater service',
    duration_min: 90,
    buffer_min: 30,
    min_notice_hours: 24,
    location: 'on_site' as const,
    required_fields: ['address'] as const,
  },
  {
    key: 'phone',
    name: 'Phone consultation',
    duration_min: 15,
    buffer_min: 0,
    min_notice_hours: 1,
    location: 'phone' as const,
    required_fields: [] as const,
  },
]

const teammates = [
  { key: 'jordan', name: 'Jordan Lee', role: 'admin' },
  { key: 'sam', name: 'Sam Patel', role: 'member' },
]

/** The tag in every id this seed writes for one workspace (ids are global, so it includes the workspace). */
export const seedTag = (workspaceId: string) =>
  `seed${workspaceId
    .slice(0, 10)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}`
const seedId = (tag: string, kind: string, n: number | string) => `${kind}_${tag}_${n}`
const teammateEmail = (tag: string, key: string) => `${key}+${tag}@brightwater.test`

async function findOwnerWorkspace(email: string) {
  const [owner] = await db.select().from(user).where(eq(user.email, email.toLowerCase()))
  if (!owner) throw new Error(`No user ${email}. Create the workspace in Server admin › Workspaces › New workspace (or workspace-create.ts) first.`)
  const [ws] = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .innerJoin(
      member,
      and(eq(member.organizationId, organization.id), eq(member.userId, owner.id), eq(member.role, 'owner')),
    )
    .orderBy(asc(organization.createdAt))
    .limit(1)
  if (!ws) throw new Error(`${email} owns no workspace. Create the workspace in Server admin › Workspaces › New workspace (or workspace-create.ts) first.`)
  return { owner, workspace: ws }
}

/** Removes what an earlier run of this seed added to the workspace; nothing else. */
async function removeSeeded(workspaceId: string, tag: string) {
  const ours = `%\\_${tag}\\_%`
  await db.transaction(async tx => {
    await tx.delete(bookings).where(and(eq(bookings.workspace_id, workspaceId), like(bookings.id, ours)))
    await tx
      .delete(transcript_segments)
      .where(and(eq(transcript_segments.workspace_id, workspaceId), like(transcript_segments.id, ours)))
    await tx.delete(calls).where(and(eq(calls.workspace_id, workspaceId), like(calls.id, ours)))
    await tx.delete(contacts).where(and(eq(contacts.workspace_id, workspaceId), like(contacts.id, ours)))
    await tx
      .delete(appointment_types)
      .where(and(eq(appointment_types.workspace_id, workspaceId), like(appointment_types.id, ours)))
    await tx
      .delete(availability_rules)
      .where(and(eq(availability_rules.workspace_id, workspaceId), like(availability_rules.id, ours)))
    await tx
      .delete(availability_exceptions)
      .where(and(eq(availability_exceptions.workspace_id, workspaceId), like(availability_exceptions.id, ours)))
    await tx.delete(invitation).where(and(eq(invitation.organizationId, workspaceId), like(invitation.id, ours)))
    // Teammates: their member rows go with the user (cascade).
    await tx.delete(user).where(
      inArray(
        user.email,
        teammates.map(t => teammateEmail(tag, t.key)),
      ),
    )
  })
}

async function seedSettings(workspaceId: string, tag: string, business: string) {
  await db.update(organization).set({ name: business }).where(eq(organization.id, workspaceId))
  await db
    .insert(workspace_settings)
    .values({ workspace_id: workspaceId, timezone: 'America/Los_Angeles' })
    .onConflictDoNothing({ target: workspace_settings.workspace_id })
  await db
    .update(workspace_settings)
    .set({ timezone: 'America/Los_Angeles', onboarding_step: 'done', business_hours_on: true })
    .where(eq(workspace_settings.workspace_id, workspaceId))
  // Hours the member set themselves stay; the seed only fills a workspace without any.
  const [hasHours] = await db
    .select({ id: availability_rules.id })
    .from(availability_rules)
    .where(eq(availability_rules.workspace_id, workspaceId))
    .limit(1)
  if (hasHours) return
  const weekdays = [1, 2, 3, 4, 5].map(weekday => ({ weekday, start_time: '07:00', end_time: '18:00' }))
  await db
    .insert(availability_rules)
    .values(
      [...weekdays, { weekday: 6, start_time: '08:00', end_time: '12:00' }].map(r => ({
        ...r,
        id: seedId(tag, 'ar', r.weekday),
        workspace_id: workspaceId,
      })),
    )
  await db.insert(availability_exceptions).values([
    { id: seedId(tag, 'ae', 1), workspace_id: workspaceId, date: '2026-11-26', name: 'Thanksgiving' },
    { id: seedId(tag, 'ae', 2), workspace_id: workspaceId, date: '2026-12-24', name: 'Christmas Eve', start_time: '08:00', end_time: '12:00' },
    { id: seedId(tag, 'ae', 3), workspace_id: workspaceId, date: '2026-12-25', name: 'Christmas Day' },
  ])
}

/** The workspace's first assistant, set up as Maya with instructions and warm transfer of urgent calls. */
async function seedAssistant(workspaceId: string, business: string): Promise<string> {
  const [first] = await db
    .select()
    .from(assistants)
    .where(eq(assistants.workspace_id, workspaceId))
    .orderBy(asc(assistants.created_at))
    .limit(1)
  const values = {
    name: DEMO_ASSISTANT,
    greeting: renamed(GREETING, business, DEMO_ASSISTANT),
    greeting_outside: `Thanks for calling ${business}. We are closed right now. This is ${DEMO_ASSISTANT}, the AI assistant. How can I help?`,
    ai_disclosure: DEFAULT_AI_DISCLOSURE,
    business_profile: {
      instructions: INSTRUCTIONS,
      description: 'Family-run plumbing and heating company in Portland, Oregon.',
      services: ['Leak repair', 'Water heaters', 'Drain cleaning', 'Bathroom remodels', 'Furnace service'],
      service_area: 'Portland metro: Portland, Beaverton, Lake Oswego, Tigard, Milwaukie',
      hours: 'Mon–Fri 7 am – 6 pm, Sat 8 am – noon',
    },
    transfers: [
      {
        id: 'oncall',
        name: 'Mike (on-call)',
        number: ONCALL_NUMBER,
        condition: 'Urgent: a burst pipe, flooding, a sewer backup or no heat in freezing weather',
        hours_only: false,
        ring_seconds: RING_SECONDS_DEFAULT,
        if_no_answer: 'message' as const,
        enabled: true,
      },
      {
        id: 'office',
        name: 'Office',
        number: OFFICE_NUMBER,
        condition: 'Billing questions, or the caller asks to speak to a person',
        hours_only: true,
        ring_seconds: RING_SECONDS_DEFAULT,
        if_no_answer: 'message' as const,
        enabled: true,
      },
    ],
  }
  if (first) {
    await db.update(assistants).set(values).where(eq(assistants.id, first.id))
    return first.id
  }
  const id = `as_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  await db.insert(assistants).values({ id, workspace_id: workspaceId, ...values })
  return id
}

/** The workspace's number, or a new dev (no carrier) number from the fictional 555-01xx range. */
async function seedNumber(workspaceId: string, assistantId: string): Promise<string> {
  const [own] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, workspaceId)).limit(1)
  if (own) return own.e164
  const taken = new Set(
    (
      await db.select({ e164: phone_numbers.e164 }).from(phone_numbers).where(like(phone_numbers.e164, '+1503555%'))
    ).map(r => r.e164),
  )
  const e164 = Array.from({ length: 100 }, (_, n) => `+150355501${String(n).padStart(2, '0')}`).find(n => !taken.has(n))
  if (!e164) throw new Error('no free test number in +15035550100–199')
  await db.insert(phone_numbers).values({
    id: `pn_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
    workspace_id: workspaceId,
    e164,
    provider: 'dev',
    provider_ref: `dev_${e164}`,
    mode: 'forward_conditional',
    assistant_id: assistantId,
    verified_at: new Date().toISOString(),
  })
  return e164
}

async function seedTeam(workspaceId: string, tag: string, ownerId: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {}
  for (const t of teammates) {
    const id = seedId(tag, 'usr', t.key)
    await db.insert(user).values({ id, name: t.name, email: teammateEmail(tag, t.key), emailVerified: true })
    await db
      .insert(member)
      .values({
        id: seedId(tag, 'mem', t.key),
        organizationId: workspaceId,
        userId: id,
        role: t.role,
        createdAt: new Date(),
      })
    ids[t.key] = id
  }
  await db.insert(invitation).values({
    id: seedId(tag, 'inv', 1),
    organizationId: workspaceId,
    email: teammateEmail(tag, 'casey'),
    role: 'member',
    status: 'pending',
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    inviterId: ownerId,
  })
  return ids
}

async function seedAppointmentTypes(
  workspaceId: string,
  tag: string,
): Promise<Record<string, { id: string; name: string; duration_min: number }>> {
  const rows = appointmentTypes.map(({ key, required_fields, ...t }) => ({
    ...t,
    id: seedId(tag, 'apt', key),
    workspace_id: workspaceId,
    required_fields: [...required_fields],
  }))
  await db.insert(appointment_types).values(rows)
  return Object.fromEntries(appointmentTypes.map((t, n) => [t.key, rows[n]!]))
}

/** Local date `inDays` ahead at `hour`:00 in the business's zone, close enough for test data (Pacific, UTC-8). */
function slot(now: Date, inDays: number, hour: number): Date {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() + inDays)
  d.setUTCHours(hour + 8, 0, 0, 0)
  return d
}

type CallContext = {
  workspaceId: string
  tag: string
  business: string
  number: string
  assistantId: string
  ownerId: string
  teammateId: string
  types: Awaited<ReturnType<typeof seedAppointmentTypes>>
  now: Date
}

/** The rows for the calls, in one insert per table (callers that call again share their contact). */
async function seedCallsFor(ctx: CallContext, list: WorkspaceSeedCall[]) {
  const { workspaceId, tag, business, now } = ctx
  const say = (text: string) => renamed(text, business, DEMO_ASSISTANT)
  const contactRows = new Map<string, typeof contacts.$inferInsert>()
  const callRows: (typeof calls.$inferInsert)[] = []
  const segmentRows: (typeof transcript_segments.$inferInsert)[] = []
  const bookingRows: (typeof bookings.$inferInsert)[] = []
  for (const [i, c] of list.entries()) {
    if (!contactRows.has(c.phone))
      contactRows.set(c.phone, {
        id: seedId(tag, 'ct', i),
        workspace_id: workspaceId,
        name: c.name,
        name_source: c.name ? 'member' : null,
        phone: c.phone,
        blocked_at: c.blocked ? now.toISOString() : null,
      })
    const contact_id = contactRows.get(c.phone)!.id
    const callId = seedId(tag, 'call', i)
    const started = new Date(now.getTime() - c.minutesAgo * 60_000)
    callRows.push({
      id: callId,
      workspace_id: workspaceId,
      contact_id,
      from_number: c.phone,
      to_number: ctx.number,
      source: c.source ?? 'phone',
      started_at: started.toISOString(),
      ended_at: new Date(started.getTime() + c.durationSec * 1000).toISOString(),
      duration_sec: c.durationSec,
      status: 'completed',
      outcome: c.outcome,
      urgency: c.urgency ?? 'normal',
      title: say(c.title),
      summary: say(c.summary),
      action_items: c.next ? [{ text: say(c.next) }] : [],
      fields: c.fields ?? [],
      assistant_id: ctx.assistantId,
      unread: c.unread ?? true,
      inbox_state: c.done ? 'done' : 'open',
      reminder_at: c.remindInHours ? new Date(now.getTime() + c.remindInHours * 3600_000).toISOString() : null,
      reminder_label: c.remindInHours ? `In ${c.remindInHours} hours` : null,
      assignee_id: c.assign === 'owner' ? ctx.ownerId : c.assign === 'teammate' ? ctx.teammateId : null,
      transfer_to: c.transfer ? ONCALL_NUMBER : null,
      transfer_name: c.transfer ? 'Mike (on-call)' : null,
      transfer_result: c.transfer?.result ?? null,
      transfer_at: c.transfer ? new Date(started.getTime() + 30_000).toISOString() : null,
    })
    const step = Math.floor((c.durationSec * 1000) / (c.lines.length + 1))
    segmentRows.push(
      ...c.lines.map(([speaker, text], n) => ({
        id: `${seedId(tag, 'seg', i)}_${n}`,
        workspace_id: workspaceId,
        call_id: callId,
        speaker,
        text: say(text),
        at_ms: n * step,
        tool_event: speaker === 'system' ? { tool: 'system', label: text } : null,
      })),
    )
    if (c.booking) bookingRows.push(bookingRow(ctx, c, c.booking, callId, contact_id, i))
  }
  await db.transaction(async tx => {
    await tx.insert(contacts).values([...contactRows.values()])
    await tx.insert(calls).values(callRows)
    await tx.insert(transcript_segments).values(segmentRows)
    if (bookingRows.length) await tx.insert(bookings).values(bookingRows)
  })
}

function bookingRow(
  ctx: CallContext,
  c: WorkspaceSeedCall,
  b: Booking,
  callId: string,
  contactId: string,
  n: number,
): typeof bookings.$inferInsert {
  const type = ctx.types[b.type]
  if (!type) throw new Error(`unknown appointment type ${b.type}`)
  const start = slot(ctx.now, b.inDays, b.hour)
  return {
    id: seedId(ctx.tag, 'bk', n),
    workspace_id: ctx.workspaceId,
    call_id: callId,
    contact_id: contactId,
    appointment_type_id: type.id,
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + type.duration_min * 60_000).toISOString(),
    status: b.status ?? 'confirmed',
    title: `${type.name} · ${c.name ?? c.phone}`,
    calendar_name: 'Jobs',
  }
}

async function seedExtraContacts(workspaceId: string, tag: string) {
  await db
    .insert(contacts)
    .values(extraContacts.map((c, n) => ({ ...c, name_source: 'member' as const, id: seedId(tag, 'ctx', n), workspace_id: workspaceId })))
}

async function countSeeded(workspaceId: string, tag: string) {
  const ours = `%\\_${tag}\\_%`
  const count = (rows: unknown[]) => rows.length
  return {
    calls: count(
      await db
        .select({ id: calls.id })
        .from(calls)
        .where(and(eq(calls.workspace_id, workspaceId), like(calls.id, ours))),
    ),
    contacts: count(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.workspace_id, workspaceId), like(contacts.id, ours))),
    ),
    bookings: count(
      await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(eq(bookings.workspace_id, workspaceId), like(bookings.id, ours))),
    ),
    appointment_types: count(
      await db
        .select({ id: appointment_types.id })
        .from(appointment_types)
        .where(and(eq(appointment_types.workspace_id, workspaceId), like(appointment_types.id, ours))),
    ),
    teammates: count(
      await db
        .select({ id: user.id })
        .from(user)
        .where(
          inArray(
            user.email,
            teammates.map(t => teammateEmail(tag, t.key)),
          ),
        ),
    ),
    invitations: count(
      await db
        .select({ id: invitation.id })
        .from(invitation)
        .where(and(eq(invitation.organizationId, workspaceId), like(invitation.id, ours))),
    ),
  }
}

/**
 * Fills the first workspace the account owns. Without `reset`, a workspace that already has the seed's rows is
 * left as it is; with `reset`, those rows are replaced (the member's own data stays).
 */
export async function seedUserWorkspace({
  email,
  business,
  reset = false,
  now = new Date(),
}: SeedOptions): Promise<SeedResult> {
  const { owner, workspace } = await findOwnerWorkspace(email)
  const tag = seedTag(workspace.id)
  const before = await countSeeded(workspace.id, tag)
  if (before.calls > 0 && !reset) return { workspaceId: workspace.id, skipped: true, counts: before }
  await removeSeeded(workspace.id, tag)

  const name = business?.trim() || workspace.name
  await seedSettings(workspace.id, tag, name)
  const assistantId = await seedAssistant(workspace.id, name)
  const number = await seedNumber(workspace.id, assistantId)
  const team = await seedTeam(workspace.id, tag, owner.id)
  const types = await seedAppointmentTypes(workspace.id, tag)
  await seedExtraContacts(workspace.id, tag)
  const ctx: CallContext = {
    workspaceId: workspace.id,
    tag,
    business: name,
    number,
    assistantId,
    ownerId: owner.id,
    teammateId: team.sam!,
    types,
    now,
  }
  await seedCallsFor(ctx, [...seedCalls, ...extraCalls])
  return { workspaceId: workspace.id, skipped: false, counts: await countSeeded(workspace.id, tag) }
}
