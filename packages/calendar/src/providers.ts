// Which calendar providers this install offers, and the adapter for a provider by name.
// The OAuth apps are the same ones as for sign-in (GOOGLE_* and MICROSOFT_* variables).
import { createGoogleCalendar, createGoogleOAuth } from './google.ts'
import { createMicrosoftCalendar, createMicrosoftOAuth } from './microsoft.ts'
import {
  type AccessTokenSource, CalendarError, type CalendarLogin, type CalendarOAuth, type CalendarProvider, type CalendarProviderName, type OAuthCalendarProviderName,
} from './provider.ts'

type Env = Record<string, string | undefined>

/** The OAuth side of `name`, or null when its client id and secret are not set. */
export function calendarOAuthFromEnv(name: OAuthCalendarProviderName, env: Env, options?: { fetch?: typeof fetch }): CalendarOAuth | null {
  if (name === 'google') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null
    return createGoogleOAuth({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }, options)
  }
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) return null
  return createMicrosoftOAuth(
    { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenantId: env.MICROSOFT_TENANT_ID || 'common' },
    options,
  )
}

export function configuredCalendarProviders(env: Env): CalendarProviderName[] {
  return (['google', 'microsoft'] as const).filter(name => calendarOAuthFromEnv(name, env))
}

/** What an adapter signs in with: an OAuth token source, or the login of a password provider. */
export type CalendarAccess = { accessToken: AccessTokenSource } | { login: CalendarLogin }

export function createCalendarProvider(
  name: CalendarProviderName,
  options: CalendarAccess & { fetch?: typeof fetch; timeoutMs?: number },
): CalendarProvider {
  if (name === 'caldav' || !('accessToken' in options)) throw new CalendarError(name, 'invalid', 'this calendar provider is not available on this server')
  return name === 'google' ? createGoogleCalendar(options) : createMicrosoftCalendar(options)
}
