// The areas a number can be requested in (docs/numbers-kyc.md, "Area codes"): in Germany every Ortsnetz of the
// Bundesnetzagentur's list, found by its name, its area code or a municipality in it (de-areas.data.ts, made by
// apps/api/scripts/de-areas.ts); in the UK and Ireland the listed cities (NUMBER_COUNTRIES). An address suggests its
// area: the municipality of its city or postcode and the Ortsnetz that municipality's centre lies in. A suggestion
// only: a municipality can span several Ortsnetze, and any area can be requested. With the install's carrier blocks
// rule on (number-blocks.ts), a German area is available only where the carrier holds number blocks of its own.
import { type KycCountry, NUMBER_COUNTRIES, type NumberArea, type NumberCity } from '@linedesk/actions'
import { DE_CARRIER_BLOCKS, DE_GEMEINDEN, DE_ORTSNETZE } from './de-areas.data.ts'

/**
 * Which areas a number can be requested in: `blocks` is the number blocks of the carrier (by area code, the first
 * digits of each block's numbers) when only those are offered, else null (every area).
 */
export type AreaRule = { blocks: ReadonlyMap<string, readonly string[]> | null }
export const EVERY_AREA: AreaRule = { blocks: null }

/** The German number blocks of a carrier, by its BNetzA porting ID (D451: Telnyx Ireland Ltd), by area code. */
export function carrierBlocks(portingId: string): ReadonlyMap<string, readonly string[]> {
  const blocks = new Map<string, string[]>()
  for (const line of DE_CARRIER_BLOCKS.split('\n')) {
    const [carrier, prefix, digits] = line.split('\t') as [string, string, string]
    if (carrier !== portingId) continue
    blocks.set(prefix, [...(blocks.get(prefix) ?? []), digits])
  }
  return blocks
}

/** Whether a number can be requested in the area of `prefix` under the rule (the carrier holds blocks there). */
export const areaAvailable = (rule: AreaRule, prefix: string) => !rule.blocks || rule.blocks.has(prefix)

/**
 * Whether a German number (E.164) lies in one of the rule's blocks of the area `prefix`: its digits after +49 and the
 * area code start with a block's. Every number does when the rule has no blocks.
 */
export function inCarrierBlock(rule: AreaRule, prefix: string, e164: string): boolean {
  if (!rule.blocks) return true
  const national = `+49${prefix}`
  if (!e164.startsWith(national)) return false
  const subscriber = e164.slice(national.length)
  return (rule.blocks.get(prefix) ?? []).some(digits => subscriber.startsWith(digits))
}

/** Lower case, without accents, ß as ss, every run of other characters one space ("Neustadt a.d.Aisch" → "neustadt a d aisch"). */
export const plainName = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

type Place = { name: string; plain: string; postalCode: string; prefix: string }
type Catalog = {
  /** By area code (without the trunk 0). */
  areas: Map<string, { name: string; plain: string; city?: string }>
  places: Place[]
  popular: string[]
}

const catalogs = new Map<KycCountry, Catalog>()

/** A country's areas, read once. */
function catalog(country: KycCountry): Catalog {
  const found = catalogs.get(country)
  if (found) return found
  const config = NUMBER_COUNTRIES[country]
  const cityOf = new Map(config.cities.map(c => [c.prefix, c]))
  const areas = new Map<string, { name: string; plain: string; city?: string }>()
  const places: Place[] = []
  if (country === 'DE') {
    for (const line of DE_ORTSNETZE.split('\n')) {
      const [prefix, name] = line.split('\t') as [string, string]
      areas.set(prefix, {
        name,
        plain: plainName(name),
        ...(cityOf.has(prefix) ? { city: cityOf.get(prefix)!.id } : {}),
      })
    }
    for (const line of DE_GEMEINDEN.split('\n')) {
      const [name, postalCode, prefix] = line.split('\t') as [string, string, string]
      places.push({ name, plain: plainName(name), postalCode, prefix })
    }
  } else
    for (const city of config.cities)
      areas.set(city.prefix, { name: titleCase(city.names[0]!), plain: '', city: city.id })
  for (const area of areas.values()) area.plain ||= plainName(area.name)
  const made = { areas, places, popular: config.cities.map(c => c.prefix) }
  catalogs.set(country, made)
  return made
}

const titleCase = (text: string) => text.replace(/(^|[\s-])\p{L}/gu, s => s.toUpperCase())

function areaFor(cat: Catalog, prefix: string, rule: AreaRule, place?: string): NumberArea | undefined {
  const area = cat.areas.get(prefix)
  if (!area) return undefined
  return {
    prefix,
    name: area.name,
    ...(place && plainName(place) !== area.plain ? { place } : {}),
    ...(area.city ? { city: area.city } : {}),
    popular: cat.popular.includes(prefix),
    available: areaAvailable(rule, prefix),
  }
}

/** The area of an area code (a leading 0 or the country's calling code ignored), or undefined if the country has none. */
export function numberArea(country: KycCountry, prefix: string, rule: AreaRule = EVERY_AREA): NumberArea | undefined {
  return areaFor(catalog(country), barePrefix(country, prefix), rule)
}

/** "06221", "+49 6221", "0049 6221" → "6221". */
function barePrefix(country: KycCountry, text: string): string {
  const digits = text.replace(/[\s/()-]/g, '')
  const code = NUMBER_COUNTRIES[country].callingCode
  return digits.replace(new RegExp(`^(\\+|00)${code}`), '').replace(/^0+/, '')
}

