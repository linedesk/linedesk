// Sample calls for a new workspace ("Try with sample calls"): a trade-neutral morning (sample-morning.ts),
// written in the language of the person who adds them, with the workspace's business and assistant in the greeting,
// filed with source `sample` so the inbox marks them, and removed again in one go. Sample callers are contacts whose id starts with SAMPLE_ID_PREFIX.
import { type FirstUse, firstUseVariants, SAMPLE_ID_PREFIX } from '@linedesk/actions'
import {
  assistants,
  bookings,
  calls,
  contacts,
  organization,
  phone_numbers,
  transcript_segments,
  type Tx,
} from '@linedesk/db'
import { and, asc, eq, inArray, like, notExists } from 'drizzle-orm'
import { DEMO_ASSISTANT, DEMO_BUSINESS } from './demo-calls.ts'
import { type Handler, type Reader, Reject, wordsOf } from './handler-context.ts'
import { type SampleCall, sampleMorning } from './sample-morning.ts'

/** FIRST_USE: how a new workspace is introduced (tour, sample, both, off); both when unset or unknown. */
export function firstUse(env: Record<string, string | undefined> = process.env): FirstUse {
  const value = env.FIRST_USE?.trim().toLowerCase()
  return firstUseVariants.find(v => v === value) ?? 'both'
}

const sampleId = (kind: string) => `${SAMPLE_ID_PREFIX}${kind}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`

/** The demo's words with this workspace's business and assistant names in them. */
export function renamed(text: string, business: string, assistant: string): string {
  // One pass: a business name that itself contains "Brightwater" is not replaced twice.
  return text.replace(/Brightwater Plumbing & Heating|Brightwater/g, business).replaceAll(DEMO_ASSISTANT, assistant)
}

type Names = { business: string; assistant: string; number: string }

/** The rows one sample call needs, its caller included (shared by calls from the same number), in the reader's words. */
function sampleRows(c: SampleCall, workspace_id: string, contact_id: string, names: Names, words: Reader, now: number) {
  const call_id = sampleId('call')
  const started = new Date(now - c.minutesAgo * 60_000)
  const email = words.t('server.sample.quote.email')
  const lines = c.lines.map(line => {
    if (line === 'greeting')
      return [
        'agent',
        words.t('server.sample.greeting', { business: names.business, assistant: names.assistant }),
      ] as const
    return [line[0], words.t(line[1], { email })] as const
  })
  const step = Math.floor((c.durationSec * 1000) / (lines.length + 1))
  return {
    call: {
      id: call_id,
      workspace_id,
      contact_id,
      from_number: c.phone,
      to_number: names.number,
      source: 'sample' as const,
      started_at: started.toISOString(),
      ended_at: new Date(started.getTime() + c.durationSec * 1000).toISOString(),
      duration_sec: c.durationSec,
      status: 'completed' as const,
      outcome: c.outcome,
      urgency: c.urgency ?? 'normal',
      title: words.t(c.title),
      summary: words.t(c.summary),
      action_items: c.next ? [{ text: words.t(c.next) }] : [],
      fields: (c.fields ?? []).map(f => ({ label: words.t(f.label), value: words.t(f.value) })),
      unread: c.unread ?? true,
    },
    segments: lines.map(([speaker, text], n) => ({
      id: `${call_id}_${n}`,
      workspace_id,
      call_id,
      speaker,
      text,
      at_ms: n * step,
      tool_event: speaker === 'system' ? { tool: 'system', label: text } : null,
    })),
  }
}

async function namesOf(tx: Tx, workspace_id: string): Promise<Names> {
  const [org] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, workspace_id))
  const [assistant] = await tx
    .select({ name: assistants.name })
    .from(assistants)
    .where(eq(assistants.workspace_id, workspace_id))
    .orderBy(asc(assistants.created_at))
    .limit(1)
  const [number] = await tx
    .select({ e164: phone_numbers.e164 })
    .from(phone_numbers)
    .where(eq(phone_numbers.workspace_id, workspace_id))
    .limit(1)
  return {
    business: org?.name ?? DEMO_BUSINESS,
    assistant: assistant?.name ?? DEMO_ASSISTANT,
    number: number?.e164 ?? '+15035550100',
  }
}

const sampleCallsOf = (workspace_id: string) => and(eq(calls.workspace_id, workspace_id), eq(calls.source, 'sample'))

export const sampleHandlers: Record<string, Handler> = {
  'sample.add': async ({ tx, actor }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const workspace_id = actor.workspaceId
    const [already] = await tx.select({ id: calls.id }).from(calls).where(sampleCallsOf(workspace_id)).limit(1)
    if (already) return { rows: {} }
    const names = await namesOf(tx, workspace_id)
    const words = wordsOf(actor)
    const now = Date.now()
    const callers = new Map<string, string>()
    const newContacts: (typeof contacts.$inferInsert)[] = []
    const rows = sampleMorning.map(c => {
      let contact_id = callers.get(c.phone)
      if (!contact_id) {
        contact_id = sampleId('ct')
        callers.set(c.phone, contact_id)
        newContacts.push({ id: contact_id, workspace_id, name: c.name && words.t(c.name), phone: c.phone })
      }
      return sampleRows(c, workspace_id, contact_id, names, words, now)
    })
    const insertedContacts = await tx.insert(contacts).values(newContacts).returning()
    const insertedCalls = await tx
      .insert(calls)
      .values(rows.map(r => r.call))
      .returning()
    const insertedSegments = await tx
      .insert(transcript_segments)
      .values(rows.flatMap(r => r.segments))
      .returning()
    return { rows: { contacts: insertedContacts, calls: insertedCalls, transcript_segments: insertedSegments } }
  },

  // Transcripts go with their calls (foreign key cascade). A sample caller with a booking stays.
  'sample.remove': async ({ tx, actor }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const workspace_id = actor.workspaceId
    const ids = (await tx.select({ id: calls.id }).from(calls).where(sampleCallsOf(workspace_id))).map(r => r.id)
    if (!ids.length) return { rows: {} }
    const segments = await tx
      .select({ id: transcript_segments.id })
      .from(transcript_segments)
      .where(and(eq(transcript_segments.workspace_id, workspace_id), inArray(transcript_segments.call_id, ids)))
    await tx.delete(calls).where(sampleCallsOf(workspace_id))
    const removedContacts = await tx
      .delete(contacts)
      .where(
        and(
          eq(contacts.workspace_id, workspace_id),
          like(contacts.id, `${SAMPLE_ID_PREFIX}%`),
          notExists(tx.select({ id: calls.id }).from(calls).where(eq(calls.contact_id, contacts.id))),
          notExists(tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.contact_id, contacts.id))),
        ),
      )
      .returning({ id: contacts.id })
    return {
      rows: {},
      deleted: { calls: ids, transcript_segments: segments.map(s => s.id), contacts: removedContacts.map(c => c.id) },
      data: { removed: ids.length },
    }
  },
}
