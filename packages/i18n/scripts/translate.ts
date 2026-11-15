/**
 * `pnpm i18n:translate [--locale es] [--ns inbox] [--force-key <key>] [--dry-run] [--report <file>]` (docs/translations.md).
 *
 * Optional local tool, not part of CI: translates new and changed English strings with Claude, never touching a
 * person's edit unless its English changed. A first draft for the release translation pass (docs/translations.md),
 * which still checks every string on its screen. Reads only `ANTHROPIC_API_KEY` from your own environment (and
 * `I18N_MODEL` to try another model).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { NAMESPACES, SOURCE, targetsOf, type UiLocale } from '../locales.ts'
import {
  type Catalog,
  type Glossary,
  isMain,
  lockEntry,
  PACKAGE_DIR,
  planLocale,
  readEnglish,
  readGlossary,
  readJson,
  readLocale,
  readLock,
  tooLong,
  validateTranslation,
  writeLocale,
  writeLock,
} from './lib.ts'

const BATCH = 80
const MODEL = process.env.I18N_MODEL || 'claude-opus-5-5'

interface Options {
  locales: UiLocale[]
  namespaces: string[]
  forceKeys: string[]
  dryRun: boolean
  /** Markdown summary, for the release pull request. */
  reportFile?: string
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const at = argv.indexOf(flag)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const all = (flag: string) => argv.flatMap((arg, i) => (arg === flag && argv[i + 1] ? [argv[i + 1] as string] : []))
  const locale = value('--locale')
  const targets = [...new Set(NAMESPACES.flatMap(ns => targetsOf(ns)))]
  const ns = value('--ns')
  return {
    locales: locale ? targets.filter(l => l === locale) : targets,
    namespaces: ns ? NAMESPACES.filter(n => n === ns) : [...NAMESPACES],
    forceKeys: all('--force-key'),
    dryRun: argv.includes('--dry-run'),
    reportFile: value('--report'),
  }
}

/** STYLE.md's general part plus the one section for this language. */
export function styleFor(style: string, locale: string): string {
  const sections = style.split(/^## /m)
  const general = sections.find(s => s.startsWith('General')) ?? ''
  const own = sections.find(s => s.startsWith(`${locale}:`)) ?? ''
  return [`## ${general}`, own && `## ${own}`].filter(Boolean).join('\n')
}

function systemPrompt(locale: UiLocale, style: string, glossary: Glossary): string {
  const terms = Object.entries(glossary.terms ?? {})
    .map(([term, byLocale]) => `- ${term}: ${byLocale[locale] ?? term}${byLocale.note ? ` (${byLocale.note})` : ''}`)
    .join('\n')
  return [
    `You translate the user interface of Linedesk, an open-source AI phone assistant for small businesses, from US English into ${locale}.`,
    'Each request is a JSON object of message keys to English ICU MessageFormat strings, sometimes with a note about where the text appears and, when the English changed, the previous translation to keep where it still fits.',
    'Return a JSON object with the same keys and the translation of each. Keep every ICU argument, tag and # exactly; give every plural category the language has; never add explanations.',
    styleFor(style, locale),
    `Never translate: ${(glossary.neverTranslate ?? []).join(', ')}.`,
    `Fixed terms for ${locale}:\n${terms}`,
  ].join('\n\n')
}

interface Item {
  key: string
  english: string
  note?: string
  previous?: string
}

async function translateBatch(
  client: Anthropic,
  system: string,
  items: Item[],
  feedback?: string,
): Promise<Record<string, string>> {
  const input = Object.fromEntries(
    items.map(item => [
      item.key,
      {
        english: item.english,
        ...(item.note ? { note: item.note } : {}),
        ...(item.previous ? { previous: item.previous } : {}),
      },
    ]),
  )
  const schema = {
    type: 'object',
    properties: Object.fromEntries(items.map(item => [item.key, { type: 'string' }])),
    required: items.map(item => item.key),
    additionalProperties: false,
  }
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    messages: [
      {
        role: 'user',
        content: `${feedback ? `${feedback}\n\n` : ''}${JSON.stringify(input, null, 2)}`,
      },
    ],
  })
  if (response.stop_reason === 'refusal') throw new Error('the model declined this batch')
  if (response.stop_reason === 'max_tokens') throw new Error('the answer was cut off (max_tokens)')
  const text = response.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
  return JSON.parse(text) as Record<string, string>
}

interface Summary {
  written: number
  needsCheck: string[]
  failures: string[]
  warnings: string[]
}

