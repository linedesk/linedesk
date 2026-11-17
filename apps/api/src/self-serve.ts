// Self-serve sign-up on Linedesk Cloud (docs/billing.md §3.1, §3.2; PR 7). Open only while the billing provider in
// effect is Stripe, an instance admin turned `signup.selfServe` on, and (by default) Cloudflare Turnstile is set up.
//
// The flow: the sign-up page asks POST /v1/signup/code for an email code. Before a code goes out: the address's domain
// is checked against the disposable-mail list, the Turnstile token is verified, and the limits are counted in
// `signup_attempts` under one advisory lock (per address, per IP or IPv6 /64, and the install's hourly cap, which
// alerts the instance admins once an hour when hit). Only then is a code attempt recorded and the code sent through
// Better Auth's sign-in code, which creates the account when the code is entered: `mayCreateUser` (signup-gate.ts)
// lets an unknown address in only with such a recent attempt, so the normal sign-in page stays closed to new
// addresses. Signed in, the page runs `account.signUp`, which makes the bill and its one workspace in
// `pending_payment`; Checkout (PR 8) moves them on. A sign-up that never finishes Checkout is deleted after
// `pendingDays` by the daily sign-up sweep.
import { createHash } from 'node:crypto'
import { RADAR_RISK_LEVELS } from '@linedesk/actions'
import {
  instance_settings,
  organization,
  SIGNUP_DEFAULTS,
  SIGNUP_RULE_RANGES,
  type Db,
  type SignupRules,
  signup_attempts,
  type Tx,
} from '@linedesk/db'
import { and, count, eq, gte, sql } from 'drizzle-orm'
import { billingState } from './billing-settings.ts'
import { isBlockedDomain } from './disposable-domains.ts'
import { Reject } from './handler-context.ts'
import { queueBillingAlert } from './jobs.ts'
import { createRateLimiter } from './rate-limit.ts'
import { resolveProvider } from './provider-settings.ts'

/** The instance setting that opens self-serve sign-up ('on'; anything else or no row: off). Off by default. */
export const SELF_SERVE_KEY = 'signup.selfServe'
/** The install's sign-up limits (JSON) over SIGNUP_DEFAULTS, field by field like `billing.rules`. */
export const SIGNUP_RULES_KEY = 'signup.rules'
/** The hour (ISO, to the hour) the install's code cap last alerted the instance admins: once an hour at most. */
export const SIGNUP_CAP_ALERT_KEY = 'signup.capAlerted'

/** How long after a code was asked for on the sign-up page the account may be created (the code lives 10 minutes). */
export const SIGNUP_CODE_WINDOW_MS = 15 * 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

// --- Rules ----------------------------------------------------------------------------------------

const RANGES: Record<string, readonly [number, number]> = SIGNUP_RULE_RANGES

/** `stored` over the defaults, field by field; `problems` names what was ignored. */
export function mergeSignupRules(stored: unknown): { rules: SignupRules; problems: string[] } {
  const rules: SignupRules = { ...SIGNUP_DEFAULTS }
  const problems: string[] = []
  if (stored === undefined) return { rules, problems }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored))
    return { rules, problems: ['not an object'] }
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    const range = RANGES[key]
    if (range && Number.isInteger(value) && (value as number) >= range[0] && (value as number) <= range[1])
      (rules as Record<string, unknown>)[key] = value
    else if (key === 'turnstile' && typeof value === 'boolean') rules.turnstile = value
    else if (key === 'blockedDomains' && stringList(value, 1000))
      rules.blockedDomains = (value as string[]).map(d => d.trim().toLowerCase())
    else if (key === 'reviewRiskLevels' && stringList(value, 10)) rules.reviewRiskLevels = value as string[]
    else problems.push(key)
  }
  return { rules, problems }
}

const stringList = (value: unknown, max: number) =>
  Array.isArray(value) && value.length <= max && value.every(v => typeof v === 'string' && v.length <= 253)

/** A domain an install may block: letters, digits, dots and hyphens, with a dot (`example.com`). */
const DOMAIN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

/**
 * The fields of a change of `signup.rules` (Server admin › Billing, `signup.setRules`) that are out of range, of the
 * wrong type or unknown; null (back to the default) is always fine. Stricter than `mergeSignupRules`, which reads what
 * is stored: a blocked domain must look like one and a risk level must be one of Radar's.
 */
