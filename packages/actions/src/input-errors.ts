// Invalid action input, said as a plain sentence: "Role must be one of admin, member." instead of
// Zod's JSON list of issues. The API answers 422 with it; the web app shows it as it is.
import type { z } from 'zod'

type Issue = z.core.$ZodIssue

const n = (value: unknown) => Number(value)

/** What is wrong with one field, without the field's name. */
function problem(issue: Issue, missing: boolean): string {
  if (missing && (issue.code === 'invalid_value' || issue.code === 'invalid_type')) return 'is required'
  switch (issue.code) {
    case 'invalid_value':
      return `must be one of ${issue.values.map(String).join(', ')}`
    case 'invalid_type':
      return `must be ${issue.expected === 'array' ? 'a list' : `a ${issue.expected}`}`
    case 'too_small':
      if (issue.origin === 'string') return n(issue.minimum) <= 1 ? 'must not be empty' : `must have at least ${issue.minimum} characters`
      if (issue.origin === 'array' || issue.origin === 'set') return `needs at least ${issue.minimum}`
      return `must be at least ${issue.minimum}`
    case 'too_big':
      if (issue.origin === 'string') return `must have at most ${issue.maximum} characters`
      if (issue.origin === 'array' || issue.origin === 'set') return `takes at most ${issue.maximum}`
      return `must be at most ${issue.maximum}`
    case 'invalid_format':
      return issue.format === 'email' ? 'must be an email address' : 'has the wrong format'
    default:
      return issue.message.charAt(0).toLowerCase() + issue.message.slice(1)
  }
}

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`

/** The value at a path of the input, or undefined when it is not there. */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let at = input
  for (const key of path) at = at && typeof at === 'object' ? (at as Record<PropertyKey, unknown>)[key] : undefined
  return at
}

/**
 * One sentence per problem, e.g. "Role must be one of admin, member. Email must be an email address."
 * `input` is what was sent: a field that is missing is "required".
 */
export function inputErrorText(error: z.ZodError, input?: unknown): string {
  return error.issues
    .map(issue => {
      if (issue.code === 'unrecognized_keys') return unknownFieldsText(issue.keys)
      const field = fieldLabel(issue.path)
      if (issue.code === 'custom') return sentence(field ? `${field}: ${issue.message}` : issue.message)
      // A format the schema explains itself ("The Account SID starts with AC …"): its words, not "has the wrong format".
      if (issue.code === 'invalid_format' && !/^invalid/i.test(issue.message)) return sentence(issue.message)
      const missing = issue.path.length > 0 && valueAt(input, issue.path) === undefined
      return sentence(field ? `${field} ${problem(issue, missing)}` : problem(issue, missing))
    })
    .join(' ')
}

/** Short words that read as one capitalised word ("Account SID", not "Account sid"). */
const ACRONYMS = new Set(['id', 'ids', 'sid', 'url', 'uri', 'api', 'sip', 'ip', 'sms', 'tts', 'llm'])

/**
 * A field as people say it, without the path to it: `values.account_sid` is "Account SID",
 * `memberId` "Member ID", `hours.2.start` "Start". Empty for the input as a whole.
 */
export function fieldLabel(path: readonly PropertyKey[]): string {
  const name = [...path].reverse().find(key => typeof key === 'string' && !/^\d+$/.test(key))
  if (typeof name !== 'string') return ''
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(word => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()))
  return words.join(' ')
}

/** Fields an action does not take, by their exact names (a caller has to fix the spelling). */
export function unknownFieldsText(keys: readonly string[]): string {
  return keys.length === 1
    ? `This action does not take the field ${keys[0]}.`
    : `This action does not take the fields ${keys.join(', ')}.`
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * The fields that were sent but are not in the parsed input (Zod drops what a schema does not
 * know), as paths like `voice.speed`. Records keep every key, so they never count.
 */
export function droppedFields(sent: unknown, parsed: unknown, path = ''): string[] {
  if (Array.isArray(sent) && Array.isArray(parsed))
    return sent.flatMap((item, i) => droppedFields(item, parsed[i], `${path}${i}.`))
  if (!isPlainObject(sent) || !isPlainObject(parsed)) return []
  return Object.keys(sent).flatMap(key =>
    key in parsed ? droppedFields(sent[key], parsed[key], `${path}${key}.`) : [`${path}${key}`],
  )
}
