// What the assistant gets about a returning caller at call.start: their last calls and upcoming bookings.
// Only the contact matched for this call in the same workspace; short and capped, since it goes into the prompt.
import { CALLER_HISTORY_BOOKINGS, CALLER_HISTORY_CALLS, type CallerHistory } from '@linedesk/actions'
import { appointment_types, bookings, calls, type Tx } from '@linedesk/db'
import type { Contact } from '@linedesk/db/types'
import { and, asc, desc, eq, gt, isNull, ne, or } from 'drizzle-orm'
import { bookedNameOf, namesMatch, timeZoneOf } from './bookings.ts'

/** Caps per field (characters), so a few long summaries cannot crowd the prompt. */
export const HISTORY_TITLE_MAX = 80
export const HISTORY_SUMMARY_MAX = 240
export const HISTORY_STEP_MAX = 120
export const HISTORY_STEPS_PER_CALL = 3

/** One line of plain text, cut at `max` characters with an ellipsis; null when empty. */
export function clip(text: string | null | undefined, max: number): string | null {
  const flat = text?.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

const dayFormat = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' })
const timeFormat = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
const isoDay = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })

/** The contact's last finished phone calls before this one, without spam, deleted and test calls. */
async function recentCalls(tx: Tx, workspaceId: string, contactId: string, currentCallId: string, timeZone: string) {
  const rows = await tx
    .select({
      started_at: calls.started_at,
      title: calls.title,
      summary: calls.summary,
      outcome: calls.outcome,
      action_items: calls.action_items,
    })
    .from(calls)
    .where(
      and(
        eq(calls.workspace_id, workspaceId),
        eq(calls.contact_id, contactId),
        ne(calls.id, currentCallId),
        eq(calls.source, 'phone'),
        eq(calls.status, 'completed'),
        isNull(calls.deleted_at),
        or(isNull(calls.outcome), ne(calls.outcome, 'spam')),
      ),
    )
    .orderBy(desc(calls.started_at))
    .limit(CALLER_HISTORY_CALLS)
  const day = dayFormat(timeZone)
  return rows.map(r => ({
    when: day.format(new Date(r.started_at)),
    title: clip(r.title, HISTORY_TITLE_MAX),
    summary: clip(r.summary, HISTORY_SUMMARY_MAX),
    outcome: r.outcome,
    openSteps: r.action_items
      .filter(item => !item.done)
      .slice(0, HISTORY_STEPS_PER_CALL)
      .map(item => clip(item.text, HISTORY_STEP_MAX))
      .filter((s): s is string => !!s),
  }))
}

/**
 * The contact's upcoming bookings booked under the contact's own name: the caller who says that name passes
 * the booking-change check (namesMatch) for exactly these. None without a name on file.
 */
async function upcomingBookings(
  tx: Tx,
  workspaceId: string,
  contact: Pick<Contact, 'id' | 'name'>,
  now: string,
  timeZone: string,
) {
  const name = contact.name?.trim()
  if (!name) return []
  const rows = await tx
    .select({ start_at: bookings.start_at, title: bookings.title, type: appointment_types.name })
    .from(bookings)
    .leftJoin(appointment_types, eq(appointment_types.id, bookings.appointment_type_id))
    .where(
      and(
        eq(bookings.workspace_id, workspaceId),
        eq(bookings.contact_id, contact.id),
        ne(bookings.status, 'cancelled'),
        gt(bookings.start_at, now),
      ),
    )
    .orderBy(asc(bookings.start_at))
    .limit(CALLER_HISTORY_BOOKINGS * 3)
  const [day, time, iso] = [dayFormat(timeZone), timeFormat(timeZone), isoDay(timeZone)]
  return rows
    .filter(r => namesMatch(name, bookedNameOf(r.title)))
    .slice(0, CALLER_HISTORY_BOOKINGS)
    .map(r => {
      const at = new Date(r.start_at)
      return {
        date: iso.format(at),
        when: `${day.format(at)} at ${time.format(at)}`,
        type: clip(r.type, HISTORY_TITLE_MAX),
      }
    })
}

/**
 * `canChangeBookings`: from the call's booking context; bookings are listed only when the caller may change them, and
 * only those booked under the contact's name. Whether the assistant gets the history at all is its owner's switch
 * ("Know the caller's previous calls", call.start); there is no name check.
 */
export async function callerHistory(
  tx: Tx,
  workspaceId: string,
  contact: Pick<Contact, 'id' | 'name' | 'name_source'>,
  { callId, now, canChangeBookings }: { callId: string; now: string; canChangeBookings: boolean },
): Promise<CallerHistory> {
  const timeZone = await timeZoneOf(tx, workspaceId)
  return {
    recentCalls: await recentCalls(tx, workspaceId, contact.id, callId, timeZone),
    upcomingBookings: canChangeBookings ? await upcomingBookings(tx, workspaceId, contact, now, timeZone) : [],
  }
}
