// The calendar providers members may connect on this install, and how (GET /v1/calendar/providers): settings' Connect
// buttons and the go-live checklist's calendar row, which is left out when there is none. `ways`: by the provider's
// consent page (an OAuth app) or with a key in a form. CalDAV, Calendly and Cal.com only when Server admin switched
// them on.
import { useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import type { ProviderId } from './calendarModel.ts'

export type ConnectWay = 'oauth' | 'key'
export type CalendarProviders = { providers: ProviderId[]; ways: Partial<Record<ProviderId, ConnectWay>> }

async function loadProviders(): Promise<CalendarProviders> {
  const res = await fetch('/v1/calendar/providers', { credentials: 'include' })
  if (!res.ok) throw new Error(i18n().t('common.serverAnswered', { status: res.status }))
  const body = (await res.json()) as Partial<CalendarProviders>
  const providers = body.providers ?? []
  // An API of the release before sends no ways: everything it lists connects by consent page, CalDAV with a key.
  return { providers, ways: body.ways ?? Object.fromEntries(providers.map(p => [p, p === 'caldav' ? 'key' : 'oauth'])) }
}

/**
 * The calendar providers this install can connect: the last known at once; none when they cannot be read; null while
 * loading. `read` false: not read at all (a member, who never sees the checklist).
 */
export function useCalendarProviders(read = true): ProviderId[] | null {
  return useCalendarConnectWays(read)?.providers ?? null
}

export function useCalendarConnectWays(read = true): CalendarProviders | null {
  const { data, error } = useQuery(read ? 'calendar.providers.v2' : null, loadProviders, { persist: true })
  return data ?? (error ? { providers: [], ways: {} } : null)
}