export function signupRulesProblems(change: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const [key, value] of Object.entries(change)) {
    if (value === null) {
      if (!(key in SIGNUP_DEFAULTS)) problems.push(key)
      continue
    }
    if (mergeSignupRules({ [key]: value }).problems.length) problems.push(key)
    else if (key === 'blockedDomains' && !(value as string[]).every(d => DOMAIN.test(d.trim().toLowerCase())))
      problems.push(key)
    else if (
      key === 'reviewRiskLevels' &&
      !(value as string[]).every(l => (RADAR_RISK_LEVELS as readonly string[]).includes(l))
    )
      problems.push(key)
  }
  return problems
}

/** What `signup.rules` stores (null: nothing, or not a JSON object) and the rules in effect over the defaults. */
export async function storedSignupRules(
  tx: Pick<Tx, 'select'>,
): Promise<{ stored: Record<string, unknown> | null; rules: SignupRules; problems: string[] }> {
  const [row] = await tx
    .select({ value: instance_settings.value })
    .from(instance_settings)
    .where(eq(instance_settings.key, SIGNUP_RULES_KEY))
  if (!row) return { stored: null, ...mergeSignupRules(undefined) }
  let stored: unknown
  try {
    stored = JSON.parse(row.value)
  } catch {
    stored = null
  }
  const isObject = typeof stored === 'object' && stored !== null && !Array.isArray(stored)
  return { stored: isObject ? (stored as Record<string, unknown>) : null, ...mergeSignupRules(stored) }
}

/** The sign-up rules in effect on this install. */
export async function signupRules(tx: Pick<Tx, 'select'>): Promise<SignupRules> {
  const { rules, problems } = await storedSignupRules(tx)
  if (problems.length)
    console.error(`sign-up rules: ignored ${problems.join(', ')} of ${SIGNUP_RULES_KEY}; using the defaults there`)
  return rules
}

// --- Whether sign-up is open -----------------------------------------------------------------------

/** The Turnstile keys in effect (Server admin › Providers › Billing), or null while one is missing. */
export async function turnstileKeys(tx: Tx): Promise<{ siteKey: string; secretKey: string } | null> {
  const config = await resolveProvider(tx, 'turnstile')
  const siteKey = config.site_key?.value
  const secretKey = config.secret_key?.value
  return siteKey && secretKey ? { siteKey, secretKey } : null
}

/** Whether sign-up is switched on and open now; `closedBecause` says why not (null when open). */
export type SelfServeState = {
  on: boolean
  open: boolean
  closedBecause: 'switched_off' | 'billing_not_in_effect' | 'bot_check_missing' | null
  rules: SignupRules
}

/**
 * Whether self-serve sign-up is switched on and open now: billing in effect through Stripe (docs/billing.md §3.1,
 * decision 1) and, while the rules ask for it, Turnstile set up. Checked by every step, never only by the page.
 */
export async function selfServeState(tx: Tx): Promise<SelfServeState> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, SELF_SERVE_KEY))
  const on = row?.value === 'on'
  const rules = await signupRules(tx)
  const closed = (closedBecause: SelfServeState['closedBecause']) => ({ on, open: false, closedBecause, rules })
  if (!on) return closed('switched_off')
  if ((await billingState(tx)).inEffect !== 'stripe') return closed('billing_not_in_effect')
  if (rules.turnstile && !(await turnstileKeys(tx))) return closed('bot_check_missing')
  return { on, open: true, closedBecause: null, rules }
}

/** The SHA-256 of the lower-case, trimmed address: how sign-up attempts keep an address. */
export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

/**
 * Whether an account with this address may be created by the sign-up page now (signup-gate.ts `mayCreateUser`):
 * sign-up is open and a code for it was asked for there in the last SIGNUP_CODE_WINDOW_MS.
 */
export async function maySignUpWithCode(tx: Tx, email: string, now = Date.now()): Promise<boolean> {
  const [recent] = await tx
    .select({ id: signup_attempts.id })
    .from(signup_attempts)
    .where(
      and(
        eq(signup_attempts.kind, 'code'),
        eq(signup_attempts.email_hash, emailHash(email)),
        gte(signup_attempts.created_at, new Date(now - SIGNUP_CODE_WINDOW_MS).toISOString()),
      ),
    )
    .limit(1)
  if (!recent) return false
  return (await selfServeState(tx)).open
}

