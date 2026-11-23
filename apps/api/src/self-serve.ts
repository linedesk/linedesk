// Self-serve sign-up on Linedesk Cloud. Open only while the billing provider in
// effect is Stripe, an instance admin turned `signup.selfServe` on, and (by default) Cloudflare Turnstile is set up.
//
// The flow: the sign-up page asks POST /v1/signup/code for an email code. Before a code goes out: the address's domain
// is checked against the disposable-mail list, the Turnstile token is verified, and the limits are counted in
// `signup_attempts` under one advisory lock (per address, per IP or IPv6 /64, and the install's hourly cap, which
// alerts the instance admins once an hour when hit). Only then is a code attempt recorded and the code sent through
// Better Auth's sign-in code, which creates the account when the code is entered: `mayCreateUser` (signup-gate.ts)
// lets an unknown address in only with such a recent attempt, so the normal sign-in page stays closed to new
// addresses. Continue with Google (Microsoft, GitHub) on the sign-up page asks POST /v1/signup/provider first: the same
// checks without an address, and a ticket (a cookie) the provider's callback must bring (`takeProviderSignupTicket`).
// Signed in, the page runs `account.signUp`, which makes the bill and its one workspace in
// `pending_payment`; Checkout (PR 8) moves them on. A sign-up that never finishes Checkout is deleted after
// `pendingDays` by the daily sign-up sweep.
import { createHash, randomBytes } from 'node:crypto'
import { codeCooldownLeftMs, RADAR_RISK_LEVELS } from '@linedesk/actions'
import {
  calls,
  commands,
  instance_settings,
  organization,
  SIGNUP_DEFAULTS,
  SETUP_RULE_RANGES,
  SIGNUP_RULE_RANGES,
  type Db,
  type SignupRules,
  signup_attempts,
  type Tx,
} from '@linedesk/db'
import { and, count, desc, eq, gte, sql } from 'drizzle-orm'
import { billingState } from './billing-settings.ts'
import { isBlockedDomain } from './disposable-domains.ts'
import { legalTerms } from './legal-terms.ts'
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

const RANGES: Record<string, readonly [number, number]> = { ...SIGNUP_RULE_RANGES, ...SETUP_RULE_RANGES }

/**
 * Rules that no longer exist, ignored without a problem where a server still stores one: `trialWorkspacesPartner`
 * (the partner plan has no free trial since 2026-11-18).
 */
const RETIRED_SIGNUP_RULES: ReadonlySet<string> = new Set(['trialWorkspacesPartner'])

/** `stored` over the defaults, field by field; `problems` names what was ignored. */
export function mergeSignupRules(stored: unknown): { rules: SignupRules; problems: string[] } {
  const rules: SignupRules = { ...SIGNUP_DEFAULTS }
  const problems: string[] = []
  if (stored === undefined) return { rules, problems }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored))
    return { rules, problems: ['not an object'] }
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (RETIRED_SIGNUP_RULES.has(key)) continue
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
      if (!Object.hasOwn(SIGNUP_DEFAULTS, key)) problems.push(key)
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

/** One sign-up rule an admin changed, as in effect before and after (`signup.setRules`: the email and the audit log). */
export type SignupRuleChange = {
  [F in keyof SignupRules]: { field: F; from: SignupRules[F]; to: SignupRules[F] }
}[keyof SignupRules]

/** The rules in effect that differ between `before` and `after`, in the order of SIGNUP_DEFAULTS. */
export function signupRuleChanges(before: SignupRules, after: SignupRules): SignupRuleChange[] {
  return (Object.keys(SIGNUP_DEFAULTS) as (keyof SignupRules)[])
    .filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map(field => ({ field, from: before[field], to: after[field] }) as SignupRuleChange)
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

/** The Turnstile keys in effect (Server admin › Billing › Sign-up), or null while one is missing. */
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
  closedBecause: 'switched_off' | 'billing_not_in_effect' | 'terms_missing' | 'bot_check_missing' | null
  rules: SignupRules
}

