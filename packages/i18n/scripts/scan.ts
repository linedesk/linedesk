/**
 * Reads the source code (oxc's TypeScript parser) for two things: which message keys it uses, and how much
 * user-visible English is still written straight into the web app (the hardcoded-string ratchet).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import { parseSync } from 'oxc-parser'
import { REPO_DIR } from './lib.ts'

/** Where keys are used: the web app, the API and every package. */
export const KEY_ROOTS = ['apps/web/src', 'apps/api/src', 'packages']
/** Where the ratchet counts hardcoded text. */
export const RATCHET_ROOT = 'apps/web/src'

const SKIP_DIRS = new Set(['node_modules', 'dist', 'migrations', 'locales', 'scripts', 'test'])
const isSource = (file: string) => /\.(ts|tsx)$/.test(file) && !/\.(test|spec|fixture)\.tsx?$/.test(file)

export function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`
      if (statSync(path).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(path)
      } else if (isSource(name)) out.push(path)
    }
  }
  walk(`${REPO_DIR}${root}`)
  return out.map(file => relative(REPO_DIR, file))
}

// biome-ignore lint/suspicious/noExplicitAny: the parser's ESTree nodes, walked generically.
type Node = any

function walk(node: Node, visit: (node: Node, parent: Node | null) => void, parent: Node | null = null) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent)
    return
  }
  if (typeof node.type === 'string') visit(node, parent)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || !value || typeof value !== 'object') continue
    walk(value, visit, typeof node.type === 'string' ? node : parent)
  }
}

function parse(file: string, source: string) {
  const result = parseSync(file, source, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' })
  if (result.errors.length) throw new Error(`${file}: ${result.errors[0]?.message ?? 'parse error'}`)
  return result
}

/** The string values an expression can have when it is a literal or a choice between literals. */
function literalValues(node: Node): string[] | null {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return [node.value]
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return [node.quasis[0].value.cooked]
  if (node.type === 'ConditionalExpression') {
    const a = literalValues(node.consequent)
    const b = literalValues(node.alternate)
    return a && b ? [...a, ...b] : null
  }
  if (node.type === 'LogicalExpression') {
    const b = literalValues(node.right)
    return b
  }
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'ParenthesizedExpression'
  )
    return literalValues(node.expression)
  return null
}

const KEY_CALLS = new Set(['t', 'msg'])

export interface KeyUse {
  key: string
  file: string
  line: number
}

export interface KeyScan {
  used: KeyUse[]
  /** Prefixes declared with `// i18n-dynamic: errors.*`: keys built at runtime under them count as used. */
  dynamic: { prefix: string; file: string }[]
  /** A key built at runtime with no `// i18n-dynamic` declaration in its file. */
  undeclared: KeyUse[]
}

const lineOf = (source: string, offset: number) => source.slice(0, offset).split('\n').length

/** `t('…')`, `x.t('…')`, `msg('…')` and `<T k="…">` in one file. */
export function scanKeys(file: string, source: string): KeyScan {
  const out: KeyScan = { used: [], dynamic: [], undeclared: [] }
  if (!/\bt\(|\.t\(|\bmsg\(|<T\b|i18n-dynamic/.test(source)) return out
  const { program, comments } = parse(file, source)
  for (const comment of comments) {
    const match = /i18n-dynamic:\s*(.+)/.exec(comment.value)
    if (match)
      for (const prefix of (match[1] as string).split(/[\s,]+/).filter(Boolean))
        out.dynamic.push({ prefix: prefix.replace(/\*$/, ''), file })
  }
  const take = (arg: Node, at: number) => {
    const values = literalValues(arg)
    if (values) for (const key of values) out.used.push({ key, file, line: lineOf(source, at) })
    // A variable or parameter is typed MessageKey (its literal is found where it was written, with msg()); only a key
    // assembled from pieces is built at runtime.
    else if (arg && (arg.type === 'TemplateLiteral' || arg.type === 'BinaryExpression'))
      out.undeclared.push({ key: source.slice(arg.start, arg.end), file, line: lineOf(source, at) })
  }
  walk(program, node => {
    if (node.type === 'CallExpression') {
      const callee = node.callee
      const name =
        callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? callee.property?.name : null
      if (name && KEY_CALLS.has(name) && node.arguments.length) take(node.arguments[0], node.start)
    } else if (node.type === 'JSXOpeningElement' && node.name.type === 'JSXIdentifier' && node.name.name === 'T') {
      const k = node.attributes.find((a: Node) => a.type === 'JSXAttribute' && a.name.name === 'k')
      if (k) take(k.value?.type === 'JSXExpressionContainer' ? k.value.expression : k.value, node.start)
    }
  })
  // A runtime key is fine when its file declares where such keys live.
  if (out.dynamic.length) out.undeclared = []
  return out
}

/** Attributes whose string values are text people read. */
const TEXT_ATTRIBUTES = new Set(['title', 'placeholder', 'aria-label', 'label', 'alt', 'tooltip'])
const hasLetters = (text: string) => /\p{L}{2,}/u.test(text)

/** A string that is text people read: a literal, or a template's fixed parts. */
function textOf(node: Node): string | null {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral') return node.quasis.map((q: Node) => q.value.cooked).join(' ')
  if (node.type === 'JSXExpressionContainer') return textOf(node.expression)
  if (node.type === 'ConditionalExpression') {
    const parts = [textOf(node.consequent), textOf(node.alternate)].filter(Boolean)
    return parts.length ? parts.join(' ') : null
  }
  return null
}

/**
 * Hardcoded user-visible text in one file: JSX text, string literals in text attributes (title, placeholder,
 * aria-label, label, alt, tooltip) and in `toast(…)`. Never-translate words alone (brand names) don't count.
 */
export function countHardcoded(file: string, source: string, ignore: ReadonlySet<string> = new Set()): number {
  if (!file.endsWith('.tsx') && !/\btoast\(/.test(source)) return 0
  const { program } = parse(file, source)
  let count = 0
  const counts = (text: string | null) => {
    if (!text) return false
    const trimmed = text.replace(/\s+/g, ' ').trim()
    return hasLetters(trimmed) && !ignore.has(trimmed)
  }
  walk(program, (node, parent) => {
    if (node.type === 'JSXText') {
      if (counts(node.value)) count++
    } else if (node.type === 'JSXExpressionContainer' && node.expression?.type === 'Literal') {
      // {'text'} as a child (not an attribute value: attributes are counted below).
      if (parent?.type !== 'JSXAttribute' && counts(node.expression.value)) count++
    } else if (node.type === 'JSXAttribute') {
      const name = typeof node.name.name === 'string' ? node.name.name : ''
      if (TEXT_ATTRIBUTES.has(name) && counts(textOf(node.value))) count++
    } else if (node.type === 'CallExpression') {
      const callee = node.callee
      const name =
        callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? callee.property?.name : null
      if (name === 'toast' && counts(textOf(node.arguments[0]))) count++
    }
  })
  return count
}

/** The ratchet's counts for every file of the web app that has any. */
export function hardcodedCounts(ignore: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const file of sourceFiles(RATCHET_ROOT)) {
    const count = countHardcoded(file, readFileSync(`${REPO_DIR}${file}`, 'utf8'), ignore)
    if (count) out[file] = count
  }
  return out
}
