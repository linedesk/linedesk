// Google Places API (New): find a business by name and city, then read its listing. Called only from the API
// (business.search, business.import) with the install's key (Admin › Providers › Business lookup). Each request asks
// for as few fields as it needs (the field mask decides what Google bills), has a timeout, and nothing Google
// says is passed on as an error: the owner gets a fixed sentence.
import { BUSINESS_SEARCH_RESULTS, type BusinessCandidate, type BusinessHoursSpan } from '@linedesk/actions'

const BASE = 'https://places.googleapis.com/v1'
export const PLACES_TIMEOUT_MS = 8_000
/** Text Search: only what the pick list shows. */
export const SEARCH_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress'
/** Place Details: what the profile proposal uses. */
export const DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'addressComponents',
  'internationalPhoneNumber',
  'websiteUri',
  'regularOpeningHours',
  'primaryType',
  'types',
  'timeZone',
].join(',')

/**
 * A request Google refused or did not answer; the message is ours, for the owner. `reason` uses the provider-failure
 * words (LIN-111): `auth` is a key Google refused, which only whoever runs the server can fix.
 */
export type PlacesFailure = 'auth' | 'quota' | 'not_found' | 'network' | 'timeout' | 'unknown'
export class PlacesError extends Error {
  reason: PlacesFailure
  constructor(message: string, reason: PlacesFailure) {
    super(message)
    this.reason = reason
  }
}

const SEARCH_FAILED = 'The business search failed. Try again, or enter your business by hand.'
const KEY_REFUSED = "Google refused this server's business lookup key."

type PlacesPoint = { day?: number; hour?: number; minute?: number }
export type PlacesPeriod = { open?: PlacesPoint; close?: PlacesPoint }

/** The fields of a listing we read (Place, Places API New). */
export type PlaceDetails = {
  id?: string
  displayName?: { text?: string }
  formattedAddress?: string
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[]
  internationalPhoneNumber?: string
  websiteUri?: string
  regularOpeningHours?: { periods?: PlacesPeriod[]; weekdayDescriptions?: string[] }
  primaryType?: string
  types?: string[]
  timeZone?: { id?: string }
}

type Fetch = typeof fetch

async function placesRequest(
  doFetch: Fetch,
  apiKey: string,
  url: string,
  fieldMask: string,
  body?: unknown,
): Promise<unknown> {
  let res: Response
  try {
    res = await doFetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'x-goog-fieldmask': fieldMask,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError')
      throw new PlacesError('Google did not answer in time. Try again.', 'timeout')
    throw new PlacesError('Google could not be reached. Try again.', 'network')
  }
  if (res.status === 429) throw new PlacesError('Too many searches right now. Try again in a minute.', 'quota')
  if (res.status === 401 || res.status === 403) {
    console.warn(`places: key refused (HTTP ${res.status})`)
    throw new PlacesError(KEY_REFUSED, 'auth')
  }
  if (res.status === 404) throw new PlacesError('That listing was not found.', 'not_found')
  if (!res.ok) {
    // Google answers 400 for a key that is not valid (API_KEY_INVALID): the body is read only to tell that apart,
    // never passed on; the status helps the operator.
    const body = await res.text().catch(() => '')
    console.warn(`places: HTTP ${res.status}`)
    if (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(body))
      throw new PlacesError(KEY_REFUSED, 'auth')
    throw new PlacesError(SEARCH_FAILED, 'unknown')
  }
  return res.json().catch(() => {
    throw new PlacesError(SEARCH_FAILED, 'unknown')
  })
}

/** Text Search (New): up to five listings for "Business name, city", US first, in English. */
export async function searchPlaces(
  apiKey: string,
  query: string,
  doFetch: Fetch = fetch,
): Promise<BusinessCandidate[]> {
  const body = (await placesRequest(doFetch, apiKey, `${BASE}/places:searchText`, SEARCH_FIELD_MASK, {
    textQuery: query,
    pageSize: BUSINESS_SEARCH_RESULTS,
    languageCode: 'en',
    regionCode: 'us',
  })) as { places?: PlaceDetails[] } | null
  return (body?.places ?? [])
    .flatMap(p =>
      p.id && p.displayName?.text
        ? [{ placeId: p.id, name: p.displayName.text, address: p.formattedAddress ?? '' }]
        : [],
    )
    .slice(0, BUSINESS_SEARCH_RESULTS)
}

/** Place Details (New) for one listing. The ID was checked by the action's input (letters, digits, - and _). */
export async function placeDetails(apiKey: string, placeId: string, doFetch: Fetch = fetch): Promise<PlaceDetails> {
  const url = `${BASE}/places/${encodeURIComponent(placeId)}?languageCode=en&regionCode=us`
  return ((await placesRequest(doFetch, apiKey, url, DETAILS_FIELD_MASK)) ?? {}) as PlaceDetails
}

/** "Portland, OR" from the address components (city and state), or null. */
export function placeArea(details: PlaceDetails): string | null {
  const part = (type: string, short = false) => {
    const c = details.addressComponents?.find(a => a.types?.includes(type))
    return (short ? c?.shortText : c?.longText) ?? null
  }
  const city = part('locality') ?? part('postal_town') ?? part('sublocality')
  const state = part('administrative_area_level_1', true)
  return [city, state].filter(Boolean).join(', ') || null
}

// --- Opening hours ---------------------------------------------------------------------------

const DAY = 24 * 60
const WEEK = 7 * DAY
const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
/** At most what businessHours.set takes. */
export const MAX_SPANS = 21

/**
 * Google's opening periods as weekly hours (weekday 0 = Sunday, like Google and availability_rules). A period that
 * runs past midnight is split at it ("Fri 6 PM – Sat 2 AM" → Fri 18:00–24:00 and Sat 00:00–02:00); a period without
 * a close is open around the clock. null when there are no periods or more spans than the hours can hold.
 */
export function placesHoursToSpans(periods: readonly PlacesPeriod[] | undefined): BusinessHoursSpan[] | null {
  if (!periods?.length) return null
  const at = (p: PlacesPoint) => (p.day ?? 0) * DAY + (p.hour ?? 0) * 60 + (p.minute ?? 0)
  const pieces: BusinessHoursSpan[] = []
  for (const period of periods) {
    if (!period.open) continue
    if (!period.close) {
      // Open 24 hours: Google sends one period opening Sunday 00:00 with no close.
      return [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: '00:00', end: '24:00' }))
    }
    const start = at(period.open)
    let end = at(period.close)
    if (end <= start) end += WEEK
    for (let from = start; from < end; ) {
      const dayStart = Math.floor(from / DAY) * DAY
      const to = Math.min(end, dayStart + DAY)
      pieces.push({
        weekday: (dayStart / DAY) % 7,
        start: clock(from - dayStart),
        end: to - dayStart === DAY ? '24:00' : clock(to - dayStart),
      })
      from = to
    }
  }
  // Back to back on one day (a period ending at midnight, the next starting there) is one span.
  pieces.sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start))
  const spans: BusinessHoursSpan[] = []
  for (const piece of pieces) {
    const last = spans[spans.length - 1]
    if (last && last.weekday === piece.weekday && last.end >= piece.start) {
      if (piece.end > last.end) last.end = piece.end
    } else spans.push({ ...piece })
  }
  return spans.length && spans.length <= MAX_SPANS ? spans : null
}
