// Runtime provider failures (LIN-111), in one place: the API's own provider calls (email, language model, voice
// previews, calendar, recording storage), the voice agent's reports (call.reportVoiceFailure, provider.reportOk) and
// provider tests record here. One row per failing provider (provider_failures): the latest reason and message,
// since when, how often since the last success. A success clears it. Server admin › Providers, the admin overview and
// the setup checklist read it; the instance admins get one email when a provider starts failing, not one per call, and
// none when email itself is what fails (they see it in the app).
import {
  PROVIDER_FAILURE_MESSAGE_MAX,
  type ProviderFailure,
  type ProviderFailureReason,
  type ProviderFailureSource,
  type ProviderTestData,
  type ProviderAudience,
  type ProviderCategory,
  type ProviderName,
  isPerCallProviderError,
  passingProviderFailure,
  providerNames,
  providerSpec,
  providersIn,
} from '@linedesk/actions'
import { provider_failures, type Tx } from '@linedesk/db'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { alertInstanceAdmins, plainSnippet } from './admin-alerts.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { onEmailResult } from './email.ts'
import { ResendError } from './email-resend.ts'
import { type AdminAlertText, providerFailureAlert } from './emails/alerts.ts'
import type { Handler } from './handler-context.ts'
import type { ProviderProblem } from './provider-errors.ts'
import { activeProvider, resolveProvider } from './provider-settings.ts'
import { missingFields, testProvider } from './provider-test.ts'

const isProvider = (name: string): name is ProviderName => (providerNames as string[]).includes(name)
const clip = (text: string) =>
  text.length > PROVIDER_FAILURE_MESSAGE_MAX ? `${text.slice(0, PROVIDER_FAILURE_MESSAGE_MAX - 1)}…` : text

/** The admins hear about failures the system ran into, not about a test they ran themselves. */
const alerts = (provider: ProviderName, source: ProviderFailureSource) =>
  source !== 'test' && providerSpec(provider).category !== 'email'

/** The alert about a provider that started failing; exported for tests. */
export function providerFailureEmail(provider: ProviderName, problem: ProviderProblem): AdminAlertText {
  return providerFailureAlert(
    providerSpec(provider).label,
    problem.reason,
    plainSnippet(problem.message, PROVIDER_FAILURE_MESSAGE_MAX),
  )
}

/** Who reads a provider failure in the app: an instance admin can fix it under Server admin › Providers. */
export const audienceOf = (actor: Pick<Actor, 'permissions'>): ProviderAudience =>
  actor.permissions.includes('instance:admin') ? 'admin' : 'member'

/** Where a failure happened: a workspace and call, or nothing for the install itself. */
export type FailureScope = { workspaceId?: string | null; callId?: string | null }

/** How long a diagnosis is reused per provider: at most one provider test per provider in this window. */
export const DIAGNOSIS_MS = 5 * 60_000

/** Runs a provider's own test; null when it cannot run (no keys). Replaced in tests. */
export type Diagnose = (provider: ProviderName) => Promise<ProviderTestData | null>

const diagnoses = new Map<ProviderName, { at: number; result: Promise<ProviderTestData | null> }>()

/** The provider's test with the keys in effect, at most once per provider in DIAGNOSIS_MS (shared by every caller). */
export const diagnoseProvider: Diagnose = provider => {
  const cached = diagnoses.get(provider)
  if (cached && Date.now() - cached.at < DIAGNOSIS_MS) return cached.result
  const result = (async () => {
    const config = await resolveProvider(db, provider)
    return missingFields(provider, config).length ? null : await testProvider(provider, config)
  })().catch(() => null)
  diagnoses.set(provider, { at: Date.now(), result })
  return result
}

/** Forgets the cached diagnoses (a success, tests). */
export const forgetDiagnoses = (providers?: readonly ProviderName[]) => {
  if (!providers) diagnoses.clear()
  else for (const provider of providers) diagnoses.delete(provider)
}

/**
 * A vague failure ("TTS stream completed but no audio") made precise: the provider's own cheap test runs once, and
 * when it fails for a clear reason (quota used up, key rejected, voice gone), that reason and its message replace
 * the vague ones. Anything else keeps the failure as reported.
 */
