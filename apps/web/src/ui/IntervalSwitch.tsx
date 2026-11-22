// Monthly / Yearly: the plan's one billing switch, in the Start your free trial dialog and on the
// activation step, so an owner who did not notice the plan was yearly can switch before the card. The yearly side
// says what it saves against twelve monthly payments ("Save 18%"), from the install's own prices; no label when it
// saves nothing. A radio group: Left and Right move the choice, as in any radio group.
import { useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, useRef } from 'react'
import { cx } from './kit.tsx'
import type { BillingInterval } from './price.tsx'

/** What a year saves against twelve monthly payments, in whole percent rounded down; 0 when it saves nothing. */
export function yearlySavingPercent(monthCents: number, yearCents: number): number {
  if (monthCents <= 0 || yearCents <= 0) return 0
  return Math.max(0, Math.floor((1 - yearCents / (monthCents * 12)) * 100))
}

const ORDER: BillingInterval[] = ['month', 'year']

export function IntervalSwitch({
  value,
  onChange,
  centsByInterval,
  disabled = false,
}: {
  value: BillingInterval
  onChange: (interval: BillingInterval) => void
  /** The plan's price per interval (a month's, a year's): the yearly side's saving. */
  centsByInterval: { month: number; year: number }
  disabled?: boolean
}) {
  const t = useT()
  const saving = yearlySavingPercent(centsByInterval.month, centsByInterval.year)
  const refs = useRef<Record<BillingInterval, HTMLButtonElement | null>>({ month: null, year: null })
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const next = value === 'month' ? 'year' : 'month'
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div className="interval-switch" role="radiogroup" aria-label={t('common.plan.interval.label')} onKeyDown={onKey}>
      {ORDER.map(interval => {
        const on = interval === value
        return (
          <button
            key={interval}
            ref={el => {
              refs.current[interval] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            className={cx('interval-switch-option', on && 'on')}
            onClick={() => onChange(interval)}
          >
            {interval === 'month' ? t('common.plan.interval.month') : t('common.plan.interval.year')}
            {interval === 'year' && saving > 0 && (
              <span className="interval-switch-save">{t('common.plan.interval.save', { percent: saving })}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
