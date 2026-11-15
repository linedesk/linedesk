import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// Dates, numbers, language, region and time zone names follow the app's language, never the browser's
// (docs/translations.md, "Formatting"): an Intl object or toLocale…String() without a locale formats in the
// browser's language ("1. Nov. 2026" under an English UI on a German Mac). Use fmt()/useFormat() or intlLocale().
const src = fileURLToPath(new URL('..', import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : []
  })
}

const INTL =
  /\bIntl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|DisplayNames|PluralRules|Collator|Segmenter|DurationFormat)\(\s*(?:\)|undefined\b|\[\s*\])/g
const TO_LOCALE = /\.toLocale(?:Date|Time)?String\(\s*(?:\)|undefined\b)/g
/** Not formatting: the browser's own time zone, which a new workspace starts with. */
const ZONE_LOOKUP = /^\.resolvedOptions\(\)\.timeZone\b/

function browserLocaleUses(code: string): string[] {
  const found: string[] = []
  for (const match of code.matchAll(INTL)) {
    const rest = code.slice((match.index ?? 0) + match[0].length)
    if (match[0].endsWith(')') && ZONE_LOOKUP.test(rest)) continue
    found.push(match[0])
  }
  for (const match of code.matchAll(TO_LOCALE)) found.push(match[0])
  return found
}

test('finds formatting in the browser language, not the time zone lookup', () => {
  expect(browserLocaleUses('new Intl.DateTimeFormat(undefined, { month: "short" })')).toHaveLength(1)
  expect(browserLocaleUses('new Intl.DisplayNames([], { type: "language" })')).toHaveLength(1)
  expect(browserLocaleUses('Intl.NumberFormat().format(3)')).toHaveLength(1)
  expect(browserLocaleUses('date.toLocaleDateString()')).toHaveLength(1)
  expect(browserLocaleUses('n.toLocaleString(undefined, {})')).toHaveLength(1)
  expect(browserLocaleUses('Intl.DateTimeFormat().resolvedOptions().timeZone')).toEqual([])
  expect(browserLocaleUses('new Intl.DateTimeFormat(intlLocale(), { hour: "numeric" })')).toEqual([])
  expect(browserLocaleUses("date.toLocaleDateString('en-US', { weekday: 'long' })")).toEqual([])
})

test('the web app never formats in the browser language', () => {
  const offenders = files(src).flatMap(path =>
    browserLocaleUses(readFileSync(path, 'utf8')).map(use => `${path.slice(src.length)}: ${use}`),
  )
  expect(offenders).toEqual([])
})