export async function refineProblem(
  provider: ProviderName,
  problem: ProviderProblem,
  diagnose: Diagnose = diagnoseProvider,
): Promise<ProviderProblem> {
  // Only a reason that says something went wrong, not why: a diagnosis may find the cause.
  if (!passingProviderFailure(problem.reason)) return problem
  const found = await diagnose(provider)
  if (!found || found.ok || !found.reason || passingProviderFailure(found.reason)) return problem
  return { reason: found.reason, message: found.message }
}

export type RecordOptions = { scope?: FailureScope; now?: Date; diagnose?: Diagnose }

/**
 * Records a failure: a new row starts the streak, else the count goes up and the latest reason and message replace
 * the older ones. A vague reason is first refined by the provider's own test (refineProblem; not for a test, which
 * is that diagnosis). The first failure of a streak that was not the admins' own test sends the one email. Returns
 * the reason and message as stored, so the caller (the voice agent, the test call) can show the refined one.
 */
export async function recordProviderFailure(
  tx: Tx,
  provider: ProviderName,
  reported: ProviderProblem,
  source: ProviderFailureSource,
  { scope = {}, now = new Date(), diagnose = diagnoseProvider }: RecordOptions = {},
): Promise<ProviderProblem & { alerted: boolean }> {
  // A race in one call's conversation (two replies at once) is ours, not the provider failing: logged, not recorded.
  if (isPerCallProviderError(reported.message)) {
    console.warn(`${provider}: per-call error, not recorded as a provider failure: ${clip(reported.message)}`)
    return { reason: reported.reason, message: clip(reported.message), alerted: false }
  }
  const problem = source === 'test' ? reported : await refineProblem(provider, reported, diagnose)
  const at = now.toISOString()
  const message = clip(problem.message)
  const stored = { reason: problem.reason, message }
  const where = { workspace_id: scope.workspaceId ?? null, call_id: scope.callId ?? null }
  await tx
    .insert(provider_failures)
    .values({ provider, ...stored, source, since: at, last_at: at, count: 1, ...where })
    .onConflictDoUpdate({
      target: provider_failures.provider,
      set: { ...stored, source, last_at: at, count: sql`${provider_failures.count} + 1`, ...where },
    })
  if (!alerts(provider, source)) return { ...stored, alerted: false }
  // Claims the email for this streak: of two failures at once, only one gets the row back.
  const claimed = await tx
    .update(provider_failures)
    .set({ alerted_at: at })
    .where(and(eq(provider_failures.provider, provider), isNull(provider_failures.alerted_at)))
    .returning({ provider: provider_failures.provider })
  if (!claimed.length) return { ...stored, alerted: false }
  await alertInstanceAdmins(providerFailureEmail(provider, stored))
  return { ...stored, alerted: true }
}

/** A success: the providers' failures are over. */
export async function clearProviderFailures(tx: Tx, providers: readonly ProviderName[]) {
  forgetDiagnoses(providers)
  if (providers.length) await tx.delete(provider_failures).where(inArray(provider_failures.provider, [...providers]))
}

/** Every provider failing now, the most recent first. */
export async function listProviderFailures(tx: Tx): Promise<ProviderFailure[]> {
  const rows = await tx.select().from(provider_failures)
  return (
    rows
      // Older rows of a per-call race (before LIN-249 they were recorded): not a provider failure.
      .filter(row => isProvider(row.provider) && !isPerCallProviderError(row.message))
      .map(row => {
        const provider = row.provider as ProviderName
        const { label, category } = providerSpec(provider)
        return {
          provider,
          category,
          label,
          reason: row.reason as ProviderFailureReason,
          message: row.message,
          source: row.source as ProviderFailureSource,
          since: new Date(row.since).toISOString(),
          last_at: new Date(row.last_at).toISOString(),
          count: row.count,
          workspace_id: row.workspace_id,
          call_id: row.call_id,
        }
      })
      .sort((a, b) => b.last_at.localeCompare(a.last_at))
  )
}

/**
 * For the API's own provider calls: records on its own connection, so the record stays when the request's
 * transaction rolls back, and never throws, so recording cannot break the call it is about.
 */
export function noteProviderFailure(
  provider: ProviderName,
  problem: ProviderProblem,
  source: ProviderFailureSource,
  scope: FailureScope = {},
) {
  return recordProviderFailure(db, provider, problem, source, { scope }).catch(err =>
    console.error(`could not record the ${provider} failure`, err),
  )
}