/**
 * Whether self-serve sign-up is switched on and open now: billing in effect through Stripe, the terms and privacy policy with their versions set (legal-terms.ts, A9: nobody starts a plan without
 * terms to accept) and, while the rules ask for it, Turnstile set up. Checked by every step, never only by the page.
 */
export async function selfServeState(tx: Tx): Promise<SelfServeState> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, SELF_SERVE_KEY))
  const on = row?.value === 'on'
  const rules = await signupRules(tx)
  const closed = (closedBecause: SelfServeState['closedBecause']) => ({ on, open: false, closedBecause, rules })
  if (!on) return closed('switched_off')
  if ((await billingState(tx)).inEffect !== 'stripe') return closed('billing_not_in_effect')
  if (!legalTerms().terms) return closed('terms_missing')
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
/**
 * `retryAfter`: seconds until this address may ask for a code again (LIN-661): after a code, the cooldown before the
 * next one; when refused for too many or busy, until a limit lets one through (whole seconds, at least 1). Absent for
 * the other refusals: waiting does not change them.
 */
export type CodeAnswer = { ok: true; retryAfter: number } | { ok: false; reason: CodeRefusal; retryAfter?: number }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Whole seconds from now until `atMs`, at least 1. */
const secondsUntil = (atMs: number, now: number) => Math.max(1, Math.ceil((atMs - now) / 1000))

/**
 * When a sliding-window limit of `max` in `windowMs` lets the next one through: once the `max`-th newest of `times`
 * (newest first) has left the window. Null while under the limit.
 */
function windowFullUntil(timesNewestFirst: readonly number[], max: number, windowMs: number): number | null {
  if (timesNewestFirst.length < max) return null
  return timesNewestFirst[max - 1]! + windowMs
}

const timesNewestFirst = (rows: { at: string }[]) => rows.map(r => Date.parse(r.at)).sort((a, b) => b - a)

/** The times of the code attempts for one address in the last day. */
async function addressCodeTimes(tx: Tx, hash: string, now: number): Promise<number[]> {
  const rows = await tx
    .select({ at: signup_attempts.created_at })
    .from(signup_attempts)
    .where(
      and(
        eq(signup_attempts.kind, 'code'),
        eq(signup_attempts.email_hash, hash),
        gte(signup_attempts.created_at, new Date(now - DAY).toISOString()),
      ),
    )
  return timesNewestFirst(rows)
}

/**
 * The addresses a network (IP bucket) asked codes for in the last day, each with its first code then. A network's
 * sign-up limits count different addresses, so a resend to the same address never uses them up (LIN-661); an address
 * counts from its first code, so a resend does not move when it leaves the window.
 */
async function networkAddresses(
  tx: Tx,
  ipBucket: string,
  now: number,
): Promise<{ hash: string | null; first: number }[]> {
  const rows = await tx
    .select({ hash: signup_attempts.email_hash, at: sql<string>`min(${signup_attempts.created_at})` })
    .from(signup_attempts)
    .where(
      and(
        eq(signup_attempts.kind, 'code'),
        eq(signup_attempts.ip_bucket, ipBucket),
        gte(signup_attempts.created_at, new Date(now - DAY).toISOString()),
      ),
    )
    .groupBy(signup_attempts.email_hash)
  return rows.map(r => ({ hash: r.hash, first: Date.parse(r.at) }))
}

/** The times of every code a network (IP bucket) asked for in the last hour, resends included. */
async function networkCodeTimes(tx: Tx, ipBucket: string, now: number): Promise<number[]> {
  const rows = await tx
    .select({ at: signup_attempts.created_at })
    .from(signup_attempts)
    .where(
      and(
        eq(signup_attempts.kind, 'code'),
        eq(signup_attempts.ip_bucket, ipBucket),
        gte(signup_attempts.created_at, new Date(now - HOUR).toISOString()),
      ),
    )
  return timesNewestFirst(rows)
}

/**
 * Codes per network (IP bucket) in an hour, resends included: enough for a few people on one network, each with a
 * resend or two, while resends to its own addresses can not fill the install's hourly cap from a handful of networks
 * (security review of LIN-661).
 */
