/**
 * `pnpm i18n:check [--complete] [--update-baseline] [--server-text]` (docs/translations.md, "Checks"). Runs in CI on every pull
 * request; `--complete` on release pull requests (job `release-translations` in ci.yml).
 *
 * - English: valid ICU, keys sorted, no duplicate keys, no empty strings.
 * - Code vs catalogs: every key the code uses exists, every English key is used (or under an `// i18n-dynamic` prefix).
 * - Other languages: no keys English lacks, the same arguments, tags and plural categories, a lock entry per key.
 * - `--complete`: every key translated and current (its English unchanged since), and `hardcoded-baseline.json`
 *   empty: a release ships no hardcoded English.
 * - Ratchet: no web app file (every `.ts` and `.tsx` under apps/web/src) has more hardcoded English than
 *   `hardcoded-baseline.json` says (empty: none has any).
 * - Formatting: no `Intl` formatter or `toLocale…String()` in the web app without the app's locale (an error), or with
 *   a locale written in the code (a warning).
 * - Emails and notifications: no hardcoded English in apps/api/src/emails (where every email and push notification is
 *   written) and none handed to a sender or set as an email's subject anywhere on the server (MESSAGE_ROOTS,
 *   findMessageText); no formatting there without the reader's locale.
 * - Server-side text: user-visible English in packages/actions and apps/api, counted and reported, not yet checked
 *   (`--server-text` lists it).
 */
import { readFileSync } from 'node:fs'
import { NAMESPACES, SOURCE, targetsOf } from '../locales.ts'
import {
  type Catalog,
  type Glossary,
  glossaryErrors,
  hash,
  isMain,
  type Lock,
  messageShape,
  namespaceFile,
  PACKAGE_DIR,
  REPO_DIR,
  readGlossary,
  readJson,
  readLock,
  readNamespace,
  structureErrors,
  writeJson,
} from './lib.ts'
import {
  type FormattingUse,
  findFormatting,
  type Hardcoded,
  hardcodedIn,
  ignoreComments,
  KEY_ROOTS,
  type KeyScan,
  MESSAGE_ROOTS,
  messageTextIn,
  RATCHET_ROOT,
  SERVER_TEXT_EXCLUDED,
  SERVER_TEXT_ROOTS,
  scanKeys,
  sourceFiles,
} from './scan.ts'

export const BASELINE_FILE = `${PACKAGE_DIR}hardcoded-baseline.json`
/** The server-side ratchet: user-visible English left per file of SERVER_TEXT_ROOTS ("Server-side text"). */
export const SERVER_BASELINE_FILE = `${PACKAGE_DIR}server-text-baseline.json`

export interface Report {
  errors: string[]
  warnings: string[]
}

/** Keys in a namespace file in the order they are written, with duplicates (JSON.parse would hide those). */
function rawKeys(file: string): string[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return [...text.matchAll(/^ {2}"((?:[^"\\]|\\.)*)":/gm)].map(match => JSON.parse(`"${match[1]}"`) as string)
}

export function checkEnglish(report: Report): Catalog {
  const en: Catalog = {}
  for (const namespace of NAMESPACES) {
    const file = namespaceFile(SOURCE, namespace)
    const messages = readNamespace(SOURCE, namespace)
    const keys = rawKeys(file)
    const seen = new Set<string>()
    for (const key of keys) {
      if (seen.has(key)) report.errors.push(`en/${namespace}.json: "${key}" appears twice`)
      seen.add(key)
    }
    const sorted = [...keys].sort()
    if (keys.join('\n') !== sorted.join('\n'))
      report.errors.push(`en/${namespace}.json: keys are not sorted (sort them alphabetically)`)
    for (const [key, text] of Object.entries(messages)) {
      const full = `${namespace}.${key}`
      if (typeof text !== 'string' || !text.trim()) report.errors.push(`${full}: empty`)
      else for (const error of messageShape(text, SOURCE).errors) report.errors.push(`${full}: ${error}`)
      en[full] = text
    }
  }
  return en
}

/**
 * Namespaces the web app never loads in other languages (the `!**\/server.json` in apps/web/src/i18n/index.tsx's
 * glob): only the API writes them, in the reader's language. A key of theirs used in the web app is English for everyone.
 */
export const WEB_UNLOADED_NAMESPACES: readonly string[] = ['server']

