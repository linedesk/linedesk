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
    case 'unrecognized_keys':
      return `has unknown ${issue.keys.length === 1 ? 'field' : 'fields'} ${issue.keys.join(', ')}`
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
      const field = issue.path.map(String).join('.')
      if (issue.code === 'custom') return sentence(field ? `${field}: ${issue.message}` : issue.message)
      const missing = issue.path.length > 0 && valueAt(input, issue.path) === undefined
      return sentence(field ? `${field} ${problem(issue, missing)}` : problem(issue, missing))
    })
    .join(' ')
}
