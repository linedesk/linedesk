// What New workspace prefills its country with (countryHintOf in @linedesk/actions): the API answers from the visitor's
// country as the proxy in front names it (CF-IPCountry behind Cloudflare), else the time zone's, else the browser
// language's region. Until it answers, or when it cannot, the same order without the first: the browser's own.
import { type CountryHint, countryHintOf, defaultPhoneCountry, type WorkspaceSettingsData } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import { browserTimeZone } from './settings/timeZones.ts'
import { browserLocale } from './ui/phoneInputModel.ts'

/** The time zone and language this browser sends with a new workspace. */
export const browserPlace = () => ({ timeZone: browserTimeZone(), locale: browserLocale() })

/** The hint from this browser alone (no sign-up location). */
export const localCountryHint = (): CountryHint | null => countryHintOf(browserPlace())

/** GET /v1/workspaces/country-hint; the browser's own hint when the API does not answer. */
export async function loadCountryHint(
  request: typeof fetch = (...args) => fetch(...args),
): Promise<CountryHint | null> {
  const { timeZone, locale } = browserPlace()
  const query = new URLSearchParams({ ...(timeZone ? { timeZone } : {}), ...(locale ? { locale } : {}) })
  try {
    const res = await request(`/v1/workspaces/country-hint?${query}`, { credentials: 'include' })
    if (!res.ok) return localCountryHint()
    return ((await res.json()) as { hint?: CountryHint | null }).hint ?? localCountryHint()
  } catch {
    return localCountryHint()
  }
}

/** The hint, the browser's own at once and the API's once it answers. */
export function useCountryHint(): CountryHint | null {
  const [hint, setHint] = useState<CountryHint | null>(localCountryHint)
  useEffect(() => {
    let current = true
    void loadCountryHint().then(h => current && setHint(h))
    return () => {
      current = false
    }
  }, [])
  return hint
}

type Local = { assistantNumber: string | null; businessPhone: string | null; timeZone: string | null; locale: string | null }

/**
 * The workspace's country once its settings have loaded (resolvedCountry); before that, or from an API too old to
 * say, the same order on what this browser has: the assistant's number, the business phone, the browser's own hint
 * (time zone, else language), else the US.
 */
export function phoneCountryFrom(settings: Pick<WorkspaceSettingsData, 'resolvedCountry'> | null | undefined, local: Local) {
  if (settings?.resolvedCountry) return settings.resolvedCountry
  return defaultPhoneCountry({
    assistantNumbers: local.assistantNumber ? [local.assistantNumber] : [],
    businessPhone: local.businessPhone,
    // The hint this browser would give a new workspace (its time zone's country, else its language's region).
    hint: countryHintOf({ timeZone: local.timeZone, locale: local.locale }),
    locale: local.locale,
  })
}