export const CODES_PER_NETWORK_HOUR = 12

/** Requests to POST /v1/signup/code per IP bucket, counted in memory before the database is asked (F3 of #960). */
const allowCodeRequest = createRateLimiter({ max: 10, windowMs: 10 * 60_000 })

/**
 * The checks before a sign-up code goes out, in this order: a request limit per IP bucket in memory, open, a plausible
 * address, not a disposable domain, the Turnstile token, then the limits under one advisory lock (so parallel requests
 * cannot pass them). Records the attempt when all pass; the caller then sends the code (after the commit, so
 * `mayCreateUser` sees the attempt). Cloudflare is asked between two short transactions, so no request holds a pool
 * connection while it waits (security review F3 of #960). The answer is the same whether or not the address has an
 * account.
 *
 * The limits (LIN-661): per address, a cooldown that grows with each code (CODE_COOLDOWN_STEPS_S: 30 s, 2, 5, then 10
 * min) instead of a hard hourly stop, under the install's caps per hour and day (`signup.rules`); per network, the
 * different addresses that asked (a resend to an address it asked for already does not count again) and at most
 * CODES_PER_NETWORK_HOUR codes in all; the install's
 * hourly cap. Every refusal for a limit says when another code may go out.
 */
export async function admitSignupCode(
  database: Db,
  input: { email: string; ipBucket: string; ip: string | null; token: string; turnstile: TurnstileExpected },
  now = Date.now(),
  verify: typeof verifyTurnstile = verifyTurnstile,
): Promise<CodeAnswer> {
  const email = input.email.trim().toLowerCase()
  return admitAttempt(database, { ...input, email, hash: emailHash(email) }, now, verify)
}

/**
 * admitSignupCode's checks for one attempt: an address's code (`email` set, `hash` its emailHash) or a provider
 * sign-up's ticket (`email` null, `hash` the ticket's, so the network counts it as one more address).
 */
