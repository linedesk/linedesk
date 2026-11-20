// Settings › Assistant › Calendar without React: what the OAuth callback said, durations, labels.
import type { AppointmentType, AssistantCalendar, CalendarConnection } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { shortDuration } from '../time.ts'

export type ProviderId = CalendarConnection['provider']
export const PROVIDER_LABEL: Record<ProviderId, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  caldav: 'iCloud / CalDAV',
  calcom: 'Cal.com',
  calendly: 'Calendly',
}

/** Providers connected in a form (app-specific password, API key, token), not on the provider's consent page. */
export type KeyProviderId = Extract<ProviderId, 'caldav' | 'calcom' | 'calendly'>
export const isPasswordProvider = (provider: ProviderId): provider is KeyProviderId =>
  provider === 'caldav' || provider === 'calcom' || provider === 'calendly'

/**
 * Where a key is made: a button to the exact page (new tab) and the steps, folded away. A key is never something the
 * member has to go and find (docs/design-principles.md, rule 17). Texts are message keys (settings.keyConnect.*).
 */
export type KeyGuide = { url?: string; linkLabel?: MessageKey; steps: readonly MessageKey[]; note?: MessageKey }

/** The connect form of a key provider: its key field and where to get the key. */
export const KEY_FORM: Record<
  Exclude<KeyProviderId, 'caldav'>,
  {
    title: MessageKey
    description: MessageKey
    keyLabel: MessageKey
    help: MessageKey
    placeholder: string
    guide: KeyGuide
  }
> = {
  calcom: {
    title: msg('settings.keyConnect.calcom.title'),
    description: msg('settings.keyConnect.calcom.description'),
    keyLabel: msg('settings.keyConnect.calcom.keyLabel'),
    help: msg('settings.keyConnect.calcom.help'),
    placeholder: 'cal_live_…',
    guide: {
      url: 'https://app.cal.com/settings/developer/api-keys',
      linkLabel: msg('settings.keyConnect.calcom.linkLabel'),
      steps: [
        msg('settings.keyConnect.calcom.step1'),
        msg('settings.keyConnect.calcom.step2'),
        msg('settings.keyConnect.calcom.step3'),
        msg('settings.keyConnect.calcom.step4'),
      ],
      note: msg('settings.keyConnect.calcom.note'),
    },
  },
  calendly: {
    title: msg('settings.keyConnect.calendly.title'),
    description: msg('settings.keyConnect.calendly.description'),
    keyLabel: msg('settings.keyConnect.calendly.keyLabel'),
    help: msg('settings.keyConnect.calendly.help'),
    placeholder: 'eyJ…',
    guide: {
      url: 'https://calendly.com/integrations/api_webhooks',
      linkLabel: msg('settings.keyConnect.calendly.linkLabel'),
      steps: [
        msg('settings.keyConnect.calendly.step1'),
        msg('settings.keyConnect.calendly.step2'),
        msg('settings.keyConnect.calendly.step3'),
        msg('settings.keyConnect.calendly.step4'),
      ],
      note: msg('settings.keyConnect.calendly.note'),
    },
  },
}

export type CalDavService = 'icloud' | 'fastmail' | 'other'

/** The CalDAV services the connect form knows: where their server is and how to get an app-specific password. */
export const CALDAV_SERVICES: Record<
  CalDavService,
  { label: MessageKey; serverUrl: string; username: MessageKey; help: MessageKey; guide: KeyGuide }