const inWebApp = (file: string) => file.startsWith(`${RATCHET_ROOT}/`)
const webUnloaded = (key: string) => WEB_UNLOADED_NAMESPACES.includes(key.split('.')[0] as string)

/** Code vs catalogs, from a scan of every source file. */
export function checkUsage(en: Catalog, scans: KeyScan[], report: Report) {
  const used = new Set<string>()
  const prefixes = scans.flatMap(scan => scan.dynamic.map(d => d.prefix))
  for (const scan of scans) {
    for (const use of scan.used) {
      used.add(use.key)
      if (!(use.key in en)) report.errors.push(`${use.file}:${use.line}: unknown key "${use.key}"`)
      else if (inWebApp(use.file) && webUnloaded(use.key))
        report.errors.push(
          `${use.file}:${use.line}: "${use.key}" is in a namespace the web app does not load, so it shows in ` +
            'English in every language. Move it to a namespace the web app loads (common, settings, …), or have the API write it ' +
            '(docs/translations.md, "Server-side text")',
        )
    }
    for (const { prefix, file } of scan.dynamic)
      if (inWebApp(file) && webUnloaded(prefix))
        report.errors.push(
          `${file}: i18n-dynamic prefix "${prefix}*" is in a namespace the web app does not load, so its keys show ` +
            'in English in every language (docs/translations.md, "Server-side text")',
        )
    for (const use of scan.undeclared)
      report.errors.push(
        `${use.file}:${use.line}: key built at runtime (${use.key}); declare its prefix with // i18n-dynamic: <prefix>.*`,
      )
  }
  for (const key of Object.keys(en))
    if (!used.has(key) && !prefixes.some(prefix => key.startsWith(prefix)))
      report.errors.push(`${key}: defined in English but not used anywhere`)
}

/** Other languages: structure, keys English lacks, the lock; `complete` also every key present and current. */
export function checkTargets(en: Catalog, lock: Lock, glossary: Glossary, complete: boolean, report: Report) {
  for (const namespace of NAMESPACES) {
    for (const locale of targetsOf(namespace)) {
      const messages = readNamespace(locale, namespace)
      const keys = rawKeys(namespaceFile(locale, namespace))
      if (keys.join('\n') !== [...keys].sort().join('\n'))
        report.errors.push(`${locale}/${namespace}.json: keys are not sorted`)
      const entries = lock[locale] ?? {}
      for (const [key, text] of Object.entries(messages)) {
        const full = `${namespace}.${key}`
        const english = en[full]
        if (english === undefined) {
          report.errors.push(`${locale} ${full}: English has no such key`)
          continue
        }
        for (const error of structureErrors(english, text, locale)) report.errors.push(`${locale} ${full}: ${error}`)
        for (const warning of glossaryErrors(english, text, glossary))
          report.warnings.push(`${locale} ${full}: ${warning}`)
        const entry = entries[full]
        if (!entry) report.errors.push(`${locale} ${full}: no lock entry (run pnpm i18n:lock)`)
        else if (hash(text) !== entry.out) report.warnings.push(`${locale} ${full}: edited by a person since written`)
      }
      if (!complete) continue
      for (const key of Object.keys(en).filter(k => k.startsWith(`${namespace}.`))) {
        const short = key.slice(namespace.length + 1)
        if (!(short in messages)) report.errors.push(`${locale} ${key}: not translated`)
        else if (entries[key] && entries[key].src !== hash(en[key] as string))
          report.errors.push(`${locale} ${key}: English changed since it was translated`)
      }
    }
  }
}

/** No file above its baseline; new files start at 0. */
export function checkRatchet(
  counts: Record<string, number>,
  baseline: Record<string, number>,
  report: Report,
  hits: Record<string, Hardcoded[]> = {},
): { lowered: string[] } {
  const lowered: string[] = []
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0
    if (count > allowed)
      report.errors.push(
        `${file}: ${count} hardcoded user-visible strings, the baseline allows ${allowed}. Move the new text to ` +
          'packages/i18n/locales/en/ and use t() (docs/translations.md)' +
          (hits[file] ?? []).map(hit => `\n    ${file}:${hit.line}: ${JSON.stringify(hit.text)}`).join(''),
      )
  }
  for (const [file, allowed] of Object.entries(baseline))
    if ((counts[file] ?? 0) < allowed) lowered.push(`${file}: ${allowed} → ${counts[file] ?? 0}`)
  return { lowered }
}