// --- Turnstile --------------------------------------------------------------------------------------

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
let turnstileFetch: typeof fetch = (...args) => fetch(...args)
/** Tests swap Cloudflare for a fake. */
export function setTurnstileFetch(doFetch: typeof fetch | null) {
  turnstileFetch = doFetch ?? ((...args) => fetch(...args))
}

/** What a token must have been solved for: the sign-up widget's action, on one of the app's own hostnames. */
export type TurnstileExpected = { action: string; hostnames: readonly string[] }
/** The action the sign-up page renders its widget with (apps/web/src/Signup.tsx). */
export const TURNSTILE_ACTION = 'signup'

/**
 * Whether Cloudflare accepts the page's Turnstile token, solved for the sign-up widget's action on one of the app's
 * hostnames (security review F2 of #960: a token from another page or site of the same widget is refused). Any failure
 * to ask (timeout, an error) counts as no.
 */
export async function verifyTurnstile(
  secretKey: string,
  token: string,
  ip: string | null,
  expected: TurnstileExpected,
): Promise<boolean> {
  if (!token || token.length > 2048) return false
  const form = new URLSearchParams({ secret: secretKey, response: token, ...(ip ? { remoteip: ip } : {}) })
  try {
    const res = await turnstileFetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: form,
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return false
    const body = (await res.json().catch(() => null)) as {
      success?: unknown
      action?: unknown
      hostname?: unknown
    } | null
    return (
      body?.success === true &&
      body.action === expected.action &&
      typeof body.hostname === 'string' &&
      expected.hostnames.includes(body.hostname.toLowerCase())
    )
  } catch (e) {
    console.error('turnstile: verification failed:', e instanceof Error ? e.name : 'error')
    return false
  }
}

// --- The sign-up code -------------------------------------------------------------------------------

/** Why no code went out: the page shows each in its own words (never which addresses have an account). */
export type CodeRefusal = 'closed' | 'invalid_email' | 'blocked_domain' | 'bot_check' | 'too_many' | 'busy'
export type CodeAnswer = { ok: true } | { ok: false; reason: CodeRefusal }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Counts `kind` attempts since `since` by one column's value. */
async function attemptsSince(tx: Tx, where: ReturnType<typeof eq>, since: number): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(signup_attempts)
    .where(and(eq(signup_attempts.kind, 'code'), where, gte(signup_attempts.created_at, new Date(since).toISOString())))
  return row?.n ?? 0
}

/** Requests to POST /v1/signup/code per IP bucket, counted in memory before the database is asked (F3 of #960). */
const allowCodeRequest = createRateLimiter({ max: 10, windowMs: 10 * 60_000 })

/**
 * The checks before a sign-up code goes out, in this order: a request limit per IP bucket in memory, open, a plausible
 * address, not a disposable domain, the Turnstile token, then the limits under one advisory lock (so parallel requests
 * cannot pass them). Records the attempt when all pass; the caller then sends the code (after the commit, so
 * `mayCreateUser` sees the attempt). Cloudflare is asked between two short transactions, so no request holds a pool
 * connection while it waits (security review F3 of #960). The answer is the same whether or not the address has an
 * account.
 */
