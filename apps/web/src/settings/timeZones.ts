// Time zones without React: the zone this browser is in, and the choices for the time zone field.
import type { SelectOption } from '../ui/controls.tsx'

/** The US zones first, in the order people read them; every other zone follows by name. */
const US_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
]

/** The IANA zone the browser is in, or null when it does not say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

/** "Pacific Time" for America/Los_Angeles; null when Intl has no name for the zone. */
function genericName(zone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts()
    return parts.find(p => p.type === 'timeZoneName')?.value ?? null
  } catch {
    return null
  }
}

/** America/Los_Angeles → "Los Angeles · Pacific Time". */
export function timeZoneLabel(zone: string): string {
  const city = (zone.split('/').pop() ?? zone).replaceAll('_', ' ')
  const name = genericName(zone)
  return name && name !== city ? `${city} · ${name}` : city
}

function allZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return US_ZONES
  }
}

const toOption = (value: string): SelectOption<string> => ({ value, label: timeZoneLabel(value) })

// Naming ~400 zones takes a moment, so it happens once, the first time the field shows.
let known: SelectOption<string>[] | null = null

/** The zones to pick from: US first, then the rest by name; `current` is always among them. */
export function timeZoneOptions(current: string): SelectOption<string>[] {
  known ??= [
    ...US_ZONES.map(toOption),
    ...allZones()
      .filter(z => !US_ZONES.includes(z))
      .map(toOption)
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]
  return !current || known.some(o => o.value === current) ? known : [toOption(current), ...known]
}
