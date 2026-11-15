/**
 * Reads the source code (oxc's TypeScript parser) for two things: which message keys it uses, and how much
 * user-visible English is still written straight into the web app (the hardcoded-string ratchet).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import { parseSync } from 'oxc-parser'
import { REPO_DIR } from './lib.ts'

/** Where keys are used: the web app, the API and every package. */
export const KEY_ROOTS = ['apps/web/src', 'apps/api/src', 'apps/agent/src', 'packages']
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

export interface Hardcoded {
  line: number
  text: string
}

/** Calls whose string arguments are never shown to people: styling, storage keys, DOM, URL and test plumbing. */
const PLUMBING_CALLS = new Set([
  'captureException',
  'captureMessage',
  'reportError',
  'cn',
  'clsx',
  'cva',
  'twMerge',
  'fetch',
  'require',
  'querySelector',
  'querySelectorAll',
  'getElementById',
  'closest',
  'matches',
  'matchMedia',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'CustomEvent',
  'Event',
  'setAttribute',
  'getAttribute',
  'removeAttribute',
  'setProperty',
  'getItem',
  'setItem',
  'removeItem',
  'get',
  'has',
  'delete',
  'URL',
  'URLSearchParams',
  'RegExp',
  'split',
  'join',
  'replace',
  'replaceAll',
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'postMessage',
  'createElement',
  'DateTimeFormat',
  'NumberFormat',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'localeCompare',
  'describe',
  'it',
  'test',
  'expect',
])
/** Objects whose methods write logs (`console.warn(…)`, `logger.error(…)`): logs stay English. */
const LOG_OBJECT = /^(?:console|log|logger|\w+Logger)$/
/** Object keys and JSX attributes whose values are never shown to people. */
const PLUMBING_KEYS = new Set([
  'id',
  'key',
  'href',
  'to',
  'path',
  'url',
  'src',
  'className',
  'class',
  'style',
  'type',
  'kind',
  'variant',
  'icon',
  'color',
  'tone',
  'role',
  'method',
  'mode',
  'format',
  'pattern',
  'mime',
  'accept',
  'autoComplete',
  'inputMode',
  'rel',
  'target',
  'locale',
  'timeZone',
  'credentials',
  'cache',
  'headers',
  'Content-Type',
  // Words the command palette matches what is typed against; never shown.
  'keywords',
])
/** Key names of keyboard events and protocol words: they look like English words but are identifiers. */
const NOT_TEXT = new Set([
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Shift',
  'Control',
  'Meta',
  'Alt',
  'Fn',
  'Hyper',
  'Super',
  'Bearer',
  'Basic',
])
/** Small English words that a sentence has and a list of class names or identifiers does not. */
const FUNCTION_WORDS =
  /(?:^| )(?:the|a|an|to|of|your|you|is|are|was|and|or|for|with|in|on|this|that|no|not|we|it|be|can|could|has|have)(?: |$)/