export async function admitSignupCode(
  database: Db,
  input: { email: string; ipBucket: string; ip: string | null; token: string; turnstile: TurnstileExpected },
  now = Date.now(),
  verify: typeof verifyTurnstile = verifyTurnstile,
): Promise<CodeAnswer> {
  if (!allowCodeRequest(input.ipBucket, now)) return { ok: false, reason: 'too_many' }
  const email = input.email.trim().toLowerCase()
  const before = await database.transaction(async tx => {
    const state = await selfServeState(tx)
    if (!state.open) return { ok: false as const, reason: 'closed' as const }
    if (email.length > 254 || !EMAIL.test(email)) return { ok: false as const, reason: 'invalid_email' as const }
    if (isBlockedDomain(email, state.rules.blockedDomains))
      return { ok: false as const, reason: 'blocked_domain' as const }
    return {
      ok: true as const,
      turnstile: state.rules.turnstile,
      keys: state.rules.turnstile ? await turnstileKeys(tx) : null,
    }
  })
  if (!before.ok) return before
  if (
    before.turnstile &&
    !(before.keys && (await verify(before.keys.secretKey, input.token, input.ip, input.turnstile)))
  )
    return { ok: false, reason: 'bot_check' }
  return database.transaction(async tx => {
    // Still open (an admin may have closed it while Cloudflare was asked).
    const state = await selfServeState(tx)
    if (!state.open) return { ok: false, reason: 'closed' }
    const { rules } = state
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('signup.codes'))`)
    const hash = emailHash(email)
    const byAddress = eq(signup_attempts.email_hash, hash)
    const byIp = eq(signup_attempts.ip_bucket, input.ipBucket)
    if (
      (await attemptsSince(tx, byAddress, now - HOUR)) >= rules.codesPerAddressHour ||
      (await attemptsSince(tx, byAddress, now - DAY)) >= rules.codesPerAddressDay ||
      (await attemptsSince(tx, byIp, now - HOUR)) >= rules.signupsPerIpHour ||
      (await attemptsSince(tx, byIp, now - DAY)) >= rules.signupsPerIpDay
    )
      return { ok: false, reason: 'too_many' }
    const [install] = await tx
      .select({ n: count() })
      .from(signup_attempts)
      .where(and(eq(signup_attempts.kind, 'code'), gte(signup_attempts.created_at, new Date(now - HOUR).toISOString())))
    if ((install?.n ?? 0) >= rules.codesPerInstallHour) {
      await alertCapOncePerHour(tx, now, rules.codesPerInstallHour)
      return { ok: false, reason: 'busy' }
    }
    await tx.insert(signup_attempts).values({
      id: crypto.randomUUID(),
      kind: 'code',
      email_hash: hash,
      ip_bucket: input.ipBucket,
      created_at: new Date(now).toISOString(),
    })
    return { ok: true }
  })
}

/** The install's code cap was hit: the instance admins are emailed, at most once an hour. */
async function alertCapOncePerHour(tx: Tx, now: number, cap: number) {
  const hour = new Date(Math.floor(now / HOUR) * HOUR).toISOString()
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, SIGNUP_CAP_ALERT_KEY))
  if (row?.value === hour) return
  const at = new Date(now).toISOString()
  await tx
    .insert(instance_settings)
    .values({ key: SIGNUP_CAP_ALERT_KEY, value: hour, updated_at: at })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value: hour, updated_at: at } })
  console.error(`sign-up: the install's cap of ${cap} codes an hour was reached; more are refused this hour`)
  await queueBillingAlert(tx, { kind: 'signup_cap', hour, cap })
}

// --- While pending_payment ------------------------------------------------------------------------------

export const PENDING_PAYMENT =
  'Finish Checkout first: numbers, test calls, invitations and integrations start once your trial is set up.'

/**
 * What reaches outside or costs money, refused for every caller while the workspace waits for its first Checkout
 * (run-action.ts, before the input is read; security review F1 of #960): an anonymous sign-up must not mail
 * arbitrary addresses through invitations, call out through webhooks or spend the install's providers. The app shows
 * nothing but the waiting screen meanwhile (PendingPayment.tsx), so none of this is reachable there anyway.
 * `phoneNumber.setup`, browser test calls and agent setup links also refuse in their handlers (refusePendingPayment).
 */
export const REFUSED_WHILE_PENDING_PAYMENT: ReadonlySet<string> = new Set([
  // Invitation emails to any address.
  'team.invite',
  'team.resendInvite',
  // Outbound HTTP to an address the caller picks.
  'webhook.create',
  'webhook.update',
  'webhook.test',
  'integration.subscribe',
  // Third-party voice cloning, Places and the language model, carrier lookups: the install's money.
  'voice.clone',
  'business.search',
  'business.import',
  'knowledge.import',
  'phoneNumber.lookupLine',
  // A number, a browser test call, an agent setup link.
  'phoneNumber.setup',
  'assistant.startTestCall',
  'agentSetup.createWorkspaceKey',
])

/** Whether the workspace waits for its first Checkout (docs/billing.md §3.1). */
export async function isPendingPayment(tx: Pick<Tx, 'select'>, workspaceId: string | null): Promise<boolean> {
  if (!workspaceId) return false
  const [row] = await tx
    .select({ state: organization.billingState })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  return row?.state === 'pending_payment'
}

/**
 * Nothing that costs money or reaches outside before Checkout (docs/billing.md §3.1): no number, no browser test call,
 * no agent setup link while the workspace waits for its first Checkout. Checked again in those handlers, under their
 * transaction, besides run-action.ts's check of REFUSED_WHILE_PENDING_PAYMENT.
 */
export async function refusePendingPayment(tx: Tx, workspaceId: string | null) {
  if (await isPendingPayment(tx, workspaceId)) throw new Reject(PENDING_PAYMENT)
}