/** `--complete`: the baseline must be empty, so a release has no file with hardcoded English left. */
export function checkBaselineEmpty(baseline: Record<string, number>, report: Report) {
  for (const [file, count] of Object.entries(baseline))
    report.errors.push(
      `hardcoded-baseline.json lists ${file} (${count}): a release allows no hardcoded English. Move its strings to ` +
        'keys in packages/i18n/locales/en/ and use t(), then run pnpm i18n:check --update-baseline (docs/translations.md)',
    )
}

/** Formatting outside the app's language: no locale fails, a locale written in the code warns. */
export function checkFormatting(uses: FormattingUse[], report: Report) {
  for (const use of uses)
    if (use.kind === 'browser')
      report.errors.push(
        `${use.file}:${use.line}: formats in the browser's language (${use.code}). Use useFormat(), fmt() or ` +
          'pass intlLocale() (docs/translations.md, "Checks")',
      )
    else
      report.warnings.push(
        `${use.file}:${use.line}: formats with a locale written in the code (${use.code}). Use the app's locale ` +
          '(intlLocale()), or mark a machine format with // i18n-ignore: <why>',
      )
}

/**
 * Server-side text the web app shows (packages/actions, apps/api): no file above `server-text-baseline.json`, and a
 * file it does not list (a new one, or one moved to keys) has none. Unlike the web app's, this baseline is not empty
 * yet: it only goes down (docs/translations.md, "Server-side text").
 */
export function checkServerText(
  counts: Record<string, number>,
  baseline: Record<string, number>,
  report: Report,
  hits: Record<string, Hardcoded[]> = {},
): { lowered: string[] } {
  const lowered: string[] = []
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0
    if (count > allowed)
      report.errors.push(
        `${file}: ${count} hardcoded user-visible strings on the server, server-text-baseline.json allows ${allowed}. ` +
          'Add the text to packages/i18n/locales/en/ and hand the web app a key and params, or write it with the ' +
          "reader's words (Words, getT(locale)); the setup MCP and the CLI get the same key in English " +
          '(docs/translations.md, "Server-side text")' +
          (hits[file] ?? []).map(hit => `\n    ${file}:${hit.line}: ${JSON.stringify(hit.text)}`).join(''),
      )
  }
  for (const [file, allowed] of Object.entries(baseline))
    if ((counts[file] ?? 0) < allowed) lowered.push(`${file}: ${allowed} → ${counts[file] ?? 0}`)
  return { lowered }
}

/** The size of the server-side work: strings per root, and every one of them for `--server-text`. */
export function serverTextSummary(hits: Record<string, Hardcoded[]>, list: boolean): string {
  const lines: string[] = []
  const total = Object.values(hits).reduce((sum, h) => sum + h.length, 0)
  const perRoot = SERVER_TEXT_ROOTS.map(root => {
    const files = Object.entries(hits).filter(([file]) => file.startsWith(`${root}/`))
    return `${root} ${files.reduce((sum, [, h]) => sum + h.length, 0)} in ${files.length} files`
  })
  lines.push(
    `Server-side text (checked against server-text-baseline.json): ${total} user-visible strings (${perRoot.join(', ')}). ` +
      (list ? '' : 'pnpm i18n:check --server-text lists them.'),
  )
  if (list)
    for (const [file, fileHits] of Object.entries(hits))
      for (const hit of fileHits) lines.push(`  ${file}:${hit.line}: ${JSON.stringify(hit.text)}`)
  return lines.join('\n')
}

/** Emails and notifications: no hardcoded English at all (no baseline), no formatting outside the reader's locale. */
export function checkMessages(hits: Record<string, Hardcoded[]>, formatting: FormattingUse[], report: Report) {
  for (const [file, fileHits] of Object.entries(hits))
    report.errors.push(
      `${file}: ${fileHits.length} hardcoded strings in emails or notifications. Add each to ` +
        'packages/i18n/locales/en/email.json and render it with getT(locale).t() in apps/api/src/emails, in the ' +
        'recipient\'s language (docs/translations.md, "Emails and notifications")' +
        fileHits.map(hit => `\n    ${file}:${hit.line}: ${JSON.stringify(hit.text)}`).join(''),
    )
  for (const use of formatting)
    report.errors.push(
      `${use.file}:${use.line}: an email formats ${use.kind === 'browser' ? "in the server's language" : 'with a locale written in the code'} (${use.code}). Use getT(locale).format, in the reader's language`,
    )
}

