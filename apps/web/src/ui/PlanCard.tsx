// The one plan card (Janik, 2026-11-18: "focus on the value, but the conditions should be clear", "as harmonized as
// possible"): wherever a plan's price is shown before or outside a charge, the same card with the same wording and
// spacing: the cloud activation step and the agent page's "Start your trial" dialog (onboarding/ActivateStep.tsx), the
// partner's Activate step (partner/PartnerSetup.tsx) and Settings › Billing's Plan (settings/Billing.tsx).
//
// Top to bottom: a quiet badge ("14 days free", only with a trial), the price a month large with its unit muted next
// to it and a yearly plan's total as the grey note under it (ui/price.tsx), two value rows with a check (the included
// minutes, then the Standard price a minute), what the place adds (`children`), one grey tax line, and a closed
// "See all prices" with the install's other prices. Dates, reminders and cancelling are the timeline's, not the card's.
import type { PlanPrices } from '@linedesk/db/types'
import { useFormat, useT } from '@linedesk/i18n/react'
import type { ReactNode } from 'react'
import { Badge, cx, Icon } from './kit.tsx'
import { PriceLine, usePrice } from './price.tsx'
import './plan-card.css'

/** Calls at the same time the bill can add (LIN-450): in steps of `step` at `extraCallCents` a month each. */
export type PlanCalls = { step: number; maxExtra: number; extraCallCents: number }

export function PlanCard({
  badge,
  price,
  unit,
  note,
  prices,
  perClient = false,
  calls,
  tax = true,
  bare = false,
  children,
}: {
  /** The quiet badge on top ("14 days free"); none without a trial. */
  badge?: string | null
  /** The price a month ("$11 a month"), large. */
  price: string
  /** Next to it, muted ("per workspace", "+ $9 a month × 2 client workspaces"). */
  unit?: string | null
  /** The grey note under the price: a yearly plan's total ("$108 billed yearly"). */
  note: string | null
  /** The install's prices; null (an older server, a comped bill): no value rows and no "See all prices". */
  prices: PlanPrices | null | undefined
  /** A partner plan: the included minutes are per client workspace. */
  perClient?: boolean
  calls?: PlanCalls | null
  /** "Plus tax where it applies." (the install computes tax). */
  tax?: boolean
  /** Inside a card of its own (Settings › Billing's section): no border of its own. */
  bare?: boolean
  /** What the place adds between the value rows and the tax line (extra calls, the bill's own facts). */
  children?: ReactNode
}) {
  const t = useT()
  const format = useFormat()
  return (
    <div className={cx('plan-card', bare && 'plan-card-bare')}>
      {badge && (
        <div>
          <Badge>{badge}</Badge>
        </div>
      )}
      <PriceLine note={note}>
        <span className="plan-card-price">{price}</span>
        {unit && (
          <>
            {' '}
            <span className="plan-card-unit">{unit}</span>
          </>
        )}
      </PriceLine>
      {prices && (
        <ul className="plan-card-values">
          <li>
            <Icon name="check" size={14} />
            {t(perClient ? 'common.plan.minutesPerClient' : 'common.plan.minutesPerWorkspace', {
              minutes: prices.includedMinutes,
            })}
          </li>
          <li>
            <Icon name="check" size={14} />
            {t('common.plan.thenPerMinute', {
              perMinute: format.centRate(prices.standardMicrosPerMinute / 1_000_000, 'USD'),
            })}
          </li>
        </ul>
      )}
      {children}
      {tax && <span className="plan-card-fine">{t('common.plan.tax')}</span>}
      {prices && <AllPrices prices={prices} calls={calls} />}
    </div>
  )
}

/** The price a month of the plan as the card's large line ("$11 a month"). */
export function usePlanPrice() {
  const t = useT()
  return (amount: string) => t('common.plan.pricePerMonth', { price: amount })
}

/**
 * "See all prices", closed by default: what else can cost money, from the install's own prices; a row whose option
 * this install does not have stays away.
 */
function AllPrices({ prices: p, calls }: { prices: PlanPrices; calls?: PlanCalls | null }) {
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
      <p className="plan-card-balance">{t('common.plan.prices.balance')}</p>
    </details>
  )
}
