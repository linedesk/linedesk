// Invalid action input, said as a plain sentence: "Role must be one of admin, member." instead of
// Zod's JSON list of issues. The API answers 422 with it in the caller's language (server.input.*); the web app shows
// it as it is. A schema's own message may be a key of the catalogs (`msg('server.input.enterName')`): it is written
// in the same language.
import { enMessages, type MessageKey, type MessageValues } from '@linedesk/i18n'
import type { z } from 'zod'
import { english, type Words } from './words.ts'

type Issue = z.core.$ZodIssue

const n = (value: unknown) => Number(value)

/** What is wrong with one field, as a whole sentence with the field's name (`field`: "the value" when there is none). */
function problem(issue: Issue, missing: boolean, field: string, words: Words): string {
  if (missing && (issue.code === 'invalid_value' || issue.code === 'invalid_type'))
    return words.t('server.input.required', { field })
  switch (issue.code) {
    case 'invalid_value':
      return words.t('server.input.oneOf', { field, values: issue.values.map(String).join(', ') })
    case 'invalid_type':
      return issue.expected === 'array'
        ? words.t('server.input.mustBeList', { field })
        : words.t('server.input.mustBeType', { field, type: issue.expected })
    case 'too_small':
      if (issue.origin === 'string')
        return n(issue.minimum) <= 1
          ? words.t('server.input.notEmpty', { field })
          : words.t('server.input.minChars', { field, count: n(issue.minimum) })
      if (issue.origin === 'array' || issue.origin === 'set')
        return words.t('server.input.minItems', { field, count: n(issue.minimum) })
      return words.t('server.input.min', { field, count: n(issue.minimum) })
    case 'too_big':
      if (issue.origin === 'string') return words.t('server.input.maxChars', { field, count: n(issue.maximum) })
      if (issue.origin === 'array' || issue.origin === 'set')
        return words.t('server.input.maxItems', { field, count: n(issue.maximum) })
      return words.t('server.input.max', { field, count: n(issue.maximum) })
    case 'invalid_format':
      return issue.format === 'email'
        ? words.t('server.input.email', { field })
        : words.t('server.input.format', { field })
    default:
      return words.t('server.input.fieldSays', {
        field,
        message: issue.message.charAt(0).toLowerCase() + issue.message.slice(1),
      })
  }
}

/**
 * A schema's own message: a key of the catalogs in the reader's words (with the issue's `params`, e.g.
 * `refine(…, { message: msg('server.input.periodTooLong'), params: { days: 92 } })`), else as it was written.
 */
const issueMessage = (message: string, words: Words, params?: Record<string, unknown>) =>
  message in enMessages ? words.t(message as MessageKey, params as MessageValues | undefined) : message

const sentence = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?。！？]$/.test(text) ? '' : '.'}`

/** The value at a path of the input, or undefined when it is not there. */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let at = input
  for (const key of path) at = at && typeof at === 'object' ? (at as Record<PropertyKey, unknown>)[key] : undefined
  return at
}

/**
 * One sentence per problem, e.g. "Role must be one of admin, member. Email must be an email address."
 * `input` is what was sent: a field that is missing is "required". `words`: the caller's language (English by default).
 */
export function inputErrorText(error: z.ZodError, input?: unknown, words: Words = english): string {
  return error.issues
    .map(issue => {
      if (issue.code === 'unrecognized_keys') return unknownFieldsText(issue.keys, words)
      const field = fieldLabel(issue.path)
      if (issue.code === 'custom') {
        const message = issueMessage(issue.message, words, issue.params)
        return sentence(field ? words.t('server.input.fieldSays', { field, message }) : message)
      }
      // A format the schema explains itself ("The Account SID starts with AC …"): its words, not "has the wrong format".
      if (issue.code === 'invalid_format' && !/^invalid/i.test(issue.message))
        return sentence(issueMessage(issue.message, words))
      const missing = issue.path.length > 0 && valueAt(input, issue.path) === undefined
      return sentence(problem(issue, missing, field || words.t('server.input.theValue'), words))
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

/** The `code` of a 422 for input fields an action does not take (ActionRejection). */
export const UNKNOWN_FIELDS = 'UNKNOWN_FIELDS'

/**
 * Actions that delete or end something for good (data, accounts, numbers, keys, access). Their input is strict: a field
 * they do not take is refused with 422 `UNKNOWN_FIELDS` for every caller, browser sessions and the voice agent too,
 * where other actions only drop it. A field renamed or dropped from such an action must never be read as its default
 * (security review F2 of #756). Each of these schemas ends in `.strict()` (input-errors.test.ts checks it).
 */
export const DESTRUCTIVE_ACTIONS = [
  'workspace.delete',
  'workspace.deleteOwn',
  'membership.remove',
  'team.removeMember',
  'team.leave',
  'phoneNumber.release',
  'apiKey.revoke',
  'personalKey.revoke',
  'agentSetup.revoke',
  'agentSetup.revokeWorkspace',
  'agentSetup.endOwnAccess',
  'webhook.delete',
  'integration.remove',
  'calendar.disconnect',
  'mail.disconnect',
  'user.resetPasskeys',
  'account.authenticatorRemove',
  'provider.clearKeys',
] as const

/** Fields an action does not take, by their exact names (a caller has to fix the spelling). */
export function unknownFieldsText(keys: readonly string[], words: Words = english): string {
  return words.t('server.input.unknownFields', { count: keys.length, fields: keys.join(', ') })
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
