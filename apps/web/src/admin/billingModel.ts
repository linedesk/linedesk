// Server admin › Billing (docs/billing.md §11, PR 13): the page's arithmetic, kept out of the components so it is
// tested on its own. Money crosses the API in cents (actions) and micros (ledger); the page shows and takes dollars.
import type { AdminBillRow, AdminBillStatus } from '@linedesk/actions'
import type { BillingRules, SignupCountRule, SignupRules } from '@linedesk/db/types'
import { SIGNUP_RULE_RANGES } from '@linedesk/db/types'
import { i18n } from '../i18n/index.tsx'
import { formatUsd } from './model.ts'

/** The most one money action moves: $100,000 (the actions' 10,000,000 cents). */
export const MAX_ACTION_CENTS = 10_000_000

export const usdOfCents = (cents: number) => formatUsd(cents / 100)
export const usdOfMicros = (micros: number) => formatUsd(micros / 1_000_000)
/** A price a minute (in micros): 2 to 4 decimals, so a sub-cent price never rounds ($0.05, $0.0085). */
export const rateOfMicros = (micros: number) => i18n().format.rate(micros / 1_000_000, 'USD')

/**
 * A dollar amount typed by the admin ("20", "$1,250.50", "-5" where `negative` allows it) in whole cents. Empty, zero,
 * more than two decimals or over `max` cents is a problem the field shows.
 */
export function parseDollars(
  text: string,
  { negative = false, zero = false, max = MAX_ACTION_CENTS }: { negative?: boolean; zero?: boolean; max?: number } = {},
): { cents: number } | { problem: string } {
  const { t } = i18n()
  const value = text
    .trim()
    .replace(/^(-?)\$/, '$1')
    .replace(/,/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) return { problem: t('admin.bills.amount.invalid') }
  const cents = Math.round(Number(value) * 100)
  if (cents < 0 && !negative) return { problem: t('admin.bills.amount.positive') }
  if (cents === 0 && !zero) return { problem: t('admin.bills.amount.zero') }
  if (Math.abs(cents) > max) return { problem: t('admin.bills.amount.max', { amount: usdOfCents(max) }) }
  return { cents }
}

/** A whole number typed in a field, within its range; empty is null when `empty` allows it. */
export function parseCount(
  text: string,
  min: number,
  max: number,
  { empty = false }: { empty?: boolean } = {},
): { value: number | null } | { problem: string } {
  const value = text.trim()
  if (!value && empty) return { value: null }
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    return { problem: i18n().t('admin.bills.count.invalid', { min, max }) }
  return { value: Number(value) }
}

/** One per dialog: the same request sent twice (a retry, a double click) moves money once (Stripe's idempotency key). */
export const newRequestId = () => crypto.randomUUID()

/** What the reason field takes (the actions' rule): 3 to 500 characters once trimmed. */
export const reasonProblem = (reason: string): string | null =>
  reason.trim().length < 3
    ? i18n().t('admin.bills.reason.missing')
    : reason.trim().length > 500
      ? i18n().t('admin.bills.reason.long')
      : null

// ---- The billing rules editor ----

type Unit = 'seconds' | 'minutes' | 'count' | 'cents' | 'micros'
/**
 * The rule fields the editor shows besides the levels, with the unit the editor shows: seconds stored, `minutes` shown
 * (a whole number of seconds), cents and micros shown in dollars.
 */
export const RULE_FIELDS = [
  ['workspaceMonthlyCents', 'cents'],
  ['workspaceYearlyCents', 'cents'],
  ['partnerMonthlyCents', 'cents'],
  ['partnerYearlyCents', 'cents'],
  ['trialDays', 'count'],
  ['includedStandardSeconds', 'minutes'],
  ['balanceBufferMicros', 'micros'],
  ['concurrentCallsPerWorkspace', 'count'],
  ['concurrentCallsMaxPerWorkspace', 'count'],
  ['extraCallCents', 'cents'],
  ['concurrentCallsBase', 'count'],
  ['trialConcurrentCalls', 'count'],
  ['billedTransferCapSeconds', 'minutes'],
  ['callLimitGraceSeconds', 'seconds'],
  ['extraNumberCents', 'cents'],
  ['rechargeCapPerWorkspaceCents', 'cents'],
] as const satisfies readonly (readonly [Exclude<keyof BillingRules, 'levels'>, Unit])[]
export type RuleField = (typeof RULE_FIELDS)[number][0]

