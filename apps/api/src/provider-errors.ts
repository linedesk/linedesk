// What a provider's failed answer means (LIN-111): one mapping from HTTP status and error body to a reason
// (quota, auth, permission, not_found, config, network, unknown) and a fixed text that names the fix. Used by the
// provider test and by the API's own provider calls (provider-failures.ts). The provider's own text is only
// searched for known codes, never passed on: it can quote what was sent, keys included.
import {
  isQuotaText,
  type ProviderFailureReason,
  type ProviderName,
  providerFailureReason,
  providerSpec,
} from '@linedesk/actions'

export type ProviderProblem = { reason: ProviderFailureReason; message: string }

/** The reason of a failed answer (packages/actions: one vocabulary with the voice agent). */
export const reasonOf = (status: number, body = ''): ProviderFailureReason =>
  providerFailureReason({ status, text: body })

/** A fixed text per reason that says what to do, naming the provider and, when given, what failed. */
export function problemText(
  provider: ProviderName,
  reason: ProviderFailureReason,
  what?: string,
  status?: number,
): string {
  const { label } = providerSpec(provider)
  const http = status ? ` (HTTP ${status})` : ''
  const about = what ? ` (${what})` : ''
  const settings = `Admin › Providers › ${label}`
  switch (reason) {
    case 'quota':
      return `${label} quota or credit used up${http}${about}. Add credit or upgrade the plan in your ${label} account.`
    case 'auth':
      return `${label} rejected the key${http}. Enter a valid key under ${settings}.`
    case 'permission':
      return `${label} accepted the key but it lacks a permission${http}${about}. Give the key the access listed in the provider's help, or use an unrestricted key.`
    case 'not_found':
      return `${label} does not know ${what ?? 'what is set up'}${http}. Check the setting under ${settings}.`
    case 'config':
      return `${label} refused the request${http}${about}. Check the settings under ${settings}.`
    case 'timeout':
      return `${label} did not answer in time${http}${about}. If it stays, check ${label}'s status page.`
    case 'no_output':
      return `${label} answered with nothing usable${http}${about}. Its quota may be used up or a setting wrong: test it under ${settings}.`
    case 'network':
      return `${label} did not answer or failed on its side${http}${about}. If it stays, check ${label}'s status page.`
    default:
      return `${label} failed${http}${about}.`
  }
}

/** A failed HTTP answer (status and body text) as a problem. The body only classifies it. */
export function problemOfStatus(provider: ProviderName, status: number, body: string, what?: string): ProviderProblem {
  if (status === 429 && !isQuotaText(body))
    return {
      reason: 'network',
      message: `${providerSpec(provider).label} is rate limiting (HTTP 429), try again in a minute.`,
    }
  const reason = reasonOf(status, body)
  return { reason, message: problemText(provider, reason, what, status) }
}

/** A failed HTTP answer as a problem. Reads the body only to classify it. */
export async function problemOfResponse(
  provider: ProviderName,
  res: Response,
  what?: string,
): Promise<ProviderProblem> {
  return problemOfStatus(provider, res.status, await res.text().catch(() => ''), what)
}

/** A thrown error from a request (timeout, refused connection) as a problem. Never the error's own text. */
export function problemOfError(provider: ProviderName, e: unknown, what?: string): ProviderProblem {
  const { label } = providerSpec(provider)
  const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
  return {
    reason: timedOut ? 'timeout' : 'network',
    message: timedOut
      ? `${what ? `${label}: ${what}` : label} did not answer in time. If it stays, check ${label}'s status page and the server's connection.`
      : `Could not reach ${label}${what ? ` for ${what}` : ''}. Check the server's connection and ${label}'s status page.`,
  }
}

/** An error a provider call throws with its problem, so the caller can record it (provider-failures.ts). */
export class ProviderCallError extends Error {
  readonly provider: ProviderName
  readonly reason: ProviderFailureReason
  readonly status: number | undefined

  constructor(provider: ProviderName, problem: ProviderProblem, status?: number) {
    super(problem.message)
    this.name = 'ProviderCallError'
    this.provider = provider
    this.reason = problem.reason
    this.status = status
  }
}
