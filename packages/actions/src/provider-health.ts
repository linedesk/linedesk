// Provider health (LIN-111): what a provider test found, and the failures the API and the voice agent
// record per provider while they work (apps/api/src/provider-failures.ts). A used-up quota, a rejected key or a
// model that no longer exists shows up in Server admin › Providers and the admin overview instead of failing silently.
import { type MessageKey, msg } from '@linedesk/i18n'
import { english, type Words } from './words.ts'
import { z } from 'zod'
import { type ProviderCategory, type ProviderName, providerNames } from './admin.ts'
import { defineAction } from './define.ts'

/**
 * Why a provider failed: one vocabulary for provider tests, the API's own provider calls and the voice agent (LIN-111,
 * LIN-107). `quota`: credit, quota or balance used up, or billing stopped; `auth`: the key or secret is rejected;
 * `permission`: the key works but lacks a permission or scope; `not_found`: a model, voice, bucket or account it
 * names does not exist; `config`: the provider refused a setting (sender domain not verified, a bad value);
 * `network`: not reachable or failing on its side (5xx, rate limited); `timeout`: no answer in time; `no_output`: it
 * answered but with nothing usable (no audio, no transcript, an empty reply); `unknown`: anything else.
 */
export const providerFailureReasons = [
  'quota',
  'auth',
  'permission',
  'not_found',
  'config',
  'network',
  'timeout',
  'no_output',
  'unknown',
] as const
export type ProviderFailureReason = (typeof providerFailureReasons)[number]

export const providerFailureReasonKeys: Record<ProviderFailureReason, MessageKey> = {
  quota: msg('errors.provider.reason.quota'),
  auth: msg('errors.provider.reason.auth'),
  permission: msg('errors.provider.reason.permission'),
  not_found: msg('errors.provider.reason.notFound'),
  config: msg('errors.provider.reason.config'),
  network: msg('errors.provider.reason.network'),
  timeout: msg('errors.provider.reason.timeout'),
  no_output: msg('errors.provider.reason.noOutput'),
  unknown: msg('errors.provider.reason.unknown'),
}
/** A failure reason in a few words ("Key rejected"), in the reader's language. */
export const providerFailureReasonLabel = (reason: ProviderFailureReason, words: Words = english) =>
  words.t(providerFailureReasonKeys[reason])

/** Codes and words in error text that mean credit, quota or billing, whatever the status. */
const QUOTA =
  /quota[_ ]exceeded|out of quota|insufficient_quota|exceeded your current quota|credit balance|insufficient[_ ]?(credits?|funds|balance)|out of credits|payment[_ ]required|billing|balance is too low|(?<!rate_)limit_exceeded|character_limit|usage limit|exceeds? (?:your )?(?:monthly )?limit|account (?:is )?suspended/i
const BAD_KEY = /invalid[_ ]?(api[_ ]?)?key|incorrect api key|unauthori[sz]ed|authenticat|invalid[_ ]token/i
const NOT_FOUND =
  /model_not_found|voice_not_found|not[_ ]found|does not exist|no such|unknown (model|voice)|invalid model|not a valid model/i
export const isQuotaText = (text: string) => QUOTA.test(text)

/**
 * The reason from what a provider answered: its HTTP status and its error text (a body, a WebSocket close reason).
 * The text is only searched for known codes, never shown. Shared by the API and the voice agent.
 */
export function providerFailureReason({
  status,
  text = '',
}: {
  status?: number | null
  text?: string
}): ProviderFailureReason {
  if (status === 402 || QUOTA.test(text)) return 'quota'
  if (
    (status === 401 || status === 403) &&
    /missing_permissions|missing the permission|insufficient[_ ]scope|insufficient permissions/i.test(text)
  )
    return 'permission'
  if (status === 401) return 'auth'
  if (status === 403) return BAD_KEY.test(text) ? 'auth' : 'permission'
  if (status === 404 || status === 410) return 'not_found'
  if (status === 400 || status === 422) return NOT_FOUND.test(text) ? 'not_found' : 'config'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 429 || (status && status >= 500)) return 'network'
  if (status) return 'unknown'
  // No status (a stream, a socket): the text alone.
  if (BAD_KEY.test(text)) return 'auth'
  if (NOT_FOUND.test(text)) return 'not_found'
  if (/timed? ?out|timeout|did not (answer|finish) within/i.test(text)) return 'timeout'
  if (/no audio|no output|empty (reply|response|answer)|no transcript/i.test(text)) return 'no_output'
  return 'unknown'
}

