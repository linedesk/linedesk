/**
 * `pnpm i18n:changed [--since <git ref>]` (docs/translations.md, "The release translation pass"): the English keys
 * added or changed since the last release (the newest `v*` tag by version, or `--since`), each with the files that
 * render it and the languages where a person's translation must be kept. The list to work through before a release.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { NAMESPACES, SOURCE } from '../locales.ts'
import { type Catalog, isMain, type Lock, REPO_DIR, readEnglish, readLock } from './lib.ts'
import { KEY_ROOTS, type KeyScan, scanKeys, sourceFiles } from './scan.ts'

/** Keys new in `now` or with other English than in `before`, sorted. */
export function changedKeys(before: Catalog, now: Catalog): { key: string; status: 'new' | 'changed' }[] {
  return Object.keys(now)
    .filter(key => before[key] !== now[key])
    .sort()
    .map(key => ({ key, status: key in before ? 'changed' : 'new' }))
}

/** `file:line` of every place that names each key; a key built at runtime counts at its `i18n-dynamic` prefix's file. */
export function usages(keys: string[], scans: KeyScan[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(keys.map(key => [key, []]))
  for (const scan of scans) {
    for (const use of scan.used) out[use.key]?.push(`${use.file}:${use.line}`)
    for (const dynamic of scan.dynamic)
      for (const key of keys) if (key.startsWith(dynamic.prefix)) out[key]?.push(`${dynamic.file} (${dynamic.prefix}*)`)
  }
  return out
}

/** Languages whose translation of the key a person wrote (`--by human`): never overwrite, only review. */
export const humanLocales = (lock: Lock, key: string) =>
  Object.entries(lock)
    .filter(([, entries]) => entries[key]?.by === 'human')
    .map(([locale]) => locale)

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** The English catalogs at a git ref (a namespace the ref lacks is empty). */
function englishAt(ref: string): Catalog {
  const out: Catalog = {}
  for (const namespace of NAMESPACES) {
    let messages: Catalog = {}
    try {
      messages = JSON.parse(git('show', `${ref}:packages/i18n/locales/${SOURCE}/${namespace}.json`))
    } catch {}
    for (const [key, text] of Object.entries(messages)) out[`${namespace}.${key}`] = text
  }
  return out
}

function main() {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--since')
  // The newest release tag. Releases are merge commits on master-prod, so their tags are not in master-dev's history.
  const since = at >= 0 ? argv[at + 1] : git('tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0]
  if (!since) {
    console.error('Usage: pnpm i18n:changed [--since <git ref>]')
    process.exit(1)
  }
  const changed = changedKeys(englishAt(since), readEnglish())
  const scans = KEY_ROOTS.flatMap(root =>
    sourceFiles(root).map(file => scanKeys(file, readFileSync(`${REPO_DIR}${file}`, 'utf8'))),
  )
  const where = usages(
    changed.map(c => c.key),
    scans,
  )
  const lock = readLock()
  const en = readEnglish()
  console.log(`${changed.length} English keys new or changed since ${since}`)
  for (const { key, status } of changed) {
    const human = humanLocales(lock, key)
    console.log(`\n${key} (${status})\n  en: ${en[key]}`)
    for (const place of where[key] ?? []) console.log(`  used in ${place}`)
    if (human.length) console.log(`  written by a person in: ${human.join(', ')} (keep; review only)`)
  }
}

if (isMain(import.meta.url)) main()
