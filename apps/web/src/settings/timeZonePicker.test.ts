import { expect, test } from 'vitest'
import { clockIn, gmtOffset, searchTimeZones, timeZoneOptions, timeZoneSearchExample } from './timeZones.ts'

const at = Date.parse('2026-11-12T21:31:00Z')

test('each zone shows its GMT offset and the time there now', () => {
  expect(gmtOffset('America/Los_Angeles', at)).toBe('GMT-8')
  expect(gmtOffset('Asia/Kolkata', at)).toBe('GMT+5:30')
  expect(clockIn('Europe/Berlin', at)).toBe('10:31 PM')
  expect(gmtOffset('Not/AZone', at)).toBe('')
})

test('search finds zones by city, zone name or offset, written as GMT or UTC', () => {
  const options = timeZoneOptions('America/Los_Angeles')
  const values = (query: string) => searchTimeZones(options, query, at).map(o => o.value)
  expect(values('berlin')).toContain('Europe/Berlin')
  expect(values('pacific')).toContain('America/Los_Angeles')
  expect(values('gmt+1')).toContain('Europe/Berlin')
  expect(values('UTC - 8')).toContain('America/Los_Angeles')
  expect(values('gmt-5')).toContain('America/New_York')
  expect(values('gmt+1')).not.toContain('America/Los_Angeles')
  // An offset is compared whole: GMT+10:30, +12 and +13 are not "gmt+1".
  expect(values('gmt+1')).not.toContain('Australia/Adelaide')
  expect(values('gmt+5:30')).toContain('Asia/Colombo')
  expect(values('')).toHaveLength(options.length)
})

test("the search example is the browser zone's offset, else GMT-5", () => {
  expect(timeZoneSearchExample('America/New_York', at)).toBe('GMT-5')
  expect(timeZoneSearchExample('America/Sao_Paulo', at)).toBe('GMT-3')
  expect(timeZoneSearchExample('Asia/Tokyo', at)).toBe('GMT+9')
  expect(timeZoneSearchExample('Asia/Kolkata', at)).toBe('GMT+5:30')
  // London in summer is GMT+1; in winter it is GMT itself, which as a search would match every zone.
  expect(timeZoneSearchExample('Europe/London', Date.parse('2026-07-01T12:00:00Z'))).toBe('GMT+1')
  expect(timeZoneSearchExample('Europe/London', at)).toBe('GMT-5')
  expect(timeZoneSearchExample('UTC', at)).toBe('GMT-5')
  expect(timeZoneSearchExample('Not/AZone', at)).toBe('GMT-5')
  expect(timeZoneSearchExample(null, at)).toBe('GMT-5')
  // The example finds the zone it came from.
  const options = timeZoneOptions('Asia/Tokyo')
  expect(searchTimeZones(options, timeZoneSearchExample('Asia/Tokyo', at), at).map(o => o.value)).toContain(
    'Asia/Tokyo',
  )
})
