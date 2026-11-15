/**
 * What the i18n scripts share: reading and writing catalogs and the lock, the lock decisions, ICU validation.
 * Pure functions where possible, so the tests need no files.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type MessageFormatElement, parse, TYPE } from '@formatjs/icu-messageformat-parser'
import { NAMESPACES, SOURCE, targetsOf, type UiLocale } from '../locales.ts'

export const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))
export const REPO_DIR = fileURLToPath(new URL('../../../', import.meta.url))
export const LOCALES_DIR = `${PACKAGE_DIR}locales/`
export const LOCK_FILE = `${PACKAGE_DIR}i18n.lock.json`

export type Catalog = Record<string, string>
/** What a target string was made from: the English it translates, the text we last wrote or accepted, and by whom. */
export interface LockEntry {
  src: string
  out: string
  by: 'ai' | 'human'
}
export type Lock = Record<string, Record<string, LockEntry>>

/** True when this module is the script node was started with (not imported by a test). */
export const isMain = (moduleUrl: string) => !!process.argv[1] && fileURLToPath(moduleUrl) === process.argv[1]

export const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** All target locales of any namespace. */
export function allTargets(): UiLocale[] {
  return [...new Set(NAMESPACES.flatMap(ns => targetsOf(ns)))]
}

export function namespaceFile(locale: string, namespace: string) {
  return `${LOCALES_DIR}${locale}/${namespace}.json`
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

/** Keys sorted, 2-space JSON, trailing newline: the one format every catalog and the lock are written in. */
export function writeJson(file: string, value: unknown) {
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  writeFileSync(file, `${JSON.stringify(sortDeep(value), null, 2)}\n`)
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortDeep(v)]),
    )
  return value
}

/** One namespace file of one language, keys without the namespace. */
export const readNamespace = (locale: string, namespace: string): Catalog =>
  readJson<Catalog>(namespaceFile(locale, namespace), {})

/** A whole language with full keys ("inbox.row.markHandled"). */
export function readLocale(locale: string): Catalog {
  const out: Catalog = {}
  for (const namespace of NAMESPACES)
    for (const [key, text] of Object.entries(readNamespace(locale, namespace))) out[`${namespace}.${key}`] = text
  return out
}

/** Writes a language back, one file per namespace (a namespace without keys becomes `{}`). */
export function writeLocale(locale: string, messages: Catalog) {
  for (const namespace of NAMESPACES) {
    const prefix = `${namespace}.`
    const part = Object.fromEntries(
      Object.entries(messages)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, text]) => [key.slice(prefix.length), text]),
    )
    writeJson(namespaceFile(locale, namespace), part)
  }
}

export const readLock = (): Lock => readJson<Lock>(LOCK_FILE, {})
export const writeLock = (lock: Lock) => writeJson(LOCK_FILE, lock)

export const readEnglish = () => readLocale(SOURCE)

// ---------------------------------------------------------------------------------------------------------------
// Lock decisions

export interface Plan {
  /** New key, or the English changed: translate. */
  translate: string[]
  /** A person's translation whose English changed: translate again with theirs as reference ("needs a native check"). */
  retranslateHuman: string[]
  /** A person edited the target since we wrote it: keep it, mark it human. */
  humanEdits: string[]
  /** Gone from English: remove from the target and the lock. */
  remove: string[]
}

/** What to do with one language, from the English, that language's current text and its lock entries. */
export function planLocale(en: Catalog, target: Catalog, lock: Record<string, LockEntry> = {}): Plan {
  const plan: Plan = { translate: [], retranslateHuman: [], humanEdits: [], remove: [] }
  for (const key of Object.keys(en).sort()) {
    const source = hash(en[key] as string)
    const text = target[key]
    const entry = lock[key]
    if (text === undefined) {
      plan.translate.push(key)
      continue
    }
    // A text without a lock entry came from a person (a contribution that added it): theirs.
    const edited = !entry || hash(text) !== entry.out
    const human = edited || entry.by === 'human'
    if (!entry || entry.src !== source) {
      if (human) plan.retranslateHuman.push(key)
      else plan.translate.push(key)
    } else if (edited) plan.humanEdits.push(key)
  }
  for (const key of Object.keys(target).sort()) if (!(key in en)) plan.remove.push(key)
  return plan
}

/** The lock entry for a text we just wrote (`by: ai`) or a person's text we accept (`by: human`). */
export const lockEntry = (english: string, text: string, by: LockEntry['by']): LockEntry => ({
  src: hash(english),
  out: hash(text),
  by,
})