/**
 * The form's text per field: `levels.<level>.price` in dollars a minute, `levels.<level>.factor`, `automaticTax`
 * as `on` or `off` (a switch), the rest by unit.
 */
export type RulesForm = Record<string, string>

/** The Stripe Tax switch in the rules form (`BillingRules.automaticTax`). */
export const TAX_FIELD = 'automaticTax'

const DIVISOR: Record<Unit, number> = { seconds: 1, minutes: 60, count: 1, cents: 100, micros: 1_000_000 }
const shown = (value: number, unit: Unit) => String(value / DIVISOR[unit])

/** The form for the rules in effect. */
export function rulesForm(rules: BillingRules): RulesForm {
  const form: RulesForm = {}
  for (const [field, unit] of RULE_FIELDS) form[field] = shown(rules[field], unit)
  form[TAX_FIELD] = rules.automaticTax ? 'on' : 'off'
  for (const [name, level] of Object.entries(rules.levels)) {
    form[`levels.${name}.price`] = String(level.microsPerMinute / 1_000_000)
    form[`levels.${name}.factor`] = level.allowanceFactor === null ? '' : String(level.allowanceFactor)
  }
  return form
}

const stored = (text: string, unit: Unit): number | null => {
  const value = text.trim()
  if (!/^\d+(\.\d+)?$/.test(value)) return null
  const out = Number(value) * DIVISOR[unit]
  return Number.isInteger(Math.round(out * 1e6) / 1e6) ? Math.round(out) : null
}

/** Under a plan fee in the rules editor: the server's floor (a yearly fee: 12 times it, and at most 12 monthly fees). */
export function planFloorText(field: string, minPlanCents: number): string | undefined {
  const { t } = i18n()
  if (field === 'workspaceMonthlyCents' || field === 'partnerMonthlyCents')
    return t('admin.bills.rules.minPrice', { amount: usdOfCents(minPlanCents) })
  if (field === 'workspaceYearlyCents' || field === 'partnerYearlyCents')
    return t('admin.bills.rules.minYearly', { amount: usdOfCents(12 * minPlanCents) })
  return undefined
}

/**
 * The rules to store from the form: what differs from the defaults, and null for a field at its default, so it follows
 * a later change of the default (the server merges over the stored rules, and null resets a field). Every field is
 * sent. A changed level is stored whole. `problems`: the fields that are not a number in their unit (the server checks
 * the ranges and the minimum prices).
 */
export function rulesFromForm(
  form: RulesForm,
  defaults: BillingRules,
): { rules: Record<string, unknown>; problems: [] } | { problems: string[] } {
  const rules: Record<string, unknown> = {}
  const problems: string[] = []
  for (const [field, unit] of RULE_FIELDS) {
    const value = stored(form[field] ?? '', unit)
    if (value === null) problems.push(field)
    else rules[field] = value !== defaults[field] ? value : null
  }
  const taxOn = form[TAX_FIELD] === 'on'
  rules[TAX_FIELD] = taxOn !== defaults.automaticTax ? taxOn : null
  const levels: Record<string, { microsPerMinute: number; allowanceFactor: number | null } | null> = {}
  for (const [name, fallback] of Object.entries(defaults.levels)) {
    const price = stored(form[`levels.${name}.price`] ?? '', 'micros')
    const factorText = (form[`levels.${name}.factor`] ?? '').trim()
    const factor = factorText ? stored(factorText, 'count') : null
    if (price === null) problems.push(`levels.${name}.price`)
    if (factorText && factor === null) problems.push(`levels.${name}.factor`)
    if (price === null || (factorText && factor === null)) continue
    levels[name] =
      price !== fallback.microsPerMinute || factor !== fallback.allowanceFactor
        ? { microsPerMinute: price, allowanceFactor: factor }
        : null
  }
  if (Object.keys(levels).length) rules.levels = levels
  return problems.length ? { problems } : { rules, problems: [] }
}

