// Settings › Assistant › Calendar without React: what the OAuth callback said, durations, labels.
import type { AppointmentType, AssistantCalendar, CalendarConnection } from '@linedesk/db/types'

export type ProviderId = CalendarConnection['provider']
export const PROVIDER_LABEL: Record<ProviderId, string> = { google: 'Google', microsoft: 'Microsoft' }

/** The assistant a connect started from: the callback returns to #assistant/calendar and the page goes back to it. */
export const CONNECT_RETURN_KEY = 'linedesk.calendarConnectFor'

/**
 * What the OAuth callback put into the hash (`#assistant/calendar?calendar=connected` or
 * `…?calendar=error&reason=…`): a toast text, or null when the hash carries no result. After a
 * connect, `connectionId` names the account (the page opens the picker of its calendars).
 */
export function connectResult(hash: string): { ok: boolean; text: string; connectionId?: string } | null {
  const query = hash.split('?')[1]
  if (!query) return null
  const params = new URLSearchParams(query)
  const result = params.get('calendar')
  const connectionId = params.get('connection')
  if (result === 'connected')
    return {
      ok: true,
      text: 'Calendar connected. Pick the calendars the assistant books into.',
      ...(connectionId ? { connectionId } : {}),
    }
  if (result === 'error') return { ok: false, text: params.get('reason') || 'The calendar could not be connected.' }
  return null
}

export const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240] as const

/** 90 → "1 h 30 min". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return [h ? `${h} h` : null, m ? `${m} min` : null].filter(Boolean).join(' ') || '0 min'
}

/** What the assistant can ask for before booking a type, in the order the form shows them. */
export const BOOKING_FIELDS = ['name', 'phone', 'email', 'address'] as const
export type BookingFieldId = (typeof BOOKING_FIELDS)[number]
export const FIELD_LABEL: Record<BookingFieldId, string> = { name: 'Name', phone: 'Phone', email: 'Email', address: 'Address' }

/** The details a type asks for, the name first (it is stored as name_required). */
export function typeFields(type: Pick<AppointmentType, 'required_fields' | 'name_required'>): BookingFieldId[] {
  return BOOKING_FIELDS.filter(f => (f === 'name' ? type.name_required : type.required_fields.includes(f)))
}

/** "Asks for name, address": what the assistant asks before booking this type, besides the reason. */
export function requiredLabel(type: Pick<AppointmentType, 'required_fields' | 'name_required'>): string {
  const fields = typeFields(type)
  return fields.length ? `Asks for ${fields.map(f => FIELD_LABEL[f].toLowerCase()).join(', ')}` : 'Asks only for the reason'
}

/** The assistant's calendars, the default first, then in the order they were added. */
export function calendarsOf(rows: AssistantCalendar[], assistantId: string): AssistantCalendar[] {
  return rows
    .filter(c => c.assistant_id === assistantId)
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.created_at.localeCompare(b.created_at))
}
