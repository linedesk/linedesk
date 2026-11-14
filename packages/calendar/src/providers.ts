// Which calendar providers this install offers, and the adapter for a provider by name.
// The OAuth apps are the same ones as for sign-in (GOOGLE_* and MICROSOFT_* variables).
import { createCalDavCalendar } from './caldav.ts'
import { createGoogleCalendar, createGoogleOAuth } from './google.ts'
import { createMicrosoftCalendar, createMicrosoftOAuth } from './microsoft.ts'
import {
  type AccessTokenSource, CalendarError, type CalendarLogin, PASSWORD_CALENDAR_PROVIDERS, type CalendarOAuth, type CalendarProvider, type CalendarProviderName, type OAuthCalendarProviderName,
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

/** The OAuth providers whose app is set up, and the password providers, which need nothing from the install. */
export function configuredCalendarProviders(env: Env): CalendarProviderName[] {
  return [...(['google', 'microsoft'] as const).filter(name => calendarOAuthFromEnv(name, env)), ...PASSWORD_CALENDAR_PROVIDERS]
}

/** What an adapter signs in with: an OAuth token source, or the login of a password provider (and the business's time zone, for all-day events). */
export type CalendarAccess = { accessToken: AccessTokenSource } | { login: CalendarLogin; timeZone?: string }

export function createCalendarProvider(
  name: CalendarProviderName,
  options: CalendarAccess & { fetch?: typeof fetch; timeoutMs?: number },
): CalendarProvider {
  if (name === 'caldav') {
    if (!('login' in options)) throw new CalendarError(name, 'invalid', 'a CalDAV account signs in with its login')
    // Never plain fetch: the server is one a member named (the API passes its address guard).
    if (!options.fetch) throw new CalendarError(name, 'invalid', 'a CalDAV server is reached only through the address guard')
    return createCalDavCalendar({ ...options, fetch: options.fetch })
  }
  if (!('accessToken' in options)) throw new CalendarError(name, 'invalid', `a ${name} account signs in with OAuth`)
  return name === 'google' ? createGoogleCalendar(options) : createMicrosoftCalendar(options)
}
