// How the app shows a plan's price, the same way as linedesk.ai/pricing: the price a month is the
// number people read; a yearly plan's total sits under it as a small grey note ("$168 billed yearly", "$108 a year
// each"); a monthly plan has no note. Whole dollars without ".00". Where a screen is about a charge (Checkout's
// first charge, the next charge, invoices and receipts, a failed payment, a top-up or recharge), it shows the amount
// charged itself instead.
import { useFormat, useT } from '@linedesk/i18n/react'
import type { ReactNode } from 'react'

export type BillingInterval = 'month' | 'year'

export type Price = {
  /** "$14", "$0.50": whole dollars without cents, cents only where the price has them. */
  money: (cents: number) => string
  /** The price a month of `cents` billed per `interval` ("$9" for $108 a year). */
  perMonth: (cents: number, interval: BillingInterval) => string
  /**
   * The grey note under a price: a yearly plan's total ("$168 billed yearly"; with `each`, a price per workspace,
   * "$108 a year each"); null when billed monthly. `cents` is the price per `interval`.
   */
  yearNote: (cents: number, interval: BillingInterval, each?: boolean) => string | null
}

export function usePrice(): Price {
  const format = useFormat()
  const t = useT()
  const money = (cents: number) =>
    format.currency(cents / 100, 'USD', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })
  return {
    money,
    perMonth: (cents, interval) => money(interval === 'year' ? Math.round(cents / 12) : cents),
    yearNote: (cents, interval, each = false) =>
      interval === 'year'
        ? t(each ? 'common.price.yearEach' : 'common.price.billedYearly', { amount: money(cents) })
        : null,
  }
}

/**
 * A price line: the price a month in the box's own strong style (`b`), and the yearly note right under it in the small
 * grey helper style (`.help`), one group, so the note reads as part of its price (`.price-line`, styles.css).
 */
export function PriceLine({ children, note }: { children: ReactNode; note: string | null }) {
  return (
    <div className="price-line">
      <b>{children}</b>
      {note && <span className="help">{note}</span>}
    </div>
  )
}
