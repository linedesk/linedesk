import { expect, test } from 'vitest'
import { timeZoneLabel, timeZoneOptions } from './timeZones.ts'

test('a zone reads as its city and the name people use for it', () => {
  expect(timeZoneLabel('America/Los_Angeles')).toBe('Los Angeles · Pacific Time')
  expect(timeZoneLabel('America/New_York')).toBe('New York · Eastern Time')
})

test('US zones come first, and the current zone is always offered', () => {
  const options = timeZoneOptions('America/Chicago')
  expect(options.slice(0, 3).map(o => o.value)).toEqual(['America/New_York', 'America/Chicago', 'America/Denver'])
  expect(options.some(o => o.value === 'Europe/Berlin')).toBe(true)
  expect(timeZoneOptions('Etc/Unknown_Zone')[0]?.value).toBe('Etc/Unknown_Zone')
})
