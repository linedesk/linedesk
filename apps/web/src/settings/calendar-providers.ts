// The calendar providers this install can connect (GET /v1/calendar/providers): settings' Connect buttons and the
// go-live checklist's calendar row, which is left out when there is none.
import { useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import type { ProviderId } from './calendarModel.ts'

async function loadProviders(): Promise<ProviderId[]> {
  const res = await fetch('/v1/calendar/providers', { credentials: 'include' })
  if (!res.ok) throw new Error(i18n().t('common.serverAnswered', { status: res.status }))
  return ((await res.json()) as { providers: ProviderId[] }).providers
}

/**
 * The calendar providers this install can connect: the last known at once; none when they cannot be read; null while
 * loading. `read` false: not read at all (a member, who never sees the checklist).
 */
export function useCalendarProviders(read = true): ProviderId[] | null {
  const { data, error } = useQuery(read ? 'calendar.providers' : null, loadProviders, { persist: true })
  return data ?? (error ? [] : null)
}
