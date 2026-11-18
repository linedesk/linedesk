// The one plan card (Janik, 2026-11-18: "focus on the value, but the conditions should be clear", "as harmonized as
// possible"; then "The 14 days free should be big and the money small"): wherever a plan's price is shown before or
// outside a charge, the same card with the same wording and spacing: the cloud activation step and the agent page's
// "Start your trial" dialog (onboarding/ActivateStep.tsx), the partner's Activate step (partner/PartnerSetup.tsx) and
// Settings › Billing's Plan (settings/Billing.tsx).
//
// Top to bottom: the headline, large: "14 days free" with a trial, else the price a month with its unit muted next to
// it. With a trial the price follows in one readable line ("Then $11 a month per workspace"). A yearly plan's total is
// the grey note under the price (ui/price.tsx). Then what the plan includes, each row with a check (a phone number, the
// minutes a month and the Standard price a minute after them, the calls at the same time), under one small label
// where the bill has several workspaces ("Each workspace includes:"), what the place adds (`children`), one grey tax
// line, and a closed "See all details" with the install's other prices. Dates, reminders and cancelling are the
// timeline's, not the card's.
import type { PlanPrices } from '@linedesk/db/types'
import { useFormat, useT } from '@linedesk/i18n/react'
import type { ReactNode } from 'react'
import { cx, Icon } from './kit.tsx'
import { PriceLine, usePrice } from './price.tsx'
import './plan-card.css'

/** Calls at the same time the bill can add (LIN-450): in steps of `step` at `extraCallCents` a month each. */
export type PlanCalls = { step: number; maxExtra: number; extraCallCents: number }

export function PlanCard({
  trialDays,
  price,
  unit,
  note,
  prices,
  each = null,
  calls,
  tax = true,
  autoRecharge = false,
  bare = false,
  children,
}: {
  /** The free trial's days: "14 days free" is the headline and the price follows it; none without a trial. */
  trialDays?: number | null
  /** The price a month ("$11 a month"): the headline without a trial. */
  price: string
  /** Next to it, muted ("per workspace", "+ $9 a month × 2 client workspaces"). */
  unit?: string | null
  /** The grey note under the price: a yearly plan's total ("$108 billed yearly"). */
  note: string | null
  /** The install's prices; null (an older server, a comped bill): no included rows and no "See all details". */
  prices: PlanPrices | null | undefined
  /**
   * Whose the included rows are when the bill has several workspaces: one small label above them ("Each workspace
   * includes:", "Each client workspace includes:"); null: the price line's "per workspace" says it.
   */
  each?: 'workspace' | 'client' | null
  calls?: PlanCalls | null
  /** "Plus tax where it applies." (the install computes tax). */
  tax?: boolean
  /** The bill's auto-recharge is on (Settings › Billing); off on the activation steps, which never turn it on. */
  autoRecharge?: boolean
  /** Inside a card of its own (Settings › Billing's section): no border of its own. */
  bare?: boolean
  /** What the place adds between the included rows and the tax line (extra calls, the bill's own facts). */
  children?: ReactNode
}) {
  const t = useT()
  const format = useFormat()
  const trial = !!trialDays && trialDays > 0
  return (
    <div className={cx('plan-card', bare && 'plan-card-bare')}>
      {trial ? (
        <div className="plan-card-head">
          <span className="plan-card-price">{t('common.plan.trialFree', { days: trialDays })}</span>
          <PriceLine note={note}>
            <span className="plan-card-then">
              {t('common.plan.thenPrice', { price })}
              {unit && ` ${unit}`}
            </span>
          </PriceLine>
        </div>
      ) : (
        <PriceLine note={note}>
          <span className="plan-card-price">{price}</span>
          {unit && (
            <>
              {' '}
              <span className="plan-card-unit">{unit}</span>
            </>
          )}
        </PriceLine>
      )}
      {prices && (
        <div className="plan-card-includes">
          {each && (
            <span className="plan-card-each">
              {t(each === 'client' ? 'common.plan.eachClient' : 'common.plan.eachWorkspace')}
            </span>
          )}
          <ul className="plan-card-values">
            {prices.includedNumbers > 0 && (
              <li>
                <Icon name="check" size={14} />
                {t('common.plan.numbers', { count: prices.includedNumbers })}
              </li>
            )}
            <li>
              <Icon name="check" size={14} />
              {t('common.plan.minutes', {
                minutes: prices.includedMinutes,
                perMinute: format.centRate(prices.standardMicrosPerMinute / 1_000_000, 'USD'),
              })}
            </li>
            {prices.includedCalls > 0 && (
              <li>
                <Icon name="check" size={14} />
                {t('common.plan.calls', { count: prices.includedCalls })}
              </li>
            )}
          </ul>
        </div>
      )}
      {children}
      {tax && <span className="plan-card-fine">{t('common.plan.tax')}</span>}
      {prices && <AllDetails prices={prices} calls={calls} autoRecharge={autoRecharge} />}
    </div>
  )
}

/** The price a month of the plan as the card's large line ("$11 a month"). */
export function usePlanPrice() {
  const t = useT()
  return (amount: string) => t('common.plan.pricePerMonth', { price: amount })
}

/**
 * "See all details", closed by default: what else can cost money, from the install's own prices (the included number
 * and calls are the card's own rows, not repeated here); a row whose option this install does not have stays away.
 */
function AllDetails({
  prices: p,
  calls,
  autoRecharge,
}: {
  prices: PlanPrices
  calls?: PlanCalls | null
  autoRecharge: boolean
}) {
  const t = useT()
  const format = useFormat()
  const usd = usePrice().money
  const perMinute = (micros: number) =>
    t('common.plan.prices.perMinute', { price: format.centRate(micros / 1_000_000, 'USD') })
  const rows: { key: string; label: string; value: string; note?: string }[] = []
  if (p.premiumMicrosPerMinute !== null)
    rows.push({
      key: 'premium',
      label: t('common.plan.prices.premium'),
      value: perMinute(p.premiumMicrosPerMinute),
      note: t('common.plan.prices.perAssistant'),
    })
  if (p.ultraMicrosPerMinute !== null)
    rows.push({
      key: 'ultra',
      label: t('common.plan.prices.ultra'),
      value: perMinute(p.ultraMicrosPerMinute),
      note: t('common.plan.prices.perAssistant'),
    })
  if (p.extraNumberCents > 0)
    rows.push({
      key: 'number',
      label: t('common.plan.prices.number'),
      value: t('common.plan.prices.perMonthEach', { price: usd(p.extraNumberCents) }),
    })
  if (calls && calls.maxExtra > 0)
    rows.push({
      key: 'calls',
      label: t('common.plan.prices.calls', { count: calls.step }),
      value: t('common.plan.prices.perMonth', { price: usd(calls.step * calls.extraCallCents) }),
    })
  return (
    <details className="plan-card-all">
      <summary>
        <Icon name="down" size={14} className="plan-card-chevron" />
        {t('common.plan.prices.toggle')}
      </summary>
      <ul className="plan-card-rows">
        {rows.map(row => (
          <li key={row.key}>
            <div>
              {row.label}
              {row.note && <small>{row.note}</small>}
            </div>
            <div>{row.value}</div>
          </li>
        ))}
      </ul>
      <p className="plan-card-balance">
        {t(autoRecharge ? 'common.plan.prices.balanceAuto' : 'common.plan.prices.balance')}
      </p>
    </details>
  )
}