/** Who reads an error: an instance admin can fix a provider (Server admin › Providers), a member can only ask. */
export type ProviderAudience = 'admin' | 'member'

/** The problem per reason ("{label} rejected the key it was given."). */
const PROBLEM: Record<ProviderFailureReason, MessageKey> = {
  quota: msg('errors.provider.problem.quota'),
  auth: msg('errors.provider.problem.auth'),
  permission: msg('errors.provider.problem.permission'),
  not_found: msg('errors.provider.problem.notFound'),
  config: msg('errors.provider.problem.config'),
  network: msg('errors.provider.problem.network'),
  timeout: msg('errors.provider.problem.timeout'),
  no_output: msg('errors.provider.problem.noOutput'),
  unknown: msg('errors.provider.problem.unknown'),
}
/** What an admin does about a lasting problem, and what a member asks for; a passing one says to try again. */
const FIX: Partial<Record<ProviderFailureReason, { admin: MessageKey; member: MessageKey }>> = {
  quota: { admin: msg('errors.provider.fix.admin.quota'), member: msg('errors.provider.fix.member.quota') },
  auth: { admin: msg('errors.provider.fix.admin.auth'), member: msg('errors.provider.fix.member.key') },
  permission: { admin: msg('errors.provider.fix.admin.permission'), member: msg('errors.provider.fix.member.key') },
  not_found: { admin: msg('errors.provider.fix.admin.notFound'), member: msg('errors.provider.fix.member.setup') },
  config: { admin: msg('errors.provider.fix.admin.config'), member: msg('errors.provider.fix.member.setup') },
}

/**
 * What a provider failure means for the person who ran into it, and what they can do next: the one mapping from a
 * reason to user-facing text (LIN-111). `label` names the provider as the sentence starts, e.g. "ElevenLabs" or "The
 * phone carrier". Admins are pointed to Server admin › Providers, members to whoever runs the server; a passing problem
 * (not reachable, no answer in time) says to try again. Never quotes the provider's own text.
 */
export function providerFailureAdvice(
  reason: ProviderFailureReason,
  label: string,
  audience: ProviderAudience,
  words: Words = english,
): { problem: string; fix: string } {
  const fix = FIX[reason]
  return {
    problem: words.t(PROBLEM[reason], { label }),
    fix: fix
      ? words.t(fix[audience], { label })
      : words.t(audience === 'admin' ? 'errors.provider.fix.admin.passing' : 'errors.provider.fix.member.passing'),
  }
}

/** providerFailureAdvice as one sentence pair, ready to show. */
export function providerFailureText(
  reason: ProviderFailureReason,
  label: string,
  audience: ProviderAudience,
  words: Words = english,
): string {
  const { problem, fix } = providerFailureAdvice(reason, label, audience, words)
  return words.t('errors.provider.problemAndFix', { problem, fix })
}

/**
 * The reason in an error text that reached the browser (a rejection, an error body): its "HTTP 401" if it has one,
 * else its words. For call sites that only get text.
 */
export function providerFailureReasonOfText(text: string): ProviderFailureReason {
  const status = Number(/\bHTTP (\d{3})\b/.exec(text)?.[1]) || null
  return providerFailureReason({ status, text })
}

/**
 * Errors about one call's conversation, caused by how our voice agent drove it, not by the provider: the realtime
 * model refusing a second reply while one is still running, or a cancel with nothing to cancel. The provider works
 * (the call goes on), so these are logged and counted, never recorded as the provider failing (LIN-249).
 */
const PER_CALL_ERROR =
  /conversation_already_has_active_response|already has an active response|response_cancel_not_active|Cancellation failed: no active response/i
export const isPerCallProviderError = (text: string) => PER_CALL_ERROR.test(text)

/** The end of a provider test's message when an OAuth app's client ID or secret is wrong: "HubSpot rejected …". */
export const OAUTH_CLIENT_REJECTED = 'rejected the client ID or secret'