/** Reads like a sentence: a capital letter then a small one and a space, or small words that include a function word. */
const looksLikeProse = (raw: string) => {
  // A template's fixed part can start after an argument: `${label} · Next time, press ${key}`.
  const text = raw.replace(/^[^\p{L}\p{N}]+/u, '')
  return (
    !/^[\w.-]+:\/\//.test(text) &&
    /\s/.test(text) &&
    (/^\p{Lu}\p{Ll}/u.test(text) || (/^[\p{Ll} ,.!?’']+$/u.test(text) && FUNCTION_WORDS.test(text)))
  )
}
/**
 * Inside a message (findMessageText) a stricter test: any two words, also lowercase after an argument
 * (`${workspace} reached its monthly cap`). Messages hold no class names or HTML outside apps/api/src/emails.
 */
const looksLikeWords = (text: string) => !/^[\w.-]+:\/\//.test(text) && /\p{L}{2,}[,.:;!?)]?\s+\(?\p{L}{2,}/u.test(text)
/** One capitalised word or a few ("Reopen", "Synced"): text only where a value is chosen (inTextPosition). */
const looksLikeWord = (text: string) => /^\p{Lu}\p{Ll}+(?:[ ’'-]\p{L}+)*[.!?…]?$/u.test(text) && !NOT_TEXT.has(text)

function callName(node: Node): string | null {
  const callee = node.callee
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression') return callee.property?.name ?? null
  return null
}

const keyName = (node: Node): string | null =>
  node?.type === 'Identifier' ? node.name : node?.type === 'Literal' ? String(node.value) : null

/** Where a single capitalised word is a value someone reads: returned, chosen, assigned or listed. */
function inTextPosition(node: Node, parent: Node | null): boolean {
  if (!parent) return false
  switch (parent.type) {
    case 'ReturnStatement':
    case 'ArrowFunctionExpression':
    case 'ArrayExpression':
    case 'VariableDeclarator':
    case 'JSXExpressionContainer':
      return true
    case 'ConditionalExpression':
      return parent.test !== node
    case 'LogicalExpression':
      return parent.right === node
    case 'Property':
      return parent.value === node
    default:
      return false
  }
}

/** `// i18n-ignore: <why>` right before a statement or an expression: nothing in it counts. The reason is required. */
function ignoredStarts(source: string, comments: Node[]): Set<number> {
  const out = new Set<number>()
  for (const comment of comments)
    if (/^\s*i18n-ignore:\s*\S/.test(comment.value)) {
      const rest = source.slice(comment.end)
      out.add(comment.end + (rest.length - rest.trimStart().length))
    }
  return out
}

/** How many `// i18n-ignore:` comments a file has (the check prints the total, so they stay few and visible). */
export const ignoreComments = (source: string) => (source.match(/\/\/[ \t]*i18n-ignore:[ \t]*\S/g) ?? []).length

/** Walks with the chain of parents (`stack`, outermost first); `visit` returning false skips the node's children. */
function walkWithParents(root: Node, visit: (node: Node, parent: Node | null, stack: readonly Node[]) => boolean) {
  const stack: Node[] = []
  const go = (node: Node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) go(child)
      return
    }
    if (typeof node.type !== 'string') return
    if (!visit(node, stack[stack.length - 1] ?? null, stack)) return
    stack.push(node)
    for (const [key, value] of Object.entries(node))
      if (key !== 'parent' && value && typeof value === 'object') go(value)
    stack.pop()
  }
  go(root)
}

const KEEP_TS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSParameterProperty'])
const SKIPPED = new Set([
  'ImportDeclaration',
  'ImportExpression',
  'ExportAllDeclaration',
  'TaggedTemplateExpression',
  'Directive',
])

/**
 * Hardcoded user-visible text in one `.ts` or `.tsx` file. In JSX: text, string literals in text attributes (title,
 * placeholder, aria-label, label, alt, tooltip) and `toast(…)`. In all code (plain `.ts` files and the code around the
 * JSX): a string or template that reads like a sentence ("Could not save your name.", `How ${name} did`), and a
 * capitalised word that is returned, chosen, assigned or listed (`checked ? 'Reopen' : …`, `label: 'Missed'`); error
 * messages count, since the web app shows them. Not counted: types, object keys, comparisons and `case` labels,
 * imports, logs, class names, URLs, ids and keys (PLUMBING_KEYS), DOM, storage and URL plumbing (PLUMBING_CALLS),
 * keyboard keys, keys passed to `t()`, never-translate words alone (brand names), and whatever an `// i18n-ignore:`
 * comment covers.
 */
export function findHardcoded(
  file: string,
  source: string,
  ignore: ReadonlySet<string> = new Set(),
  options: {
    /** Only text inside what this accepts counts (findMessageText); everything by default. */
    within?: (stack: readonly Node[]) => boolean
    /**
     * Emails and notifications: also what a plumbing method is called on (`['A sentence.', …].join('\n')`), whose
     * arguments alone are plumbing. Off for the web app's ratchet.
     */
    readReceivers?: boolean
  } = {},
): Hardcoded[] {
  const { within, readReceivers = false } = options
  const { program, comments } = parse(file, source)
  const skip = ignoredStarts(source, comments)
  const hits: Hardcoded[] = []
  const clean = (text: string | null) => (text ? text.replace(/\s+/g, ' ').trim() : '')
  let ancestors: readonly Node[] = []
  const plumbing = new Set<Node>()
  const counts = (text: string | null) => {
    const trimmed = clean(text)
    return !!trimmed && hasLetters(trimmed) && !ignore.has(trimmed) && (!within || within(ancestors))
  }
  const add = (node: Node, text: string | null) => hits.push({ line: lineOf(source, node.start), text: clean(text) })

  walkWithParents(program, (node, parent, stack) => {
    ancestors = stack
    if (skip.has(node.start) || SKIPPED.has(node.type) || plumbing.has(node)) return false
    if (node.type.startsWith('TS') && !KEEP_TS.has(node.type)) return false
    switch (node.type) {
      case 'JSXText':
        if (counts(node.value)) add(node, node.value)
        return false
      case 'JSXExpressionContainer':
        // {'text'} as a child (an attribute's value is the attribute's business, below).
        if (node.expression?.type !== 'Literal' || parent?.type === 'JSXAttribute') return true
        if (typeof node.expression.value === 'string' && counts(node.expression.value)) add(node, node.expression.value)
        return false
      case 'JSXAttribute': {
        const name = typeof node.name.name === 'string' ? node.name.name : ''
        if (TEXT_ATTRIBUTES.has(name)) {
          if (!counts(textOf(node.value))) return true
          add(node, textOf(node.value))
          return false
        }
        // className, href, data-*, key and any other plain attribute: plumbing. Expressions (items={[…]}) are read.
        return !(PLUMBING_KEYS.has(name) || name.startsWith('data-') || node.value?.type === 'Literal')
      }
      case 'CallExpression': {
        const name = callName(node)
        if (name === 'toast' && counts(textOf(node.arguments[0]))) {
          add(node, textOf(node.arguments[0]))
          return false
        }
        if (name && (KEY_CALLS.has(name) || PLUMBING_CALLS.has(name))) {
          // The arguments are plumbing ('\n' in `.join('\n')`, a key in `t('…')`); what the method is called on is
          // not: `['A sentence.', …].join('\n')` is read.
          if (!readReceivers) return false
          for (const arg of node.arguments) plumbing.add(arg)
          return node.callee?.type === 'MemberExpression'
        }
        return !(node.callee?.type === 'MemberExpression' && LOG_OBJECT.test(keyName(node.callee.object) ?? ''))
      }
      case 'NewExpression':
        return !PLUMBING_CALLS.has(callName(node) ?? '')
      case 'ExportNamedDeclaration':
        return !node.source
      case 'ExpressionStatement':
        return !node.directive
      case 'BinaryExpression':
        return !['===', '!==', '==', '!=', 'in'].includes(node.operator)
      case 'Literal':
      case 'TemplateLiteral': {
        const text = node.type === 'Literal' ? (typeof node.value === 'string' ? node.value : null) : textOf(node)
        // A template's arguments are read too (`How ${name || 'the assistant'} did`), unless it is plumbing (below).
        const inner = node.type === 'TemplateLiteral'
        if (!text || !counts(text)) return inner
        if (parent?.type === 'SwitchCase' && parent.test === node) return false
        if (parent?.type === 'Property' && (parent.key === node || PLUMBING_KEYS.has(keyName(parent.key) ?? '')))
          return false
        if (parent?.type === 'MemberExpression' && parent.property === node) return false
        if (
          parent?.type === 'AssignmentExpression' &&
          parent.left?.type === 'MemberExpression' &&
          PLUMBING_KEYS.has(keyName(parent.left.property) ?? '')
        )
          return false
        const trimmed = clean(text)
        if (
          looksLikeProse(trimmed) ||
          (within && looksLikeWords(trimmed)) ||
          (looksLikeWord(trimmed) && inTextPosition(node, parent))
        )
          add(node, trimmed)
        return inner
      }
      default:
        return true
    }
  })
  return hits
}

/** How many hardcoded user-visible strings one file has (findHardcoded). */
export function countHardcoded(file: string, source: string, ignore: ReadonlySet<string> = new Set()): number {
  return findHardcoded(file, source, ignore).length
}

/** Every file under `roots` with hardcoded text, and that text. */
export function hardcodedIn(
  roots: readonly string[],
  ignore: ReadonlySet<string>,
  options: { readReceivers?: boolean } = {},
): Record<string, Hardcoded[]> {
  const out: Record<string, Hardcoded[]> = {}
  for (const root of roots)
    for (const file of sourceFiles(root)) {
      const hits = findHardcoded(file, readFileSync(`${REPO_DIR}${file}`, 'utf8'), ignore, options)
      if (hits.length) out[file] = hits
    }
  return out
}

/** The ratchet's counts for every file of the web app that has any. */
export function hardcodedCounts(ignore: ReadonlySet<string>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(hardcodedIn([RATCHET_ROOT], ignore)).map(([file, hits]) => [file, hits.length]),
  )
}

/**
 * Emails and push notifications (checked, like the web app): every word of them is written in apps/api/src/emails, in
 * the recipient's language with getT(locale) (docs/translations.md, "Emails and notifications"). Any hardcoded English
 * there fails the check, and so does formatting without the reader's locale.
 */
export const MESSAGE_ROOTS = ['apps/api/src/emails'] as const

/**
 * The rest of the server (checked for what goes into a message): the API, the voice agent and the packages. Their own
 * English (API errors, logs, the CLI) stays English, but text handed straight to a sender or set as an email's subject
 * belongs in apps/api/src/emails.
 */
export const MESSAGE_SENDER_ROOTS = ['apps/api/src', 'apps/agent/src', 'packages'] as const

/** Calls that send or render a message: text in their arguments is what a person reads. */
const MESSAGE_CALLS = new Set(['sendNotice', 'alertInstanceAdmins', 'renderEmail', 'adminAlertEmail'])
/**
 * Calls named like a sender's: a message only when made on a sender (`emailSender.send`, `transport.sendMail`) or
 * given the message itself (`send({ to, subject, … })`); `http.send(url, …)` and `send('reading…', url)` are not.
 */
const SEND_CALLS = new Set(['send', 'sendMail', 'sendNotification'])
const SENDER_OBJECT = /(?:sender|senders|mailer|transport|emails?|webpush)$/i

const isMessageCall = (node: Node) => {
  const name = callName(node) ?? ''
  if (MESSAGE_CALLS.has(name)) return true
  if (!SEND_CALLS.has(name)) return false
  const object = node.callee?.type === 'MemberExpression' ? keyName(node.callee.object) : null
  return SENDER_OBJECT.test(object ?? '') || node.arguments[0]?.type === 'ObjectExpression'
}
/** Properties that hold an email's parts. */
const MESSAGE_KEYS = new Set(['subject', 'preheader', 'heading', 'eyebrow', 'html'])

const TEXT_VALUES = ['Literal', 'TemplateLiteral', 'ConditionalExpression', 'BinaryExpression', 'CallExpression']
const propertyNames = (node: Node) => new Set(node.properties.map((p: Node) => keyName(p.key)))

/**
 * An object with a text `subject` (`{ to, subject: …, text: … }`): an email; or with a `title` and a `body` (a push
 * notification's payload). Every part of it is read by a person.
 */
const isEmailObject = (node: Node) =>
  node.type === 'ObjectExpression' &&
  ((propertyNames(node).has('title') && propertyNames(node).has('body')) ||
    node.properties.some(
      (p: Node) => p.type === 'Property' && keyName(p.key) === 'subject' && TEXT_VALUES.includes(p.value?.type),
    ))

/** Calls whose later arguments are not text people read: `sendNotice(email, 'what, for the log')`. */
const FIRST_ARGUMENT_ONLY = new Set(['sendNotice'])

const inMessage = (stack: readonly Node[]) =>
  stack.some(
    (node, i) =>
      ((node.type === 'CallExpression' || node.type === 'NewExpression') &&
        isMessageCall(node) &&
        (!FIRST_ARGUMENT_ONLY.has(callName(node) ?? '') || stack[i + 1] === node.arguments[0])) ||
      (node.type === 'Property' && MESSAGE_KEYS.has(keyName(node.key) ?? '')) ||
      isEmailObject(node),
  )

/**
 * Hardcoded text that goes into an email or notification from outside apps/api/src/emails: in the arguments of a
 * sender (`sender.send({ subject: 'Hi', text: '…' })`, `sendNotice`, `alertInstanceAdmins`), in an object with a text
 * `subject` (an email built elsewhere: `return { subject: …, text: … }`), or as the value of an email's `subject`,
 * `preheader`, `heading`, `eyebrow` or `html`. `// i18n-ignore: <why>` covers a real exception.
 */
export function findMessageText(file: string, source: string, ignore: ReadonlySet<string> = new Set()): Hardcoded[] {
  if (
    !/\b(?:send\w*|alertInstanceAdmins|renderEmail|adminAlertEmail)\(|\b(?:subject|preheader|heading|eyebrow|html|body)\b/.test(
      source,
    )
  )
    return []
  return findHardcoded(file, source, ignore, { within: inMessage, readReceivers: true })
}

/** Every email and notification text that is not translated: all of MESSAGE_ROOTS, and findMessageText elsewhere. */
export function messageTextIn(ignore: ReadonlySet<string>): Record<string, Hardcoded[]> {
  const out: Record<string, Hardcoded[]> = hardcodedIn(MESSAGE_ROOTS, ignore, { readReceivers: true })
  const checked = new Set(Object.keys(out))
  for (const root of MESSAGE_SENDER_ROOTS)
    for (const file of sourceFiles(root)) {
      if (checked.has(file) || MESSAGE_ROOTS.some(r => file.startsWith(`${r}/`))) continue
      const hits = findMessageText(file, readFileSync(`${REPO_DIR}${file}`, 'utf8'), ignore)
      if (hits.length) out[file] = hits
    }
  return out
}

/**
 * Server-side text (reported, not yet checked): the shared actions (provider status, carrier steps, field labels,
 * countries, voice pipeline) and the API (messages the web app shows, emails). English for now; docs/translations.md,
 * "Server-side text", has the plan.
 */
export const SERVER_TEXT_ROOTS = ['packages/actions/src', 'apps/api/src'] as const

export interface FormattingUse {
  file: string
  line: number
  code: string
  /** `browser`: no locale, so the browser's language (an error). `fixed`: a locale written in the code (a warning). */
  kind: 'browser' | 'fixed'
}

const INTL_FORMATTERS = new Set([
  'DateTimeFormat',
  'NumberFormat',
  'RelativeTimeFormat',
  'ListFormat',
  'DisplayNames',
  'PluralRules',
  'Collator',
  'Segmenter',
  'DurationFormat',
])
const TO_LOCALE = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'])

/** A locale argument that is not the app's: none, `undefined`, `[]`, or one written in the code (`'en-US'`). */
function localeArgument(arg: Node): 'browser' | 'fixed' | null {
  if (!arg || (arg.type === 'Identifier' && arg.name === 'undefined')) return 'browser'
  if (arg.type === 'ArrayExpression') {
    if (!arg.elements.length) return 'browser'
    return arg.elements.every((e: Node) => literalValues(e)) ? 'fixed' : null
  }
  return literalValues(arg) ? 'fixed' : null
}

/**
 * Formatting outside the app's language in one web app file (CLAUDE.md rule 10: `useFormat()`, `fmt()` or
 * `intlLocale()`): an `Intl` formatter or `toLocale…String()` with no locale, `undefined` or `[]` formats in the
 * browser's language; one with a locale written in the code ignores the reader's. Reading the browser's own time
 * zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) is not formatting. `// i18n-ignore: <why>` covers a fixed
 * locale that is on purpose (a machine format such as `en-CA` for ISO dates).
 */
export function findFormatting(file: string, source: string): FormattingUse[] {
  if (!/\bIntl\.|\.toLocale(?:Date|Time)?String\(/.test(source)) return []
  const { program, comments } = parse(file, source)
  const skip = ignoredStarts(source, comments)
  const out: FormattingUse[] = []
  walkWithParents(program, (node, parent) => {
    if (skip.has(node.start)) return false
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return true
    const callee = node.callee
    if (callee?.type !== 'MemberExpression') return true
    const property = callee.property?.name
    let kind: 'browser' | 'fixed' | null = null
    if (callee.object?.type === 'Identifier' && callee.object.name === 'Intl' && INTL_FORMATTERS.has(property)) {
      const zoneLookup =
        parent?.type === 'MemberExpression' && parent.object === node && parent.property?.name === 'resolvedOptions'
      if (!zoneLookup) kind = localeArgument(node.arguments[0])
    } else if (node.type === 'CallExpression' && TO_LOCALE.has(property)) kind = localeArgument(node.arguments[0])
    if (kind)
      out.push({
        file,
        line: lineOf(source, node.start),
        code: source.slice(node.start, node.end).split('\n')[0] ?? '',
        kind,
      })
    return true
  })
  return out
}
