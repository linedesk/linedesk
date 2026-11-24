// What one booked appointment is worth on average, and in which currency (workspace.updateSettings,
// jobValueCents and jobValueCurrency): set in Workspace settings › General and from the Insights summary,
// which multiplies it by the booked appointments.
import { currencyDigits, currencyOfCountry, type JobValueCurrency } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useMemo, useState } from 'react'
import { currencyOptions, formatMoney, moneyText, parseMoney } from '../insights/insightsModel.ts'
import { useDefaultPhoneCountry } from '../phoneCountry.ts'
import { useRun } from '../store.tsx'
import { Select } from '../ui/controls.tsx'
import { FormMessage, Input } from '../ui/form.tsx'
import { countryDefaultOptions } from './fields.tsx'
import { patchWorkspaceSettings } from './settings-api.ts'
import './appointmentValue.css'
import { fmt } from '../i18n/format.ts'

type Props = {
  /** The amount field's id, for the label around it. */
  id: string
  value: number | null
  currency: JobValueCurrency
  /** The workspace country's currency, marked "(country default)" (Workspace settings › General). */
  countryDefault?: JobValueCurrency | null
  canEdit: boolean
  /** A label of its own inside the form (Insights); in a settings Field the Field labels it. */
  label?: string
  autoFocus?: boolean
  /** After a save, or Esc: Insights closes the form. */
  onDone?: () => void
  /** After a change was saved: other cached copies of the value (Insights) show it at once. */
  onSaved?: (cents: number | null, currency: JobValueCurrency) => void
  toast: (text: string) => void
}

/**
 * The amount and its currency. The amount is typed in whole units (350.50 dollars, 5000 yen) and stored in the
 * currency's minor units; picking another currency keeps the typed amount ($350 → ¥350, nothing is converted).
 * Saved when the focus leaves the form (not when it moves from the amount to the
 * currency) or on Enter; Esc puts the saved value back.
 */
export function AppointmentValue({
  id,
  value,
  currency: savedCurrency,
  countryDefault,
  canEdit,
  label,
  autoFocus,
  onDone,
  onSaved,
  toast,
}: Props) {
  const t = useT()
  const run = useRun()
  // The viewer's own currency first (the workspace's country, else the browser's), then USD, CAD, GBP, AUD (C12).
  const viewer = currencyOfCountry(useDefaultPhoneCountry())
  // The labels follow the active language (t).
  const options = useMemo(
    () => countryDefaultOptions(currencyOptions(viewer), countryDefault, t),
    [t, viewer, countryDefault],
  )
  const savedText = moneyText(value, savedCurrency)
  const [text, setText] = useState(savedText)
  const [currency, setCurrency] = useState(savedCurrency)
  // Changed elsewhere (another tab, Insights): the fields follow.
  useEffect(() => setText(savedText), [savedText])
  useEffect(() => setCurrency(savedCurrency), [savedCurrency])
  const parsed = parseMoney(text, currency)
  const whole = currencyDigits(currency) === 0
  const invalid = parsed === undefined

  function save() {
    if (invalid || !canEdit) return
    onDone?.()
    if (parsed === value && currency === savedCurrency) return
    onSaved?.(parsed, currency)
    // The currency only when picked here: sent, it is set by hand and stops following the country.
    const picked = currency !== savedCurrency
    patchWorkspaceSettings({
      jobValueCents: parsed,
      jobValueCurrency: currency,
      ...(picked ? { jobValueCurrencyFollowsCountry: false } : {}),
    })
    void run('workspace.updateSettings', { jobValueCents: parsed, ...(picked ? { jobValueCurrency: currency } : {}) })
    toast(
      parsed === null
        ? t('insights.value.cleared')
        : t('insights.value.saved', { amount: formatMoney(parsed, currency) }),
    )
  }

  return (
    <form
      className={countryDefault ? 'av-form av-marked' : 'av-form'}
      onSubmit={e => {
        e.preventDefault()
        save()
      }}
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) save()
      }}
      onKeyDown={e => {
        if (e.key !== 'Escape') return
        if (text !== savedText || currency !== savedCurrency) {
          e.stopPropagation() // Esc puts the value back; it does not leave the page
          setText(savedText)
          setCurrency(savedCurrency)
        }
        onDone?.()
      }}
    >
      {label && (
        <label htmlFor={id} className="av-label">
          {label}
        </label>
      )}
      <div className="av-row">
        <Input
          id={id}
          inputMode={whole ? 'numeric' : 'decimal'}
          autoFocus={autoFocus}
          placeholder={fmt().number(350)}
          value={text}
          readOnly={!canEdit}
          invalid={invalid}
          onChange={e => setText(e.target.value)}
        />
        <Select
          label={t('insights.value.currency')}
          value={currency}
          options={options}
          onChange={setCurrency}
          disabled={!canEdit}
        />
      </div>
      {invalid && (
        <FormMessage>
          {whole ? t('insights.value.wholeNumber', { example: 5000 }) : t('insights.value.number', { a: 350, b: 1250 })}
        </FormMessage>
      )}
    </form>
  )
}
