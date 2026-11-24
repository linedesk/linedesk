// Which calendar providers this install offers, and the adapter for a provider by name.
// The Google and Microsoft OAuth apps are the same ones as for sign-in (GOOGLE_*, MICROSOFT_*); Calendly and Cal.com
// have OAuth apps of their own (CALENDLY_*, CALCOM_*), and without one they connect with a key.
import { createCalComCalendar, createCalComOAuth } from './calcom.ts'
import { createCalDavCalendar } from './caldav.ts'
import { createCalendlyCalendar, createCalendlyOAuth } from './calendly.ts'
import { createGoogleCalendar, createGoogleOAuth } from './google.ts'
import { createMicrosoftCalendar, createMicrosoftOAuth } from './microsoft.ts'
import {
  type AccessTokenSource, CalendarError, type CalendarLogin, PASSWORD_CALENDAR_PROVIDERS, type CalendarOAuth, type CalendarProvider, type CalendarProviderName, type OAuthCalendarProviderName,
} from './provider.ts'

type Env = Record<string, string | undefined>

/** The OAuth side of `name`, or null when its client id and secret are not set. */
export function calendarOAuthFromEnv(name: OAuthCalendarProviderName, env: Env, options?: { fetch?: typeof fetch }): CalendarOAuth | null {
  if (name === 'calendly') {
    if (!env.CALENDLY_CLIENT_ID || !env.CALENDLY_CLIENT_SECRET) return null
    return createCalendlyOAuth({ clientId: env.CALENDLY_CLIENT_ID, clientSecret: env.CALENDLY_CLIENT_SECRET }, options)
  }
  if (name === 'calcom') {
    if (!env.CALCOM_CLIENT_ID || !env.CALCOM_CLIENT_SECRET) return null
    return createCalComOAuth({ clientId: env.CALCOM_CLIENT_ID, clientSecret: env.CALCOM_CLIENT_SECRET }, options)
  }
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

const OAUTH_PROVIDERS = ['google', 'microsoft', 'calendly', 'calcom'] as const

/** The OAuth providers whose app is set up on this install (they connect by consent page). */
export const oauthCalendarProviders = (env: Env): OAuthCalendarProviderName[] => OAUTH_PROVIDERS.filter(name => calendarOAuthFromEnv(name, env))

/** Every provider a business can connect: those with an OAuth app, and the key providers, which need nothing from the install. */
export function configuredCalendarProviders(env: Env): CalendarProviderName[] {
  return [...new Set<CalendarProviderName>([...oauthCalendarProviders(env), ...PASSWORD_CALENDAR_PROVIDERS])]
}

/** What an adapter signs in with: an OAuth token source, or the login of a password provider (and the business's time zone, for all-day events). */
export type CalendarAccess = ({ accessToken: AccessTokenSource } | { login: CalendarLogin }) & { timeZone?: string }

export function createCalendarProvider(
  name: CalendarProviderName,
  options: CalendarAccess & { fetch?: typeof fetch; timeoutMs?: number },
): CalendarProvider {
  if (name === 'caldav') {
    if (!('login' in options)) throw new CalendarError(name, 'invalid', 'a CalDAV account signs in with its login')
    // Never plain fetch: the server is one a member named (the API passes its address guard).
    if (!options.fetch) throw new CalendarError(name, 'invalid', 'a key provider is reached only through the address guard')
    return createCalDavCalendar({ ...options, fetch: options.fetch })
  }
  if (name === 'calcom' || name === 'calendly') {
    // A key or an OAuth token; either way through the address guard, with the tool's own API.
    if (!options.fetch) throw new CalendarError(name, 'invalid', 'a key provider is reached only through the address guard')
    const make = name === 'calcom' ? createCalComCalendar : createCalendlyCalendar
    return make({ ...options, fetch: options.fetch })
  }
  if (!('accessToken' in options)) throw new CalendarError(name, 'invalid', `a ${name} account signs in with OAuth`)
  return name === 'google' ? createGoogleCalendar(options) : createMicrosoftCalendar(options)
}