async function admitAttempt(
  database: Db,
  input: {
    email: string | null
    hash: string
    ipBucket: string
    ip: string | null
    token: string
    turnstile: TurnstileExpected
  },
  now: number,
  verify: typeof verifyTurnstile,
): Promise<CodeAnswer> {
  if (!allowCodeRequest(input.ipBucket, now))
    return {
      ok: false,
      reason: 'too_many',
      retryAfter: secondsUntil(allowCodeRequest.freeAt(input.ipBucket, now), now),
    }
  const { email, hash } = input
  const before = await database.transaction(async tx => {
    const state = await selfServeState(tx)
    if (!state.open) return { ok: false as const, reason: 'closed' as const }
    if (email !== null && (email.length > 254 || !EMAIL.test(email)))
      return { ok: false as const, reason: 'invalid_email' as const }
    if (email !== null && isBlockedDomain(email, state.rules.blockedDomains))
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
  return database.transaction(async (tx): Promise<CodeAnswer> => {
    // Still open (an admin may have closed it while Cloudflare was asked).
    const state = await selfServeState(tx)
    if (!state.open) return { ok: false, reason: 'closed' }
    const { rules } = state
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('signup.codes'))`)
    const sent = await addressCodeTimes(tx, hash, now)
    const cooldownLeft = codeCooldownLeftMs(sent, now)
    const network = await networkAddresses(tx, input.ipBucket, now)
    // A resend to an address this network asked for already: not another sign-up from it.
    const newOnNetwork = !network.some(a => a.hash === hash)
    const firstPerAddress = network.map(a => a.first).sort((x, y) => y - x)
    const freeAt = [
      cooldownLeft > 0 ? now + cooldownLeft : null,
      windowFullUntil(
        sent.filter(t => t > now - HOUR),
        rules.codesPerAddressHour,
        HOUR,
      ),
      windowFullUntil(sent, rules.codesPerAddressDay, DAY),
      newOnNetwork
        ? windowFullUntil(
            firstPerAddress.filter(t => t > now - HOUR),
            rules.signupsPerIpHour,
            HOUR,
          )
        : null,
      newOnNetwork ? windowFullUntil(firstPerAddress, rules.signupsPerIpDay, DAY) : null,
      windowFullUntil(await networkCodeTimes(tx, input.ipBucket, now), CODES_PER_NETWORK_HOUR, HOUR),
    ].filter((t): t is number => t !== null && t > now)
    if (freeAt.length) return { ok: false, reason: 'too_many', retryAfter: secondsUntil(Math.max(...freeAt), now) }
    const [install] = await tx
      .select({ n: count() })
      .from(signup_attempts)
      .where(and(eq(signup_attempts.kind, 'code'), gte(signup_attempts.created_at, new Date(now - HOUR).toISOString())))
    if ((install?.n ?? 0) >= rules.codesPerInstallHour) {
      await alertCapOncePerHour(tx, now, rules.codesPerInstallHour)
      // Once the cap-th newest code of the hour has left it.
      const [nth] = await tx
        .select({ at: signup_attempts.created_at })
        .from(signup_attempts)
        .where(
          and(eq(signup_attempts.kind, 'code'), gte(signup_attempts.created_at, new Date(now - HOUR).toISOString())),
        )
        .orderBy(desc(signup_attempts.created_at))
        .offset(rules.codesPerInstallHour - 1)
        .limit(1)
      return { ok: false, reason: 'busy', retryAfter: secondsUntil(nth ? Date.parse(nth.at) + HOUR : now + HOUR, now) }
    }
    await tx.insert(signup_attempts).values({
      id: crypto.randomUUID(),
      kind: 'code',
      email_hash: hash,
      ip_bucket: input.ipBucket,
      created_at: new Date(now).toISOString(),
    })
    return { ok: true, retryAfter: secondsUntil(now + codeCooldownLeftMs([...sent, now], now), now) }
  })
}

// --- A provider sign-up (Continue with Google, Microsoft, GitHub on the sign-up page) -----------------------

/**
 * Where a provider sign-up's ticket is kept in `signup_attempts.email_hash` until the account is made: never an
 * address's hash (those are hex only), so a ticket can't stand in for an address or the other way round.
 */
const TICKET_PREFIX = 'provider:'
const ticketHash = (ticket: string) => TICKET_PREFIX + createHash('sha256').update(ticket).digest('hex')

/** A provider sign-up was let through: the browser keeps `ticket` (a cookie) for the provider's callback. */
export type ProviderSignupAnswer =
  | { ok: true; ticket: string }
  | { ok: false; reason: CodeRefusal; retryAfter?: number }

/**
 * Before the sign-up page sends the browser to a sign-in provider: the same checks as a code (open, Turnstile, the
 * network's and the install's limits, one more address on the network), with no address yet: the provider names it
 * at its callback, where `takeProviderSignupTicket` checks its domain. Records the attempt under a fresh ticket.
 */
export async function admitProviderSignup(
  database: Db,
  input: {
    ipBucket: string
    ip: string | null
    token: string
    turnstile: TurnstileExpected
    /** The ticket this browser holds already (its cookie): still unused and in time, it is kept, nothing counted again. */
    held?: string | null
  },
  now = Date.now(),
  verify: typeof verifyTurnstile = verifyTurnstile,
): Promise<ProviderSignupAnswer> {
  // Another click (back from the provider's page, a second provider) is not another sign-up of the network.
  if (input.held && (await database.transaction(tx => ticketUnused(tx, input.held!, now))))
    return { ok: true, ticket: input.held }
  const ticket = randomBytes(32).toString('base64url')
  const answer = await admitAttempt(database, { ...input, email: null, hash: ticketHash(ticket) }, now, verify)
  return answer.ok ? { ok: true, ticket } : answer
}

/**
 * Whether a provider sign-in may make the account for `email` (signup-gate.ts `mayCreateUser`): sign-up is open, the
 * browser brought a ticket the sign-up page got in the last SIGNUP_CODE_WINDOW_MS, and the address's domain is not
 * blocked. The ticket is used up here (one account per ticket, also when two callbacks race): its attempt becomes the
 * address's, so it keeps counting for the network.
 */
/** Whether `ticket` was given in the last SIGNUP_CODE_WINDOW_MS, is unused, and sign-up is still open. */
async function ticketUnused(tx: Tx, ticket: string, now: number): Promise<boolean> {
  if (!(await selfServeState(tx)).open) return false
  const [row] = await tx
    .select({ id: signup_attempts.id })
    .from(signup_attempts)
    .where(
      and(
        eq(signup_attempts.kind, 'code'),
        eq(signup_attempts.email_hash, ticketHash(ticket)),
        gte(signup_attempts.created_at, new Date(now - SIGNUP_CODE_WINDOW_MS).toISOString()),
      ),
    )
    .limit(1)
  return !!row
}

export async function takeProviderSignupTicket(
  tx: Tx,
  ticket: string,
  email: string,
  now = Date.now(),
): Promise<boolean> {
  const address = email.trim().toLowerCase()
  // The same address checks as before a code goes out.
  if (address.length > 254 || !EMAIL.test(address)) return false
  const state = await selfServeState(tx)
  if (!state.open || isBlockedDomain(address, state.rules.blockedDomains)) return false
  const taken = await tx
    .update(signup_attempts)
    .set({ email_hash: emailHash(email) })
    .where(
      and(
        eq(signup_attempts.kind, 'code'),
        eq(signup_attempts.email_hash, ticketHash(ticket)),
        gte(signup_attempts.created_at, new Date(now - SIGNUP_CODE_WINDOW_MS).toISOString()),
      ),
    )
    .returning({ id: signup_attempts.id })
  return taken.length > 0
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

// --- While pending_payment ---------------------------------------------------------------------------------

export const PENDING_PAYMENT = 'Start your free trial first: numbers, invitations and integrations open once it is on.'

/**
 * What reaches outside or costs money, refused for every caller while the workspace waits for its trial to start
 * (run-action.ts, before the input is read; security review F1 of #960): an anonymous sign-up must not mail arbitrary
 * addresses through invitations, call out through webhooks, take a number, call a phone or spend the install's
 * providers beyond the setup allowance. The owner sets the workspace up meanwhile, with an AI agent (a workspace setup
 * link, agent-first since 2026-11-18) or by hand: the steps up to `activate`. Browser test calls
 * and business lookups run within the setup allowance of `signup.rules` (startTestCall, chargeSetupLookup).
 * `phoneNumber.setup` also refuses in its handler (refusePendingPayment), `onboarding.setStep` past `activate` in its own.
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
  // Third-party voice cloning and carrier lookups: the install's money, not needed to set up.
  'voice.clone',
  'phoneNumber.lookupLine',
  // A number.
  'phoneNumber.setup',
  // A real call to the business line (the forwarding check), at the install's cost.
  'phoneNumber.checkForwarding',
])

/**
 * The business lookups the onboarding's first step runs (Google Places and the language model): allowed before the
 * trial starts, but only `setupLookups` of them per workspace in all (signup.rules), on top of their hourly limits.
 */
export const SETUP_LOOKUPS: ReadonlySet<string> = new Set(['business.search', 'business.import', 'knowledge.import'])

/** The command-log marker each lookup before the trial leaves: chargeSetupLookup counts them per workspace. */
export const SETUP_LOOKUP_MARKER = 'setup.lookup'

/**
 * One business lookup of a workspace waiting for its trial (run-action.ts): refused once `setupLookups` are used,
 * else counted (a marker row in the command log, one lookup at a time per workspace). Nothing for other workspaces.
 */
export async function chargeSetupLookup(db: Db, actor: { workspaceId: string | null; actorId: string }) {
  if (!actor.workspaceId) return
  const workspaceId = actor.workspaceId
  await db.transaction(async tx => {
    if (!(await isPendingPayment(tx, workspaceId))) return
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`setup-lookup:${workspaceId}`}))`)
    const { rules } = await storedSignupRules(tx)
    const [used] = await tx
      .select({ n: count() })
      .from(commands)
      .where(and(eq(commands.workspace_id, workspaceId), eq(commands.action, SETUP_LOOKUP_MARKER)))
    if ((used?.n ?? 0) >= rules.setupLookups) throw Reject.t('server.api.setup.lookupsUsed')
    await tx.insert(commands).values({
      id: `cmd_${crypto.randomUUID().replaceAll('-', '')}`,
      workspace_id: workspaceId,
      actor_id: actor.actorId,
      action: SETUP_LOOKUP_MARKER,
      input: {},
      result: { ok: true, rows: {} },
    })
  })
}