export const ratchetIgnore = (glossary: Glossary) => new Set(glossary.neverTranslate ?? [])

function main() {
  const args = new Set(process.argv.slice(2))
  const complete = args.has('--complete')
  const report: Report = { errors: [], warnings: [] }
  const glossary = readGlossary()

  const en = checkEnglish(report)
  const scans = KEY_ROOTS.flatMap(root =>
    sourceFiles(root).map(file => scanKeys(file, readFileSync(`${REPO_DIR}${file}`, 'utf8'))),
  )
  checkUsage(en, scans, report)
  checkTargets(en, readLock(), glossary, complete, report)

  const ignore = ratchetIgnore(glossary)
  const webFiles = sourceFiles(RATCHET_ROOT)
  const hits = hardcodedIn([RATCHET_ROOT], ignore, { textReceivers: true })
  const counts = Object.fromEntries(Object.entries(hits).map(([file, h]) => [file, h.length]))
  checkFormatting(
    webFiles.flatMap(file => findFormatting(file, readFileSync(`${REPO_DIR}${file}`, 'utf8'))),
    report,
  )
  const ignores = webFiles.reduce((sum, file) => sum + ignoreComments(readFileSync(`${REPO_DIR}${file}`, 'utf8')), 0)
  const serverHits = Object.fromEntries(
    Object.entries(hardcodedIn(SERVER_TEXT_ROOTS, ignore)).filter(([file]) => !SERVER_TEXT_EXCLUDED.has(file)),
  )
  const serverCounts = Object.fromEntries(Object.entries(serverHits).map(([file, h]) => [file, h.length]))
  if (args.has('--update-baseline')) {
    writeJson(BASELINE_FILE, counts)
    console.log(
      `hardcoded-baseline.json: ${Object.values(counts).reduce((a, b) => a + b, 0)} strings in ${Object.keys(counts).length} files`,
    )
    // Only down: a file above its count stays an error, so this never makes room for new English on the server.
    const serverBaseline = readJson<Record<string, number>>(SERVER_BASELINE_FILE, {})
    const lowered = Object.fromEntries(
      Object.entries(serverCounts).map(([file, count]) => [file, Math.min(count, serverBaseline[file] ?? 0)]),
    )
    writeJson(SERVER_BASELINE_FILE, Object.fromEntries(Object.entries(lowered).filter(([, count]) => count > 0)))
    checkServerText(serverCounts, serverBaseline, report, serverHits)
  } else {
    const baseline = readJson<Record<string, number>>(BASELINE_FILE, {})
    if (complete) checkBaselineEmpty(baseline, report)
    const { lowered } = checkRatchet(counts, baseline, report, hits)
    if (lowered.length)
      console.log(
        `Fewer hardcoded strings than the baseline (run pnpm i18n:check --update-baseline):\n  ${lowered.join('\n  ')}`,
      )
  }

  const messageFiles = MESSAGE_ROOTS.flatMap(root => sourceFiles(root))
  checkMessages(
    messageTextIn(ignore),
    messageFiles.flatMap(file => findFormatting(file, readFileSync(`${REPO_DIR}${file}`, 'utf8'))),
    report,
  )
  const messageIgnores = messageFiles.reduce(
    (sum, file) => sum + ignoreComments(readFileSync(`${REPO_DIR}${file}`, 'utf8')),
    0,
  )

  if (!args.has('--update-baseline')) {
    const { lowered } = checkServerText(
      serverCounts,
      readJson<Record<string, number>>(SERVER_BASELINE_FILE, {}),
      report,
      serverHits,
    )
    if (lowered.length)
      console.log(
        `Fewer server-side strings than server-text-baseline.json (run pnpm i18n:check --update-baseline):\n  ${lowered.join('\n  ')}`,
      )
  }
  console.log(serverTextSummary(serverHits, args.has('--server-text')))
  console.log(`// i18n-ignore comments in the web app: ${ignores}, in emails and notifications: ${messageIgnores}`)

  for (const warning of report.warnings) console.warn(`warning: ${warning}`)
  for (const error of report.errors) console.error(`error: ${error}`)
  const total = Object.keys(en).length
  console.log(
    `i18n: ${total} English keys, ${report.errors.length} errors, ${report.warnings.length} warnings${complete ? ' (complete)' : ''}`,
  )
  if (report.errors.length) process.exit(1)
}

if (isMain(import.meta.url)) main()
