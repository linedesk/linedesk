import { expect, test } from 'vitest'
import { clockIn, gmtOffset, searchTimeZones, timeZoneOptions } from './timeZones.ts'

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
  expect(values('gmt+1')).not.toContain('America/Los_Angeles')
  // An offset is compared whole: GMT+10:30, +12 and +13 are not "gmt+1".
  expect(values('gmt+1')).not.toContain('Australia/Adelaide')
  expect(values('gmt+5:30')).toContain('Asia/Colombo')
  expect(values('')).toHaveLength(options.length)
})