/**
 * The areas a query finds, best first: an area code finds the areas it starts; a name finds the areas and the
 * municipalities (with their area) whose name is it, starts with it, has a word starting with it, or contains it, in
 * that order, available areas first among equals, then popular ones. Empty: the popular areas; under a rule with
 * blocks, the available areas (popular ones first). An unavailable area is still found (by its place or postcode), so
 * the business is told calmly that there is no local number there yet.
 */
export function searchNumberAreas(
  country: KycCountry,
  query: string,
  limit = 20,
  rule: AreaRule = EVERY_AREA,
): NumberArea[] {
  const cat = catalog(country)
  const text = query.trim()
  const available = (prefix: string) => areaAvailable(rule, prefix)
  if (!text) {
    const prefixes = rule.blocks
      ? [
          ...cat.popular.filter(available),
          ...[...cat.areas.keys()]
            .filter(prefix => available(prefix) && !cat.popular.includes(prefix))
            .sort((a, b) => cat.areas.get(a)!.name.localeCompare(cat.areas.get(b)!.name, 'de')),
        ]
      : cat.popular
    return prefixes.slice(0, limit).map(prefix => areaFor(cat, prefix, rule)!)
  }
  if (/^[+\d][\d\s/()-]*$/.test(text)) {
    const digits = barePrefix(country, text)
    if (!digits) return []
    return [...cat.areas.keys()]
      .filter(prefix => prefix.startsWith(digits))
      .sort((a, b) => a.length - b.length || Number(available(b)) - Number(available(a)) || a.localeCompare(b))
      .slice(0, limit)
      .map(prefix => areaFor(cat, prefix, rule)!)
  }
  const wanted = plainName(text)
  if (!wanted) return []
  const score = (plain: string) =>
    plain === wanted
      ? 0
      : plain.startsWith(wanted)
        ? 1
        : ` ${plain}`.includes(` ${wanted}`)
          ? 2
          : plain.includes(wanted)
            ? 3
            : -1
  const best = new Map<string, { score: number; place?: string }>()
  const consider = (prefix: string, s: number, place?: string) => {
    if (s < 0) return
    const before = best.get(prefix)
    if (!before || s < before.score) best.set(prefix, { score: s, ...(place ? { place } : {}) })
  }
  for (const [prefix, area] of cat.areas) consider(prefix, score(area.plain))
  for (const place of cat.places) consider(place.prefix, score(place.plain), place.name)
  return [...best.entries()]
    .sort(
      ([a, x], [b, y]) =>
        x.score - y.score ||
        Number(available(b)) - Number(available(a)) ||
        Number(cat.popular.includes(b)) - Number(cat.popular.includes(a)) ||
        cat.areas.get(a)!.name.localeCompare(cat.areas.get(b)!.name, 'de'),
    )
    .slice(0, limit)
    .map(([prefix, found]) => areaFor(cat, prefix, rule, found.place)!)
}

/**
 * The areas an address suggests, best first: the municipality that matches both city and postcode, then those that
 * match the city, then the postcode, then an area named like the city. Empty when it names no known place. Marked
 * `available: false` (never left out) where the rule offers no number: the business is told so.
 */
export function suggestNumberAreas(
  country: KycCountry,
  address: { city?: string | undefined; postal_code?: string | undefined },
  rule: AreaRule = EVERY_AREA,
): NumberArea[] {
  const cat = catalog(country)
  const city = plainName(address.city ?? '')
  const postalCode = (address.postal_code ?? '').replace(/\s/g, '').toUpperCase()
  const out: NumberArea[] = []
  const add = (prefix: string, place?: string) => {
    if (out.some(a => a.prefix === prefix)) return
    const area = areaFor(cat, prefix, rule, place)
    if (area) out.push(area)
  }
  // "Heidelberg-Handschuhsheim", "Frankfurt am Main Sachsenhausen": the city as written, or its first part.
  const cityMatches = (plain: string) => !!city && (plain === city || city.startsWith(`${plain} `))
  const byCity = cat.places.filter(p => cityMatches(p.plain))
  const byPostal = postalCode ? cat.places.filter(p => p.postalCode === postalCode) : []
  for (const place of byCity) if (byPostal.includes(place)) add(place.prefix, place.name)
  for (const place of byCity) add(place.prefix, place.name)
  for (const place of byPostal) add(place.prefix, place.name)
  for (const [prefix, area] of cat.areas) if (cityMatches(area.plain)) add(prefix)
  if (country !== 'DE') for (const c of NUMBER_COUNTRIES[country].cities) if (cityMatchesNames(c, city)) add(c.prefix)
  return out
}

const cityMatchesNames = (c: NumberCity, city: string) =>
  !!city && c.names.some(name => plainName(name) === city || city.startsWith(`${plainName(name)} `))

/**
 * Whether an address looks like it is in the area of `prefix`: one of its suggested areas, or (a place not in the data)
 * an area named like its city. Only told to the business (`addressOutsideArea`); the carrier decides.
 */
export function addressInNumberArea(
  country: KycCountry,
  prefix: string,
  address: { city?: string | undefined; postal_code?: string | undefined },
): boolean {
  return suggestNumberAreas(country, address).some(a => a.prefix === barePrefix(country, prefix))
}
