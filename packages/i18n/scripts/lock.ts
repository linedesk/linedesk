/**
 * `pnpm i18n:lock` keeps i18n.lock.json in step with the catalogs (docs/translations.md):
 *
 * - no arguments: a target string without a lock entry (a contribution that added it) is recorded as a person's;
 *   entries of keys that no longer exist are dropped.
 * - `--by ai|human [--locale <locale>] [--prefix <key-prefix>]`: record the current text of the matching strings as
 *   written by the AI or by a person (for example after the release translation pass). `--by ai` keeps a person's
 *   entry whose text did not change: a string locked `--by human` is never recorded as the AI's.
 * - `--mark-human <locale> <key-prefix>`: a maintainer marks reviewed strings as checked without changing them; the
 *   translate script then never overwrites them unless their English changes.
 */
import { NAMESPACES, targetsOf } from '../locales.ts'
import {
  hash,
  isMain,
  type Lock,
  type LockEntry,
  lockEntry,
  readEnglish,
  readLocale,
  readLock,
  writeLock,
} from './lib.ts'

export interface LockOptions {
  by?: LockEntry['by']
  locale?: string
  prefix?: string
}

/** The new lock for the given catalogs. Pure: the tests pass catalogs in. */
export function updateLock(
  lock: Lock,
  en: Record<string, string>,
  targets: Record<string, Record<string, string>>,
  options: LockOptions,
): Lock {
  const next: Lock = {}
  for (const [locale, messages] of Object.entries(targets)) {
    const entries: Record<string, LockEntry> = {}
    for (const [key, text] of Object.entries(messages)) {
      const english = en[key]
      if (english === undefined) continue
      const matches =
        (!options.locale || options.locale === locale) && (!options.prefix || key.startsWith(options.prefix))
      const old = lock[locale]?.[key]
      // `--by ai` never takes over a person's text: unchanged since they wrote it, it stays theirs.
      if (options.by === 'ai' && old?.by === 'human' && old.out === hash(text)) entries[key] = old
      else if (options.by && matches) entries[key] = lockEntry(english, text, options.by)
      else if (old) entries[key] = old
      else entries[key] = lockEntry(english, text, 'human')
    }
    next[locale] = entries
  }
  return next
}

function main() {
  const argv = process.argv.slice(2)
  const value = (flag: string) => {
    const at = argv.indexOf(flag)
    return at >= 0 ? argv[at + 1] : undefined
  }
  let options: LockOptions = {}
  const markAt = argv.indexOf('--mark-human')
  if (markAt >= 0) {
    const locale = argv[markAt + 1]
    const prefix = argv[markAt + 2]
    if (!locale || !prefix) {
      console.error('Usage: pnpm i18n:lock --mark-human <locale> <key-prefix>')
      process.exit(1)
    }
    options = { by: 'human', locale, prefix }
  } else {
    const by = value('--by')
    if (by && by !== 'ai' && by !== 'human') {
      console.error('--by takes ai or human')
      process.exit(1)
    }
    options = { by: by as LockEntry['by'] | undefined, locale: value('--locale'), prefix: value('--prefix') }
  }
  const locales = [...new Set(NAMESPACES.flatMap(ns => targetsOf(ns)))]
  const targets = Object.fromEntries(locales.map(locale => [locale, readLocale(locale)]))
  const lock = updateLock(readLock(), readEnglish(), targets, options)
  writeLock(lock)
  const counts = locales.map(locale => `${locale} ${Object.keys(lock[locale] ?? {}).length}`).join(', ')
  console.log(`i18n.lock.json: ${counts}`)
}

if (isMain(import.meta.url)) main()
