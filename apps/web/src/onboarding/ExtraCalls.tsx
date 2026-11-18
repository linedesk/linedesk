// Calls at the same time before the trial (LIN-450): picked on the pick-up step ("When should Maya pick up?"), sold with
// the plan on the activation step, which then shows one quiet line only when more than the included ones were picked.
// The choice is kept per workspace in this browser until the card is entered: the server checks it at Checkout
// (steps of 5, the most per workspace) and bills it with the plan when the trial ends; nothing is stored before.
import { useFormat, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import type { Activation } from '../auth.ts'
import { Select } from '../ui/controls.tsx'
import { usePrice } from '../ui/price.tsx'

export type CallsOffer = NonNullable<Activation['calls']>

const KEY = 'linedesk.activation.extraCalls.'

/** The picked extra calls, if still one the offer allows (else none). */
export function validExtraCalls(n: number, calls: CallsOffer | undefined): number {
  if (!calls || !Number.isInteger(n) || n <= 0 || n > calls.maxExtra || n % calls.step) return 0
  return n
}

function readStored(workspaceId: string): number {
  try {
    return Number(localStorage.getItem(KEY + workspaceId) ?? 0)
  } catch {
    return 0 // a private window: the choice lasts this page only
  }
}

/** The extra calls picked for this workspace before its trial, and a setter that keeps them in this browser. */
export function useExtraCalls(workspaceId: string, calls: CallsOffer | undefined): [number, (n: number) => void] {
  const [extra, setExtra] = useState(() => validExtraCalls(readStored(workspaceId), calls))
  function set(n: number) {
    setExtra(n)
    try {
      if (n) localStorage.setItem(KEY + workspaceId, String(n))
      else localStorage.removeItem(KEY + workspaceId)
    } catch {
      // Private windows: kept for this page only.
    }
  }
  return [validExtraCalls(extra, calls), set]
}

/**
 * The pick-up step's picker: how many calls the assistant answers at the same time, the included ones first, more in
 * steps at a price a month (the same list as Settings › Billing), charged with the plan from the trial's end.
 */
export function ExtraCallsPicker({
  calls,
  extra,
  onChange,
}: {
  calls: CallsOffer
  extra: number
  onChange: (extra: number) => void
}) {
  const t = useT()
  const usd = usePrice().money
  const choices: number[] = []
  for (let n = 0; n <= calls.maxExtra; n += calls.step) choices.push(n)
  return (
    <div className="ob-calls">
      <div>
        <span className="ob-label">{t('onboarding.pickup.calls.title')}</span>
        <span className="ob-calls-hint">
          {t('onboarding.pickup.calls.hint', {
            count: calls.included,
            step: calls.step,
            price: usd(calls.step * calls.extraCallCents),
          })}
        </span>
      </div>
      <Select
        id="ob-calls"
        size="sm"
        align="end"
        value={String(extra)}
        label={t('onboarding.pickup.calls.title')}
        options={choices.map(n => ({
          value: String(n),
          label: t('settings.billing.calls.option', { count: calls.included + n }),
          description:
            n === 0
              ? t('settings.billing.calls.optionIncluded')
              : t('settings.billing.calls.optionPrice', { price: usd(n * calls.extraCallCents) }),
        }))}
        onChange={v => onChange(Number(v))}
      />
    </div>
  )
}
