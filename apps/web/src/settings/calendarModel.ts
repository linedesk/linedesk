// Settings › Assistant › Calendar without React: what the OAuth callback said, durations, labels.
import type { AppointmentType, AssistantCalendar, CalendarConnection } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { shortDuration } from '../time.ts'

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
      text: i18n().t('settings.calendar.connected'),
      ...(connectionId ? { connectionId } : {}),
    }
  if (result === 'error')
    return { ok: false, text: params.get('reason') || i18n().t('settings.calendar.connectFailed') }
  return null
}

export const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240] as const

/** 90 → "1h 30m": compact like every duration shown as data (time.ts `shortDuration`). */
export const durationLabel = (minutes: number): string => shortDuration(minutes * 60)

/** What the assistant can ask for before booking a type, in the order the form shows them. */
export const BOOKING_FIELDS = ['name', 'phone', 'email', 'address'] as const
export type BookingFieldId = (typeof BOOKING_FIELDS)[number]
/** "Name": the checkbox label of a detail. */
export const fieldLabel = (field: BookingFieldId): string => i18n().t(FIELD_KEY[field])
const FIELD_KEY = {
  name: msg('settings.calendar.field.name'),
  phone: msg('settings.calendar.field.phone'),
  email: msg('settings.calendar.field.email'),
  address: msg('settings.calendar.field.address'),
} satisfies Record<BookingFieldId, MessageKey>
/** "name": the detail inside a sentence ("Asks for name, address"). */
const FIELD_IN_SENTENCE_KEY = {
  name: msg('settings.calendar.askField.name'),
  phone: msg('settings.calendar.askField.phone'),
  email: msg('settings.calendar.askField.email'),
  address: msg('settings.calendar.askField.address'),
} satisfies Record<BookingFieldId, MessageKey>

/** The details a type asks for, the name first (it is stored as name_required). */
export function typeFields(type: Pick<AppointmentType, 'required_fields' | 'name_required'>): BookingFieldId[] {
  return BOOKING_FIELDS.filter(f => (f === 'name' ? type.name_required : type.required_fields.includes(f)))
}

/** Free time a type keeps before and after itself, in minutes. */
export const BUFFERS = [0, 5, 10, 15, 30, 60] as const
export const bufferLabel = (minutes: number) =>
  minutes ? i18n().t('settings.calendar.buffer.minutes', { minutes }) : i18n().t('settings.calendar.buffer.none')

export type BookWhen = AppointmentType['book_when']
export const BOOK_WHEN: BookWhen[] = ['business_hours', 'outside_business_hours', 'any_time']
const BOOK_WHEN_KEY = {
  business_hours: msg('settings.calendar.bookWhen.businessHours'),
  outside_business_hours: msg('settings.calendar.bookWhen.outsideBusinessHours'),
  any_time: msg('settings.calendar.bookWhen.anyTime'),
} satisfies Record<BookWhen, MessageKey>
/** "During business hours". */
export const bookWhenLabel = (when: BookWhen): string => i18n().t(BOOK_WHEN_KEY[when])

/** "15 min before, 10 min after · Outside business hours": the type's booking rules, only what is not the default. */
export function rulesLabel(
  type: Pick<AppointmentType, 'buffer_before_min' | 'buffer_after_min' | 'book_when'>,
): string {
  const { t } = i18n()
  const { buffer_before_min: before, buffer_after_min: after } = type
  const buffers =
    before && before === after
      ? t('settings.calendar.rules.buffer', { minutes: before })
      : before && after
        ? t('settings.calendar.rules.beforeAndAfter', { before, after })
        : before
          ? t('settings.calendar.rules.before', { minutes: before })
          : after
            ? t('settings.calendar.rules.after', { minutes: after })
            : ''
  return [buffers, type.book_when !== 'business_hours' && bookWhenLabel(type.book_when)].filter(Boolean).join(' · ')
}

/** "Asks for name, address": what the assistant asks before booking this type, besides the reason. */
export function requiredLabel(type: Pick<AppointmentType, 'required_fields' | 'name_required'>): string {
  const { t } = i18n()
  const fields = typeFields(type).map(f => t(FIELD_IN_SENTENCE_KEY[f]))
  // A plain comma list ("name, email, address"), no "and".
  return fields.length
    ? t('settings.calendar.asksFor', { fields: fmt().list(fields, { type: 'unit', style: 'short' }) })
    : t('settings.calendar.asksOnlyReason')
}

/** The assistant's calendars, the default first, then in the order they were added. */
export function calendarsOf(rows: AssistantCalendar[], assistantId: string): AssistantCalendar[] {
  return rows
    .filter(c => c.assistant_id === assistantId)
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.created_at.localeCompare(b.created_at))
}