async function translateLocale(
  client: Anthropic | null,
  locale: UiLocale,
  options: Options,
  en: Catalog,
  notes: Catalog,
  system: string,
  glossary: Glossary,
): Promise<Summary> {
  const summary: Summary = { written: 0, needsCheck: [], failures: [], warnings: [] }
  const lock = readLock()
  const entries = { ...(lock[locale] ?? {}) }
  const target = readLocale(locale)
  const inScope = (key: string) => options.namespaces.some(ns => key.startsWith(`${ns}.`))
  const plan = planLocale(en, target, entries)

  // A person's edit since the last run: theirs from now on.
  for (const key of plan.humanEdits) entries[key] = lockEntry(en[key] as string, target[key] as string, 'human')
  for (const key of plan.remove) {
    delete target[key]
    delete entries[key]
  }
  const forced = options.forceKeys.filter(key => key in en)
  const work: Item[] = [
    ...plan.translate.filter(inScope).map(key => ({ key, english: en[key] as string })),
    ...plan.retranslateHuman.filter(inScope).map(key => ({ key, english: en[key] as string, previous: target[key] })),
    ...forced
      .filter(key => !plan.translate.includes(key) && !plan.retranslateHuman.includes(key))
      .map(key => ({ key, english: en[key] as string })),
  ].map(item => ({ ...item, ...(notes[item.key] ? { note: notes[item.key] } : {}) }))

  console.log(`${locale}: ${work.length} to translate (${plan.retranslateHuman.length} with a person's earlier text)`)
  if (options.dryRun || !client || !work.length) {
    if (!options.dryRun) {
      lock[locale] = entries
      writeLock(lock)
      writeLocale(locale, target)
    }
    return summary
  }

  for (let start = 0; start < work.length; start += BATCH) {
    const batch = work.slice(start, start + BATCH)
    let pending = batch
    let feedback: string | undefined
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      let result: Record<string, string>
      try {
        result = await translateBatch(client, system, pending, feedback)
      } catch (error) {
        if (attempt === 1) summary.failures.push(...pending.map(item => `${item.key}: ${(error as Error).message}`))
        continue
      }
      const retry: Item[] = []
      const problems: string[] = []
      for (const item of pending) {
        const text = result[item.key]
        const errors =
          text === undefined ? ['missing'] : validateTranslation(item.key, item.english, text, locale, glossary)
        if (errors.length) {
          retry.push(item)
          problems.push(`${item.key}: ${errors.join('; ')}`)
          continue
        }
        target[item.key] = text as string
        entries[item.key] = lockEntry(item.english, text as string, 'ai')
        summary.written++
        if (item.previous !== undefined) summary.needsCheck.push(item.key)
        if (tooLong(item.english, text as string)) summary.warnings.push(`${item.key}: much longer than the English`)
      }
      if (attempt === 1) summary.failures.push(...problems)
      pending = retry
      feedback = retry.length ? `Fix these errors from your last answer:\n${problems.join('\n')}` : undefined
    }
    // Written after every batch, so a stopped run keeps what it has.
    lock[locale] = entries
    writeLock(lock)
    writeLocale(locale, target)
  }
  return summary
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey && !options.dryRun) {
    console.error('ANTHROPIC_API_KEY is not set (use --dry-run to see what would be translated)')
    process.exit(1)
  }
  const client = apiKey ? new Anthropic({ apiKey }) : null
  const en = readEnglish()
  const notes = readJson<Catalog>(`${PACKAGE_DIR}locales/${SOURCE}/_context.json`, {})
  const style = readFileSync(`${PACKAGE_DIR}STYLE.md`, 'utf8')
  const glossary = readGlossary()

  const report: string[] = []
  let failed = false
  for (const locale of options.locales) {
    const summary = await translateLocale(
      client,
      locale,
      options,
      en,
      notes,
      systemPrompt(locale, style, glossary),
      glossary,
    )
    report.push(`### ${locale}: ${summary.written} written`)
    if (summary.needsCheck.length)
      report.push(
        'Needs a native check (a person had translated these before the English changed):',
        ...summary.needsCheck.map(k => `- \`${k}\``),
      )
    if (summary.warnings.length) report.push('Warnings:', ...summary.warnings.map(w => `- ${w}`))
    if (summary.failures.length) {
      failed = true
      report.push('Failed (English shows until the next run):', ...summary.failures.map(f => `- ${f}`))
    }
  }
  console.log(report.join('\n'))
  if (options.reportFile) writeFileSync(options.reportFile, `${report.join('\n')}\n`)
  if (failed) process.exitCode = 2
}

if (isMain(import.meta.url)) await main()