> = {
  icloud: {
    label: msg('settings.keyConnect.icloud.label'),
    serverUrl: 'https://caldav.icloud.com',
    username: msg('settings.keyConnect.icloud.username'),
    help: msg('settings.keyConnect.icloud.help'),
    guide: {
      url: 'https://account.apple.com/account/manage/section/security',
      linkLabel: msg('settings.keyConnect.icloud.linkLabel'),
      steps: [
        msg('settings.keyConnect.icloud.step1'),
        msg('settings.keyConnect.icloud.step2'),
        msg('settings.keyConnect.icloud.step3'),
        msg('settings.keyConnect.icloud.step4'),
      ],
      note: msg('settings.keyConnect.icloud.note'),
    },
  },
  fastmail: {
    label: msg('settings.keyConnect.fastmail.label'),
    serverUrl: 'https://caldav.fastmail.com',
    username: msg('settings.keyConnect.fastmail.username'),
    help: msg('settings.keyConnect.fastmail.help'),
    guide: {
      url: 'https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords',
      linkLabel: msg('settings.keyConnect.fastmail.linkLabel'),
      steps: [
        msg('settings.keyConnect.fastmail.step1'),
        msg('settings.keyConnect.fastmail.step2'),
        msg('settings.keyConnect.fastmail.step3'),
      ],
    },
  },
  other: {
    label: msg('settings.keyConnect.other.label'),
    serverUrl: '',
    username: msg('settings.keyConnect.other.username'),
    help: msg('settings.keyConnect.other.help'),
    guide: {
      steps: [
        msg('settings.keyConnect.other.step1'),
        msg('settings.keyConnect.other.step2'),
        msg('settings.keyConnect.other.step3'),
      ],
    },
  },
}

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

/** Scheduling tools (Cal.com, Calendly): their calendars are event types, listed with the appointment types. */
export const isSchedulingTool = (provider: ProviderId): boolean => provider === 'calcom' || provider === 'calendly'

/**
 * No calendar account works yet (none connected, or every one needs connecting again): the assistant cannot book, so
 * Booking & calendar is flagged in the assistant's nav as something to do.
 */
export const needsCalendar = (connections: readonly Pick<CalendarConnection, 'status'>[]): boolean =>
  !connections.some(c => c.status === 'connected')

/** The mark of a calendar account: the brand, iCloud for a CalDAV login at Apple, else a neutral calendar. */
export type AccountMark = Exclude<ProviderId, 'caldav'> | 'icloud' | 'caldav'

/**
 * Apple IDs and logins at caldav.icloud.com (the address of a CalDAV login without one is `<user>@<server host>`).
 * The server address itself is not synced: an Apple ID at another domain keeps the neutral mark.
 */
const ICLOUD_ADDRESS = /@(icloud\.com|me\.com|mac\.com|caldav\.icloud\.com)$/i

export function accountMark(connection: Pick<CalendarConnection, 'provider' | 'account_email'>): AccountMark {
  if (connection.provider !== 'caldav') return connection.provider
  return ICLOUD_ADDRESS.test(connection.account_email.trim()) ? 'icloud' : 'caldav'
}

/** The mark of a provider in the connect menus: "iCloud / CalDAV" shows iCloud's, the service most connect there. */
export const connectMark = (provider: ProviderId): AccountMark => (provider === 'caldav' ? 'icloud' : provider)

/** What saving the calendar picker does: the calendars to add and the assistant calendars to remove. */
export function pickChanges(
  current: Pick<AssistantCalendar, 'id' | 'external_id'>[],
  picked: ReadonlySet<string>,
  listed?: ReadonlySet<string>,
): { add: string[]; remove: string[] } {
  const have = new Set(current.map(c => c.external_id))
  return {
    add: [...picked].filter(id => !have.has(id)),
    // Only what the picker showed unticked: a row the account does not list now (a team it lost, a calendar now
    // read-only, a list that failed in part) stays as it is.
    remove: current.filter(c => !picked.has(c.external_id) && (!listed || listed.has(c.external_id))).map(c => c.id),
  }
}

/**
 * A scheduling tool's event types under "Appointment types": all the tool lists (in its order), each with the assistant
 * calendar when one was added; added ones the tool no longer lists (or before the list loads) at the end.
 */
export function toolTypeRows<T extends { id: string }>(
  added: readonly AssistantCalendar[],
  listed: readonly T[] | null,
): { added?: AssistantCalendar; listed?: T }[] {
  const byExternal = new Map(added.map(a => [a.external_id, a]))
  const ids = new Set((listed ?? []).map(l => l.id))
  return [
    ...(listed ?? []).map(l => ({ ...(byExternal.has(l.id) && { added: byExternal.get(l.id) }), listed: l })),
    ...added.filter(a => !ids.has(a.external_id)).map(a => ({ added: a })),
  ]
}