// ---------------------------------------------------------------------------------------------------------------
// ICU validation

interface Shape {
  args: Map<string, string>
  tags: Set<string>
  errors: string[]
}

function shapeOf(elements: MessageFormatElement[], locale: string, shape: Shape) {
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories
  for (const element of elements) {
    switch (element.type) {
      case TYPE.argument:
        shape.args.set(element.value, shape.args.get(element.value) ?? 'argument')
        break
      case TYPE.number:
        shape.args.set(element.value, 'number')
        break
      case TYPE.date:
      case TYPE.time:
        shape.args.set(element.value, 'date')
        break
      case TYPE.select:
      case TYPE.plural: {
        const kind = element.type === TYPE.plural ? 'plural' : 'select'
        shape.args.set(element.value, kind)
        if (!('other' in element.options)) shape.errors.push(`${kind} "${element.value}" has no "other"`)
        if (element.type === TYPE.plural && element.pluralType !== 'ordinal') {
          const missing = categories.filter(category => !(category in element.options))
          if (missing.length) shape.errors.push(`plural "${element.value}" misses ${missing.join(', ')} for ${locale}`)
        }
        for (const option of Object.values(element.options)) shapeOf(option.value, locale, shape)
        break
      }
      case TYPE.tag:
        shape.tags.add(element.value)
        shapeOf(element.children, locale, shape)
        break
    }
  }
}

/** Arguments (name to kind), tags and structural errors of one message; a parse error is the only error then. */
export function messageShape(message: string, locale: string): Shape {
  const shape: Shape = { args: new Map(), tags: new Set(), errors: [] }
  try {
    shapeOf(parse(message), locale, shape)
  } catch (error) {
    shape.errors.push(`not valid ICU: ${(error as Error).message}`)
  }
  return shape
}

const describeArgs = (args: Map<string, string>) =>
  [...args]
    .map(([name, kind]) => `${name}:${kind}`)
    .sort()
    .join(', ')

/**
 * The structure a translation must keep: it parses; the same arguments with the same kinds; the same tags; plural and
 * select have "other"; plurals cover every category of the language.
 */
export function structureErrors(english: string, translation: string, locale: string): string[] {
  const source = messageShape(english, SOURCE)
  const target = messageShape(translation, locale)
  const errors = [...target.errors]
  if (target.errors.some(e => e.startsWith('not valid ICU'))) return errors
  // English "argument" (plain {x}) and the same name used as a plain argument are the same; a kind change is not.
  if (describeArgs(source.args) !== describeArgs(target.args))
    errors.push(`arguments differ: English has {${describeArgs(source.args)}}, got {${describeArgs(target.args)}}`)
  const sourceTags = [...source.tags].sort().join(', ')
  const targetTags = [...target.tags].sort().join(', ')
  if (sourceTags !== targetTags) errors.push(`tags differ: English has <${sourceTags}>, got <${targetTags}>`)
  return errors
}

export interface Glossary {
  neverTranslate: string[]
  terms: Record<string, Record<string, string>>
  identical: Record<string, string[] | string>
}

export const readGlossary = (): Glossary => readJson<Glossary>(`${PACKAGE_DIR}glossary.json`, {} as Glossary)

/** Words in a message outside arguments and tags (for the "left in English" rule). */
const wordCount = (text: string) =>
  text
    .replace(/\{[^}]*\}|<[^>]*>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length

/** Terms that must not change: every never-translate term the English has must appear as it is. */
export function glossaryErrors(english: string, translation: string, glossary: Glossary): string[] {
  return (glossary.neverTranslate ?? [])
    .filter(term => english.includes(term) && !translation.includes(term))
    .map(term => `"${term}" must stay as it is`)
}

/** Everything the translate script checks before it writes a translation. */
export function validateTranslation(
  key: string,
  english: string,
  translation: string,
  locale: string,
  glossary: Glossary,
): string[] {
  const errors = [...structureErrors(english, translation, locale), ...glossaryErrors(english, translation, glossary)]
  const identical = glossary.identical?.[locale]
  const allowedSame = Array.isArray(identical) && identical.includes(key)
  if (translation.trim() === english.trim() && wordCount(english) > 3 && !allowedSame)
    errors.push('left in English (list the key under "identical" in glossary.json if that is right)')
  return errors
}

/** A translation much longer than the English (a warning: it may not fit). */
export const tooLong = (english: string, translation: string) =>
  english.length >= 8 && translation.length > english.length * 2.5
