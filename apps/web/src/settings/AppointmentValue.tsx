// What one booked appointment is worth on average, and in which currency (workspace.updateSettings,
// jobValueCents and jobValueCurrency): set in Workspace settings › General and from the Insights summary,
// which multiplies it by the booked appointments.
import { currencyDigits, type JobValueCurrency } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import { CURRENCY_OPTIONS, formatMoney, moneyText, parseMoney } from '../insights/insightsModel.ts'
import { useRun } from '../store.tsx'
import { Select } from '../ui/controls.tsx'
import { FormMessage, Input } from '../ui/form.tsx'
import { patchWorkspaceSettings } from './settings-api.ts'
import './appointmentValue.css'

type Props = {
  /** The amount field's id, for the label around it. */
  id: string
  value: number | null
  currency: JobValueCurrency
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
  canEdit,
  label,
  autoFocus,
  onDone,
  onSaved,
  toast,
}: Props) {
  const run = useRun()
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
    patchWorkspaceSettings({ jobValueCents: parsed, jobValueCurrency: currency })
    void run('workspace.updateSettings', { jobValueCents: parsed, jobValueCurrency: currency })
    toast(
      parsed === null
        ? 'Appointment value cleared.'
        : `A booked appointment counts as ${formatMoney(parsed, currency)}.`,
    )
  }

  return (
    <form
      className="av-form"
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
          placeholder="e.g. 350"
          value={text}
          readOnly={!canEdit}
          invalid={invalid}
          onChange={e => setText(e.target.value)}
        />
        <Select
          label="Currency"
          value={currency}
          options={CURRENCY_OPTIONS}
          onChange={setCurrency}
          disabled={!canEdit}
        />
      </div>
      {invalid && <FormMessage>{whole ? 'A whole number, like 5,000.' : 'A number, like 350 or 1,250.'}</FormMessage>}
    </form>
  )
}
