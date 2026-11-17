import { expect, test } from 'vitest'
import { BUYABLE_AREA_CODES, distanceKm, NEARBY_KM, NEARBY_LIMIT, nearbyAreaCodes, PLACES, placeOf } from './index.ts'

const codes = (code: string, limit?: number) => nearbyAreaCodes(code, limit).map(a => a.code)

/** Rough bounds of each state, province and territory ([south, north, west, east]), to catch a mistyped place. */
const BOUNDS: Record<string, readonly [number, number, number, number]> = {
  AB: [49, 60, -120, -110],
  AK: [51, 72, -180, -129],
  AL: [30, 35.1, -88.5, -84.9],
  AR: [33, 36.5, -94.7, -89.6],
  AZ: [31.3, 37, -114.9, -109],
  BC: [48.2, 60, -139, -114],
  CA: [32.5, 42, -124.5, -114.1],
  CO: [37, 41, -109.1, -102],
  CT: [40.9, 42.1, -73.8, -71.8],
  DC: [38.8, 39, -77.2, -76.9],
  DE: [38.4, 39.9, -75.8, -75],
  FL: [24.5, 31, -87.7, -80],
  GA: [30.3, 35, -85.7, -80.8],
  HI: [18.9, 22.3, -160.3, -154.8],
  IA: [40.3, 43.6, -96.7, -90.1],
  ID: [42, 49, -117.3, -111],
  IL: [36.9, 42.6, -91.6, -87.4],
  IN: [37.7, 41.8, -88.1, -84.7],
  KS: [37, 40, -102.1, -94.5],
  KY: [36.4, 39.2, -89.6, -81.9],
  LA: [28.9, 33.1, -94.1, -88.8],
  MA: [41.2, 42.9, -73.6, -69.9],
  MB: [49, 60, -102, -88.9],
  MD: [37.9, 39.8, -79.5, -75],
  ME: [43, 47.5, -71.1, -66.9],
  MI: [41.7, 48.3, -90.5, -82.1],
  MN: [43.5, 49.4, -97.3, -89.5],
  MO: [36, 40.7, -95.8, -89.1],
  MS: [30.1, 35, -91.7, -88.1],
  MT: [44.3, 49, -116.1, -104],
  NB: [44.5, 48.1, -69.1, -63.7],
  NC: [33.8, 36.6, -84.4, -75.4],
  ND: [45.9, 49, -104.1, -96.5],
  NE: [40, 43, -104.1, -95.3],
  NH: [42.7, 45.3, -72.6, -70.6],
  NJ: [38.9, 41.4, -75.6, -73.9],
  NL: [46.6, 60.4, -67.8, -52.6],
  NM: [31.3, 37, -109.1, -103],
  NS: [43.4, 47.1, -66.4, -59.7],
  NV: [35, 42, -120, -114],
  NY: [40.5, 45.1, -79.8, -71.8],
  OH: [38.4, 42, -84.9, -80.5],
  OK: [33.6, 37, -103, -94.4],
  ON: [41.6, 56.9, -95.2, -74.3],
  OR: [42, 46.3, -124.6, -116.5],
  PA: [39.7, 42.3, -80.6, -74.7],
  PR: [17.9, 18.6, -67.3, -65.2],
  QC: [45, 62.6, -79.8, -57.1],
  RI: [41.1, 42.1, -71.9, -71.1],
  SC: [32, 35.3, -83.4, -78.5],
  SD: [42.5, 45.95, -104.1, -96.4],
  SK: [49, 60, -110, -101.4],
  TN: [35, 36.7, -90.3, -81.6],
  TX: [25.8, 36.5, -106.7, -93.5],
  UT: [37, 42, -114.1, -109],
  VA: [36.5, 39.5, -83.7, -75.2],
  VT: [42.7, 45.1, -73.5, -71.4],
  WA: [45.5, 49, -124.8, -116.9],
  WI: [42.5, 47.1, -92.9, -86.8],
  WV: [37.2, 40.7, -82.7, -77.7],
  WY: [41, 45, -111.1, -104],
  YT: [60, 69.7, -141, -123.8],
}

test('every area code has its main city in PLACES, and every place lies in its own state or province', () => {
  for (const a of BUYABLE_AREA_CODES) expect(PLACES[placeOf(a)], a.code).toBeDefined()
  const used = new Set(BUYABLE_AREA_CODES.map(placeOf))
  for (const [place, [lat, lon]] of Object.entries(PLACES)) {
    expect(used.has(place), `${place} is no area code's city`).toBe(true)
    const [south, north, west, east] = BOUNDS[place.slice(-2)]!
    expect(lat >= south && lat <= north && lon >= west && lon <= east, place).toBe(true)
  }
})

test('distances are great-circle kilometres', () => {
  expect(distanceKm(PLACES['Toronto, ON']!, PLACES['Toronto, ON']!)).toBe(0)
  // Toronto–Hamilton about 60 km, New York–Los Angeles about 3,940 km.
  expect(Math.round(distanceKm(PLACES['Toronto, ON']!, PLACES['Hamilton, ON']!) / 10)).toBe(6)
  expect(Math.round(distanceKm(PLACES['New York, NY']!, PLACES['Los Angeles, CA']!) / 100)).toBe(39)
})

test("Toronto's 416: the overlays 437, 647 and 942 first, then the Hamilton and London codes around it", () => {
  const near = nearbyAreaCodes('416')
  expect(near.slice(0, 3)).toEqual([
    { code: '437', city: 'Toronto', state: 'ON', country: 'CA', sameArea: true },
    { code: '647', city: 'Toronto', state: 'ON', country: 'CA', sameArea: true },
    { code: '942', city: 'Toronto', state: 'ON', country: 'CA', sameArea: true },
  ])
  expect(codes('416')).toEqual(['437', '647', '942', '289', '365', '742', '905', '226'])
  expect(near.slice(3).every(a => !a.sameArea)).toBe(true)
  // From an overlay the other way round: 416 is one of the same area.
  expect(codes('647').slice(0, 3)).toEqual(['416', '437', '942'])
})

test("New York's 212: 332, 646 and 917 first, then Jersey City's and Brooklyn's codes next door", () => {
  expect(codes('212')).toEqual(['332', '646', '917', '201', '551', '347', '465', '718'])
  expect(codes('503')).toEqual(expect.arrayContaining(['971', '360']))
  expect(codes('503')[0]).toBe('971')
})

test('only codes of the same country, at most NEARBY_LIMIT and within NEARBY_KM', () => {
  // Seattle is close to Vancouver, BC, but a US workspace buys only US numbers.
  expect(codes('206', 50)).not.toContain('604')
  expect(codes('604', 50)).not.toContain('206')
  for (const a of BUYABLE_AREA_CODES) {
    const near = nearbyAreaCodes(a.code)
    expect(near.length, a.code).toBeLessThanOrEqual(NEARBY_LIMIT)
    expect(
      near.map(n => n.code),
      a.code,
    ).not.toContain(a.code)
    for (const n of near) {
      expect(n.country, a.code).toBe(a.country)
      if (!n.sameArea)
        expect(distanceKm(PLACES[placeOf(a)]!, PLACES[placeOf(n)]!), a.code).toBeLessThanOrEqual(NEARBY_KM)
    }
  }
  expect(codes('416', 2)).toEqual(['437', '647'])
})

test('a place far from others has only its overlays; an unknown code has none', () => {
  expect(codes('787')).toEqual(['939'])
  expect(codes('907')).toEqual([])
  expect(codes('808')).toEqual([])
  expect(codes('555')).toEqual([])
})