/**
 * Before the trial starts a workspace may talk to its assistant in the browser for `setupTestMinutes` minutes in all
 * (signup.rules): the test calls' lengths, a call still running counted up to now. Refuses another once they are used.
 */
export async function refuseSetupTestCall(tx: Tx, workspaceId: string, nowMs: number): Promise<void> {
  if (!(await isPendingPayment(tx, workspaceId))) return
  const { rules } = await storedSignupRules(tx)
  const now = new Date(nowMs).toISOString()
  const [used] = await tx
    .select({
      seconds: sql<number>`coalesce(sum(coalesce(${calls.duration_sec}, greatest(0, extract(epoch from (${now}::timestamptz - ${calls.started_at})))::int)), 0)::int`,
    })
    .from(calls)
    .where(and(eq(calls.workspace_id, workspaceId), eq(calls.source, 'test')))
  if ((used?.seconds ?? 0) >= rules.setupTestMinutes * 60) throw Reject.t('server.api.setup.testMinutesUsed')
}

/** Whether the workspace waits for its first Checkout, and whose: its own or its partner's. */
async function pendingPaymentOf(
  tx: Pick<Tx, 'select'>,
  workspaceId: string | null,
): Promise<'trial' | 'partner' | null> {
  if (!workspaceId) return null
  const [row] = await tx
    .select({ state: organization.billingState, partnerId: organization.partnerId })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  if (row?.state !== 'pending_payment') return null
  return row.partnerId ? 'partner' : 'trial'
}

