// The country a new workspace is prefilled with (countryHintOf in @linedesk/actions): the visitor's country as the
// proxy in front of the install names it, else the time zone's, else the browser language's region. The country comes
// only from X-Linedesk-Country, which Caddy sets from the header LINEDESK_COUNTRY_HEADER names (CF-IPCountry behind
// Cloudflare, docker-compose.cloudflare.yml) and which replaces anything a client sent. No geo-IP lookup here and no
// outside service: without such a proxy there is no sign-up location. Only the two-letter code is ever kept, never
// the address. Self-serve sign-up keeps it as the new workspace's country hint and says "not yet" to a country it does
// not serve (signup-handlers.ts). A client that reaches the API around the proxy can name its own country: it only
// prefills a field, or passes that first gate, which the Business step and Checkout check again (served-countries.ts).
import { type CountryHint, countryHintOf } from '@linedesk/actions'

export const COUNTRY_HEADER = 'x-linedesk-country'

/** The visitor's country code from the proxy (upper case), or null. */
export function ipCountryOf(headers: Headers): string | null {
  const value = headers.get(COUNTRY_HEADER)?.trim().toUpperCase()
  return value && /^[A-Z]{2}$/.test(value) ? value : null
}

/** The hint for a workspace made from this request, with the time zone and browser language the app sent. */
export const requestCountryHint = (
  headers: Headers,
  from: { timeZone?: unknown; locale?: unknown },
): CountryHint | null =>
  countryHintOf({
    ipCountry: ipCountryOf(headers),
    timeZone: typeof from.timeZone === 'string' ? from.timeZone.slice(0, 64) : null,
    locale: typeof from.locale === 'string' ? from.locale.slice(0, 35) : null,
  })