/** The fields whose form text differs from `before`: what Save would change. */
export const changedFields = (form: RulesForm, before: RulesForm) =>
  Object.keys(form).filter(key => form[key]!.trim() !== (before[key] ?? '').trim())

// ---- The bills list ----

/** The bills list's filter: every bill, the ones held for review, or one status. */
export type BillFilter = 'all' | 'held' | AdminBillStatus

/** The bills the filter keeps. */
export const filterBills = (bills: readonly AdminBillRow[], filter: BillFilter): AdminBillRow[] =>
  filter === 'all'
    ? [...bills]
    : filter === 'held'
      ? bills.filter(b => b.heldForReviewAt)
      : bills.filter(b => b.status === filter)

// ---- The sign-up rules editor ----

/** The whole-number sign-up rules, in the order the editor shows them. */
export const SIGNUP_COUNT_FIELDS = Object.keys(SIGNUP_RULE_RANGES) as SignupCountRule[]

/** The sign-up editor's state: the numbers as typed, the bot check, blocked domains (one a line), the risk levels. */
export type SignupForm = {
  counts: Record<SignupCountRule, string>
  turnstile: boolean
  blockedDomains: string
  reviewRiskLevels: string[]
}

export function signupForm(rules: SignupRules): SignupForm {
  return {
    counts: Object.fromEntries(SIGNUP_COUNT_FIELDS.map(f => [f, String(rules[f])])) as Record<SignupCountRule, string>,
    turnstile: rules.turnstile,
    blockedDomains: rules.blockedDomains.join('\n'),
    reviewRiskLevels: [...rules.reviewRiskLevels],
  }
}

/** The blocked domains typed one a line (or separated by commas or spaces), trimmed, lower case, without repeats. */
export const domainList = (text: string) => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map(d => d.trim().toLowerCase())
      .filter(Boolean),
  ),
]

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])

/**
 * The change to send (`signup.setRules`): every field, null for one at its default (so it follows a later change of
 * the default). `problems`: the number fields that are not a whole number in their range (the server checks again).
 */
export function signupFromForm(
  form: SignupForm,
  defaults: SignupRules,
): { rules: Record<string, unknown>; problems: [] } | { problems: string[] } {
  const rules: Record<string, unknown> = {}
  const problems: string[] = []
  for (const field of SIGNUP_COUNT_FIELDS) {
    const [min, max] = SIGNUP_RULE_RANGES[field]
    const text = form.counts[field].trim()
    const value = Number(text)
    if (!/^\d+$/.test(text) || value < min || value > max) problems.push(field)
    else rules[field] = value === defaults[field] ? null : value
  }
  rules.turnstile = form.turnstile === defaults.turnstile ? null : form.turnstile
  const domains = domainList(form.blockedDomains)
  rules.blockedDomains = sameList(domains, defaults.blockedDomains) ? null : domains
  rules.reviewRiskLevels = sameList(form.reviewRiskLevels, defaults.reviewRiskLevels) ? null : form.reviewRiskLevels
  return problems.length ? { problems } : { rules, problems: [] }
}

/** Whether the form differs from the rules in effect: what Save would change. */
export function signupDirty(form: SignupForm, saved: SignupForm): boolean {
  return (
    SIGNUP_COUNT_FIELDS.some(f => form.counts[f].trim() !== saved.counts[f]) ||
    form.turnstile !== saved.turnstile ||
    !sameList(domainList(form.blockedDomains), domainList(saved.blockedDomains)) ||
    !sameList(form.reviewRiskLevels, saved.reviewRiskLevels)
  )
}