/** Whether the workspace waits for its first Checkout: a Cloud sign-up's, or a partner's draft. */
export async function isPendingPayment(tx: Pick<Tx, 'select'>, workspaceId: string | null): Promise<boolean> {
  return (await pendingPaymentOf(tx, workspaceId)) !== null
}

/**
 * Whether the workspace waits for its own trial (a Cloud sign-up): its onboarding ends at `activate`, the card. A
 * partner's draft client workspace waits for the partner's Checkout instead and has no `activate` step of its own.
 */
export async function waitsForOwnTrial(tx: Pick<Tx, 'select'>, workspaceId: string | null): Promise<boolean> {
  return (await pendingPaymentOf(tx, workspaceId)) === 'trial'
}

/**
 * Why something is refused while the workspace waits for its first Checkout (run-action.ts), or null. A white-label
 * partner's draft client workspace waits for the partner's Checkout (White-label Cloud, no trial), not a trial of its
 * own (setup before payment, 2026-11-18; docs/white-label.md).
 */
export async function pendingPaymentRefusal(
  tx: Pick<Tx, 'select'>,
  workspaceId: string | null,
): Promise<Reject | null> {
  const pending = await pendingPaymentOf(tx, workspaceId)
  if (pending === 'partner') return Reject.t('server.api.partner.activateFirst')
  return pending === 'trial' ? new Reject(PENDING_PAYMENT) : null
}

/**
 * Nothing that costs money or reaches outside before Checkout: no number while the workspace
 * waits for its first Checkout. Checked again in that handler, under its transaction, besides run-action.ts's check of
 * REFUSED_WHILE_PENDING_PAYMENT.
 */
export async function refusePendingPayment(tx: Tx, workspaceId: string | null) {
  const refusal = await pendingPaymentRefusal(tx, workspaceId)
  if (refusal) throw refusal
}