/** For the API's own provider calls: a success clears the failure. Never throws. */
export function noteProviderOk(providers: ProviderName | readonly ProviderName[]) {
  const list = typeof providers === 'string' ? [providers] : providers
  return clearProviderFailures(db, list).catch(err => console.error('could not clear a provider failure', err))
}

/**
 * Whether a lasting provider failure stops calls from being answered (GET /v1/assistant/status): every voice
 * pipeline (the three stages, the realtime model) is missing or has an active provider with a recorded failure that
 * won't pass by itself (a used-up quota, a rejected key, a voice that is gone). A passing problem (not reachable, a
 * timeout) does not count: the next call may well work.
 */
export async function voiceFailing(tx: Tx): Promise<boolean> {
  const rows = await tx
    .select({ provider: provider_failures.provider, reason: provider_failures.reason })
    .from(provider_failures)
  const failing = new Set(
    rows.filter(r => !passingProviderFailure(r.reason as ProviderFailureReason)).map(r => r.provider),
  )
  if (!failing.size) return false
  // One after the other: the queries share the transaction.
  const broken = async (categories: readonly ProviderCategory[]) => {
    for (const category of categories) {
      const active = await activeProvider(tx, category).catch(() => null)
      if (!active || failing.has(active.provider)) return true
    }
    return false
  }
  return (await broken(['stt', 'llm', 'tts'])) && (await broken(['realtime']))
}

/** Email: one sends at a time, so a sent email clears every email provider. */
export const emailProviders = () => providersIn('email')

/**
 * The voice agent's reports (packages/actions/src/provider-health.ts). In the action's transaction: the report is
 * the whole action. The agent's text is kept short and shown as text only (admin page, plain email).
 */
export const providerHealthHandlers: Record<string, Handler> = {
  'provider.reportOk': async ({ tx }, input: { providers: ProviderName[] }) => {
    await clearProviderFailures(tx, input.providers)
    return { rows: {}, data: { providers: input.providers } }
  },
}

/**
 * What a failed email says about the mail service, or null when it is about that one email (an unknown recipient):
 * only the login, the connection, a sending limit or a refused sender mean the service is failing. Fixed texts:
 * the server's answer can quote addresses.
 */
export function emailProblem(e: unknown): ProviderProblem | null {
  // Resend over HTTPS (email-resend.ts) says what its refusal means itself.
  if (e instanceof ResendError) return e.reason ? { reason: e.reason, message: e.message } : null
  const err = (e ?? {}) as { code?: string; responseCode?: number; response?: string; message?: string }
  const text = `${err.response ?? ''} ${err.message ?? ''}`
  const status = err.responseCode ? ` (SMTP ${err.responseCode})` : ''
  if (err.code === 'EAUTH' || [530, 534, 535].includes(err.responseCode ?? 0))
    return {
      reason: 'auth',
      message: `The mail server refused the login${status}. Check the key or password under Server admin › Providers › Email.`,
    }
  if (
    ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(err.code ?? '') ||
    /did not finish within/.test(text)
  )
    return {
      reason: 'network',
      message: 'Could not reach the mail server. Check its host and port, and that this server may connect to it.',
    }
  if (err.responseCode && /quota|limit|exceeded|suspend|daily|too many/i.test(text))
    return {
      reason: 'quota',
      message: `The mail service refused to send more${status}: its quota or sending limit is reached. Check the plan or limits at the mail service.`,
    }
  if (
    (err.responseCode ?? 0) >= 500 &&
    /sender|from address|domain|verif|not authori[sz]ed to send|identity/i.test(text)
  )
    return {
      reason: 'config',
      message: `The mail service refused the sender${status}. Verify the From address or its domain at the mail service, or change From under Server admin › Providers › Email.`,
    }
  return null
}

/** Records how emails end: a sent one clears the email provider's failure, a failing service records one. */
export function watchEmailFailures(provider: () => ProviderName) {
  onEmailResult(result => {
    if (result.ok) void noteProviderOk(emailProviders())
    else {
      const problem = emailProblem(result.error)
      if (problem) void noteProviderFailure(provider(), problem, 'email')
    }
  })
}
