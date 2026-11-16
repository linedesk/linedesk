// Parsing the command line: no dependencies, so the CLI runs from a checkout with Node alone.

export type Parsed = {
  /** The words that are not options, in order. */
  words: string[]
  /** `--name value`, `--name=value`; `--flag` alone is true. A repeated option keeps its last value. */
  options: Map<string, string | true>
}

/** Options that never take a value, so `--yes create` does not read `create` as the value of `--yes`. */
const FLAGS = new Set(['yes', 'help', 'raw'])

export function parseArgs(argv: readonly string[]): Parsed {
  const words: string[] = []
  const options = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') {
      words.push(...argv.slice(i + 1))
      break
    }
    if (!arg.startsWith('--') || arg === '--') {
      words.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq > 0) {
      options.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (FLAGS.has(body) || next === undefined || next.startsWith('--')) options.set(body, true)
    else {
      options.set(body, next)
      i++
    }
  }
  return { words, options }
}

/** Options of the CLI itself, never part of an action's input. */
export const GLOBAL_OPTIONS = new Set(['workspace', 'json', 'yes', 'help', 'url', 'raw'])

/** A value from the command line: JSON when it reads as JSON (numbers, true, null, arrays, objects), else the text. */
export function readValue(text: string | true): unknown {
  if (text === true) return true
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * An action's input: `--json '{…}'` as the base, then each other option as a field (`--contactId c_1`), with dots for
 * nested fields (`--patch.name Mike`). A field the schema says is a string stays text (`--phone 5035550100`).
 */
export function actionInput(
  options: Parsed['options'],
  stringFields: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const base = options.get('json')
  const input: Record<string, unknown> = {}
  if (typeof base === 'string') {
    const parsed = JSON.parse(base) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--json must be a JSON object')
    Object.assign(input, parsed)
  }
  for (const [name, raw] of options) {
    if (GLOBAL_OPTIONS.has(name)) continue
    const path = name.split('.')
    if (path.some(part => !part || part === '__proto__' || part === 'prototype' || part === 'constructor'))
      throw new Error(`not a field name: --${name}`)
    let target = input
    for (const part of path.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== 'object') target[part] = {}
      target = target[part] as Record<string, unknown>
    }
    target[path.at(-1)!] = stringFields.has(name) && raw !== true ? raw : readValue(raw)
  }
  return input
}
