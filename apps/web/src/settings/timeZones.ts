// Time zones without React: the zone this browser is in, and the choices for the time zone field.
import { intlLocale } from '../i18n/format.ts'
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

/** "Pacific Time" for America/Los_Angeles, in the active language; null when Intl has no name for the zone. */
function genericName(zone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat(intlLocale(), { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts()
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

// Naming ~400 zones takes a moment, so it happens once per language, the first time the field shows.
let known: SelectOption<string>[] | null = null
let knownLocale = ''

/** The zones to pick from: US first, then the rest by name; `current` is always among them. */
export function timeZoneOptions(current: string): SelectOption<string>[] {
  if (knownLocale !== intlLocale()) {
    known = null
    knownLocale = intlLocale()
  }
  known ??= [
    ...US_ZONES.map(toOption),
    ...allZones()
      .filter(z => !US_ZONES.includes(z))
      .map(toOption)
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]
  return !current || known.some(o => o.value === current) ? known : [toOption(current), ...known]
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>()
const clockFormats = new Map<string, Intl.DateTimeFormat>()
/** `locale`: the offsets stay in English ("GMT-8"), the zone search reads them; the clock follows the language. */
const formatIn = (
  cache: Map<string, Intl.DateTimeFormat>,
  zone: string,
  options: Intl.DateTimeFormatOptions,
  locale = 'en-US',
) => {
  const key = `${locale}|${zone}`
  let format = cache.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { timeZone: zone, ...options })
    cache.set(key, format)
  }
  return format
}

/** "GMT-8", "GMT+5:30", "GMT" for a zone at `now` (daylight saving included); '' when Intl does not know the zone. */
export function gmtOffset(zone: string, now: number): string {
  try {
    return (
      formatIn(offsetFormats, zone, { timeZoneName: 'shortOffset' })
        .formatToParts(now)
        .find(p => p.type === 'timeZoneName')?.value ?? ''
    )
  } catch {
    return ''
  }
}

/**
 * The offset the time zone search shows as its example: the browser's own zone's at `now` ("GMT+9" in Tokyo,
 * "GMT+5:30" in Kolkata), else GMT-5 (also for a zone at GMT itself, where "GMT" alone would match every zone).
 */
export function timeZoneSearchExample(zone: string | null | undefined, now: number): string {
  const offset = zone ? gmtOffset(zone, now) : ''
  return /^GMT[+-]\d/.test(offset) ? offset : 'GMT-5'
}

/** The time in a zone at `now`: "1:31 PM"; '' when Intl does not know the zone. */
export function clockIn(zone: string, now: number): string {
  try {
    return formatIn(clockFormats, zone, { hour: 'numeric', minute: '2-digit' }, intlLocale()).format(now)
  } catch {
    return ''
  }
}

/** What a search for a zone matches: city, region, zone name, id, and its offset as "GMT+1" and "UTC+1". */
function searchTextOf(option: SelectOption<string>, offset: string): string {
  const utc = offset.replace(/^GMT/, 'UTC')
  return `${option.label} ${option.value.replaceAll('_', ' ')} ${offset} ${utc}`.toLowerCase()
}

/** Typed offsets compare without spaces and with "-" for the minus sign: "gmt -8", "GMT−8" and "gmt-8" are one. */
const normalizeQuery = (text: string) =>
  text
    .toLowerCase()
    .replaceAll('−', '-')
    .replace(/\s*([+-])\s*/g, '$1')
    .trim()

/** A typed offset ("gmt+1", "utc-5:30"), compared whole: "gmt+1" is not GMT+10 or GMT+12. */
const OFFSET_WORD = /^(?:gmt|utc)[+-]\d{1,2}(?::\d{2})?$/

/** The zones whose search text has every word of `query` (an offset word: the zone's offset exactly), in list order. */
export function searchTimeZones(
  options: readonly SelectOption<string>[],
  query: string,
  now: number,
): SelectOption<string>[] {
  const words = normalizeQuery(query).split(/\s+/).filter(Boolean)
  if (!words.length) return [...options]
  return options.filter(o => {
    const offset = gmtOffset(o.value, now)
    const text = searchTextOf(o, offset)
    return words.every(w =>
      OFFSET_WORD.test(w) ? w.replace(/^utc/, 'gmt') === offset.toLowerCase() : text.includes(w),
    )
  })
}