/**
 * The provider that rejected an OAuth app's client in a test message ("HubSpot"), or null: the web app says it in the
 * reader's language (LIN-370). The message itself stays English for logs and API clients.
 */
export function oauthClientRejectedBy(text: string): string | null {
  const line = text.trim().replace(/\.$/, '')
  if (!line.endsWith(` ${OAUTH_CLIENT_REJECTED}`)) return null
  return line.slice(0, -OAUTH_CLIENT_REJECTED.length - 1).trim() || null
}

/** The longest short error line (providerErrorSummary). */
export const PROVIDER_ERROR_SUMMARY_MAX = 120

/** Known error codes in a provider's text, said for people (one line each). */
const SUMMARIES: [RegExp, MessageKey][] = [
  [PER_CALL_ERROR, msg('errors.provider.summary.twoReplies')],
  [QUOTA, msg('errors.provider.summary.quota')],
  [/\b429\b|rate[_ ]limit|too many requests/i, msg('errors.provider.summary.quota')],
  [
    /\b401\b|invalid[_ ]?(api[_ ]?)?key|incorrect api key|unauthori[sz]ed|key rejected|rejected the key/i,
    msg('errors.provider.summary.key'),
  ],
]

/**
 * A provider's error text as one short human line (at most PROVIDER_ERROR_SUMMARY_MAX characters): a known code in
 * plain words, else the text's first sentence without any JSON or ids after it. The full text is for "Details".
 */
export function providerErrorSummary(text: string, words: Words = english): string {
  const known = SUMMARIES.find(([pattern]) => pattern.test(text))
  if (known) return words.t(known[1])
  // Up to the first JSON object or array: what follows is the provider's raw answer.
  const prose = text
    .split(/\s[{[]/, 1)[0]!
    .replace(/\s+/g, ' ')
    .trim()
  // The first sentence: up to ". " followed by a capital, or the end.
  const sentence = (/^.*?[.!?](?=\s+[A-Z]|$)/.exec(prose)?.[0] ?? prose).trim()
  const line = sentence || words.t('errors.provider.summary.error')
  return line.length > PROVIDER_ERROR_SUMMARY_MAX ? `${line.slice(0, PROVIDER_ERROR_SUMMARY_MAX - 1).trimEnd()}…` : line
}

/** Reasons that only say something went wrong at the provider, not that something there must be fixed. */
export const passingProviderFailure = (reason: ProviderFailureReason) =>
  reason === 'network' || reason === 'timeout' || reason === 'no_output' || reason === 'unknown'

/** A test's verdict: `warning` works now but needs attention soon (low balance, a trial account). */
export type ProviderCheckStatus = 'ok' | 'warning' | 'error'

/**
 * One failure as the voice agent reports it (`call.reportVoiceFailure`): which stage of the call, which provider,
 * why, and a short text naming the fix. The same shape as the agent's own failure event (LIN-107).
 */
export type ProviderFailureEvent = {
  stage?: ProviderCategory
  provider: ProviderName
  reason: ProviderFailureReason
  message: string
}

/** Where a recorded failure came from. */
export type ProviderFailureSource =
  | 'test'
  | 'health'
  | 'agent'
  | 'email'
  | 'llm'
  | 'voice'
  | 'calendar'
  | 'recording'
  | 'app'

/**
 * A provider that is failing now (table provider_failures): the latest failure, since when, how often since the last
 * success, and where the latest one happened (a workspace and call, or null: the install itself).
 */
export type ProviderFailure = {
  provider: ProviderName
  category: ProviderCategory
  label: string
  reason: ProviderFailureReason
  message: string
  source: ProviderFailureSource
  since: string
  last_at: string
  count: number
  workspace_id: string | null
  call_id: string | null
}

export const PROVIDER_FAILURE_MESSAGE_MAX = 300

const provider = z.enum(providerNames)

export const providerReportOk = defineAction({
  name: 'provider.reportOk',
  description: 'The voice agent reports providers that worked in a call: their recorded failure is cleared.',
  input: z.object({ providers: z.array(provider).min(1).max(10) }),
  permission: 'agent',
})
