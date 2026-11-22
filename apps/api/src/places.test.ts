import { describe, expect, test, vi } from 'vitest'
import {
  DETAILS_FIELD_MASK,
  PlacesError,
  placeArea,
  placeDetails,
  placesHoursToSpans,
  SEARCH_FIELD_MASK,
  searchPlaces,
} from './places.ts'

const KEY = 'places-key-made-up-0123'
const answer = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }))
const requestOf = (fetchMock: ReturnType<typeof answer>) => {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return { url, init, headers: new Headers(init.headers) }
}

describe('requests', () => {
  test('Text Search: POST with the key in a header, the smallest field mask, five results, US English', async () => {
    const fetchMock = answer(200, {
      places: [
        {
          id: 'ChIJbrightwater0001',
          displayName: { text: 'Brightwater Plumbing & Heating' },
          formattedAddress: '1 Main St, Portland, OR',
        },
        { id: 'ChIJnoname00000002', formattedAddress: 'somewhere' },
      ],
    })
    const results = await searchPlaces(KEY, 'Brightwater Plumbing, Portland', fetchMock)
    expect(results).toEqual([
      { placeId: 'ChIJbrightwater0001', name: 'Brightwater Plumbing & Heating', address: '1 Main St, Portland, OR' },
    ])
    const { url, init, headers } = requestOf(fetchMock)
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText')
    expect(init.method).toBe('POST')
    expect(headers.get('x-goog-api-key')).toBe(KEY)
    expect(headers.get('x-goog-fieldmask')).toBe(SEARCH_FIELD_MASK)
    expect(SEARCH_FIELD_MASK).toBe('places.id,places.displayName,places.formattedAddress')
    expect(JSON.parse(init.body as string)).toEqual({
      textQuery: 'Brightwater Plumbing, Portland',
      pageSize: 5,
      languageCode: 'en',
      regionCode: 'us',
    })
    expect(url).not.toContain(KEY)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test("Place Details and Text Search ask in the workspace's language", async () => {
    const details = answer(200, { id: 'ChIJbrightwater0001' })
    await placeDetails(KEY, 'ChIJbrightwater0001', details, 'de')
    expect(requestOf(details).url).toBe(
      'https://places.googleapis.com/v1/places/ChIJbrightwater0001?languageCode=de&regionCode=us',
    )
    const search = answer(200, { places: [] })
    await searchPlaces(KEY, 'Brightwater Plumbing, Portland', search, 'de')
    expect(JSON.parse(requestOf(search).init.body as string).languageCode).toBe('de')
  })

  test('Place Details: GET of the listing with the details field mask', async () => {
    const fetchMock = answer(200, { id: 'ChIJbrightwater0001', displayName: { text: 'Brightwater' } })
    expect((await placeDetails(KEY, 'ChIJbrightwater0001', fetchMock)).displayName?.text).toBe('Brightwater')
    const { url, init, headers } = requestOf(fetchMock)
    expect(url).toBe('https://places.googleapis.com/v1/places/ChIJbrightwater0001?languageCode=en&regionCode=us')
    expect(init.method).toBe('GET')
    expect(headers.get('x-goog-fieldmask')).toBe(DETAILS_FIELD_MASK)
    for (const field of ['regularOpeningHours', 'internationalPhoneNumber', 'websiteUri', 'primaryType', 'timeZone'])
      expect(DETAILS_FIELD_MASK.split(',')).toContain(field)
    // Nothing billed beyond what the proposal uses.
    for (const field of ['reviews', 'photos', 'rating', 'editorialSummary', '*'])
      expect(DETAILS_FIELD_MASK.split(',')).not.toContain(field)
  })

  test("errors are our own sentences, never Google's text", async () => {
    const refused = answer(403, { error: { message: `API key ${KEY} not valid` } })
    const error = await searchPlaces(KEY, 'x y', refused).catch(e => e)
    expect(error).toBeInstanceOf(PlacesError)
    expect(error.message).not.toContain(KEY)
    expect(error.reason).toBe('auth')
    const invalid = answer(400, { error: { message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } })
    expect(await searchPlaces(KEY, 'x y', invalid).catch(e => e.reason)).toBe('auth')
    const badField = answer(400, { error: { message: 'Bad field' } })
    expect(await searchPlaces(KEY, 'x y', badField).catch(e => e.reason)).toBe('unknown')
    await expect(searchPlaces(KEY, 'x y', answer(429))).rejects.toThrow(/Too many searches/)
    await expect(placeDetails(KEY, 'ChIJbrightwater0001', answer(404))).rejects.toThrow(/not found/)
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(searchPlaces(KEY, 'x y', down)).rejects.toThrow(/could not be reached/)
  })
})

describe('opening hours', () => {
  const at = (day: number, hour: number, minute = 0) => ({ day, hour, minute })

  test('weekday periods become spans, Sunday is 0 like availability_rules', () => {
    const periods = [1, 2, 3, 4, 5].map(day => ({ open: at(day, 7), close: at(day, 18, 30) }))
    expect(placesHoursToSpans(periods)).toEqual(
      [1, 2, 3, 4, 5].map(weekday => ({ weekday, start: '07:00', end: '18:30' })),
    )
  })

  test('past midnight is split at it, also from Saturday into Sunday; a lunch break is two spans', () => {
    expect(
      placesHoursToSpans([
        { open: at(5, 18), close: at(6, 2) },
        { open: at(6, 22), close: at(0, 1) },
        { open: at(2, 9), close: at(2, 12) },
        { open: at(2, 13), close: at(2, 17) },
      ]),
    ).toEqual([
      { weekday: 0, start: '00:00', end: '01:00' },
      { weekday: 2, start: '09:00', end: '12:00' },
      { weekday: 2, start: '13:00', end: '17:00' },
      { weekday: 5, start: '18:00', end: '24:00' },
      { weekday: 6, start: '00:00', end: '02:00' },
      { weekday: 6, start: '22:00', end: '24:00' },
    ])
  })

  test('open around the clock (no close), touching periods merged, nothing usable gives null', () => {
    expect(placesHoursToSpans([{ open: at(0, 0) }])).toHaveLength(7)
    expect(placesHoursToSpans([{ open: at(0, 0) }])![3]).toEqual({ weekday: 3, start: '00:00', end: '24:00' })
    expect(
      placesHoursToSpans([
        { open: at(1, 0), close: at(2, 0) },
        { open: at(2, 0), close: at(2, 6) },
      ]),
    ).toEqual([
      { weekday: 1, start: '00:00', end: '24:00' },
      { weekday: 2, start: '00:00', end: '06:00' },
    ])
    expect(placesHoursToSpans(undefined)).toBeNull()
    expect(placesHoursToSpans([])).toBeNull()
    // More spans than the hours can hold: left to the owner.
    const many = Array.from({ length: 22 }, (_, i) => ({
      open: at(i % 7, 1 + Math.floor(i / 7) * 3),
      close: at(i % 7, 2 + Math.floor(i / 7) * 3),
    }))
    expect(placesHoursToSpans(many)).toBeNull()
  })
})

test('area: city and state from the address components', () => {
  expect(
    placeArea({
      addressComponents: [
        { longText: 'Portland', types: ['locality', 'political'] },
        { longText: 'Oregon', shortText: 'OR', types: ['administrative_area_level_1'] },
      ],
    }),
  ).toBe('Portland, OR')
  expect(placeArea({})).toBeNull()
})
