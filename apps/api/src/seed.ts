// Demo workspace: Brightwater Plumbing & Heating (Portland), assistant Maya, owner Mike Brennan.
// Idempotent: the base data is created once; business hours and the demo recording are added to an existing demo too.
// `pnpm db:seed -- --reset` replaces an existing demo's calls and contacts with these (drops old test calls).
// `pnpm db:seed -- --user <email> [--business <name>] [--reset]` fills that account's own workspace instead (seed-workspace.ts).
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
} from '@linedesk/db'
import { DEFAULT_AI_DISCLOSURE, recordingKey, withoutDisclosure } from '@linedesk/actions'
import { parseArgs } from 'node:util'
import { asc, eq } from 'drizzle-orm'
import { auth } from './auth.ts'
import { db, pool } from './db.ts'
import { demoRecordingWav, writeDemoRecording } from './demo-recording.ts'
import { GREETING, seedCalls } from './demo-calls.ts'
import { recordingsDir } from './recording-store.ts'
import { seedUserWorkspace } from './seed-workspace.ts'

export const DEMO = { email: 'mike@brightwater.example', password: 'brightwater-demo', number: '+15035550142' }

const id = (prefix: string, n: number) => `${prefix}_demo_${String(n).padStart(2, '0')}`

const DEMO_SLUG = 'brightwater'

// Business hours Mon–Fri 7 am – 6 pm Pacific, closed on two holidays. No booking types: v1 does not book.
async function seedBusinessHours(workspace_id: string) {
  await db.insert(workspace_settings).values({ workspace_id, timezone: 'America/Los_Angeles' }).onConflictDoNothing()
  // The demo uses its hours (they are opt-in).
  await db
    .update(workspace_settings)
    .set({ business_hours_on: true })
    .where(eq(workspace_settings.workspace_id, workspace_id))
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
      { id: id('ae', 0), workspace_id, date: '2026-11-26', name: 'Thanksgiving' },
      { id: id('ae', 1), workspace_id, date: '2026-12-25', name: 'Christmas Day' },
    ])
    .onConflictDoNothing()
}

/** The quote call gets a stand-in recording on the local disk, so the player can be tried whatever store records new calls. */
async function seedDemoRecording(workspace_id: string) {
  const dir = recordingsDir(process.env)
  const callId = id('call', 2)
  const [call] = await db.select().from(calls).where(eq(calls.id, callId))
  if (!call?.duration_sec) return
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
  await db.update(calls).set({ recording_key: key, recording_store: 'file' }).where(eq(calls.id, callId))
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
  // And the dev install's instance admin: the first user is no longer made one automatically.
  await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.email, DEMO.email))
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
    greeting: withoutDisclosure(GREETING),
    ai_disclosure: DEFAULT_AI_DISCLOSURE,
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

async function main() {
  const { values } = parseArgs({
    // `pnpm db:seed -- --user …` may pass the `--` through.
    args: process.argv.slice(2).filter(a => a !== '--'),
    options: { user: { type: 'string' }, business: { type: 'string' }, reset: { type: 'boolean' } },
    allowPositionals: true,
  })
  if (!values.user) return seed()
  const result = await seedUserWorkspace({ email: values.user, business: values.business, reset: values.reset })
  const counts = Object.entries(result.counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ')
  console.log(
    result.skipped
      ? `${values.user}: workspace ${result.workspaceId} already has test data (${counts}); --reset replaces it`
      : `${values.user}: workspace ${result.workspaceId} filled with ${counts}`,
  )
}

try {
  await main()
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await pool.end()
}
