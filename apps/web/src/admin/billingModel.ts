// Server admin › Billing (docs/billing.md §11, PR 13): the page's arithmetic, kept out of the components so it is
// tested on its own. Money crosses the API in cents (actions) and micros (ledger); the page shows and takes dollars.
import type { BillingRules } from '@linedesk/db/types'
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

type Unit = 'seconds' | 'count' | 'cents' | 'micros'
/** The rule fields the editor shows besides the levels, with the unit each is stored in. */
export const RULE_FIELDS = [
  ['workspaceMonthlyCents', 'cents'],
  ['workspaceYearlyCents', 'cents'],
  ['partnerMonthlyCents', 'cents'],
  ['partnerYearlyCents', 'cents'],
  ['trialDays', 'count'],
  ['includedStandardSeconds', 'seconds'],
  ['balanceBufferMicros', 'micros'],
  ['trialConcurrentCalls', 'count'],
  ['concurrentCallsBase', 'count'],
  ['concurrentCallsPerWorkspace', 'count'],
  ['billedTransferCapSeconds', 'seconds'],
  ['callLimitGraceSeconds', 'seconds'],
  ['extraNumberCents', 'cents'],
  ['rechargeCapPerWorkspaceCents', 'cents'],
] as const satisfies readonly (readonly [Exclude<keyof BillingRules, 'levels'>, Unit])[]
export type RuleField = (typeof RULE_FIELDS)[number][0]

/** The form's text per field: `levels.<level>.price` in dollars a minute, `levels.<level>.factor`, the rest by unit. */
export type RulesForm = Record<string, string>

const shown = (value: number, unit: Unit) =>
  unit === 'cents' ? String(value / 100) : unit === 'micros' ? String(value / 1_000_000) : String(value)

/** The form for the rules in effect. */
export function rulesForm(rules: BillingRules): RulesForm {
  const form: RulesForm = {}
  for (const [field, unit] of RULE_FIELDS) form[field] = shown(rules[field], unit)
  for (const [name, level] of Object.entries(rules.levels)) {
    form[`levels.${name}.price`] = String(level.microsPerMinute / 1_000_000)
    form[`levels.${name}.factor`] = level.allowanceFactor === null ? '' : String(level.allowanceFactor)
  }
  return form
}

const stored = (text: string, unit: Unit): number | null => {
  const value = text.trim()
  if (!/^\d+(\.\d+)?$/.test(value)) return null
  const n = Number(value)
  const out = unit === 'cents' ? n * 100 : unit === 'micros' ? n * 1_000_000 : n
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
