// The number field of "Use a number you have": the phone field (country picker and number, value in E.164) with the
// numbers in the carrier account as a searchable list under it, read once from the carrier
// (phoneNumber.listCarrierNumbers, free). Typing a number that is not listed still works, and without a list (no
// access, carrier not reachable) it is the plain phone field.
import type { CarrierNumbersData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { formatNumber } from '../onboarding/flow.ts'
import { useAnchoredList } from '../ui/floating.ts'
import { cx } from '../ui/kit.tsx'
import { PhoneInput } from '../ui/PhoneInput.tsx'
import { readAction } from './settings-api.ts'

const loadCarrierNumbers = () => readAction<CarrierNumbersData>('phoneNumber.listCarrierNumbers')

/**
 * The numbers whose digits contain the typed digits; all of them while nothing (or no digit) is typed. `typed` is the
 * phone field's value (E.164 as far as typed, "+150355") or text as typed.
 */
export function matchCarrierNumbers(numbers: readonly string[], typed: string): string[] {
  const digits = typed.replace(/\D/g, '')
  if (!digits) return [...numbers]
  return numbers.filter(n => n.replace(/\D/g, '').includes(digits))
}

type Props = {
  id: string
  /** E.164 as far as typed, "" for none (PhoneInput's value). */
  value: string
  onChange: (e164: string) => void
  /** The country the field starts with (useDefaultPhoneCountry). */
  defaultCountry: string
  invalid?: boolean
}

export function CarrierNumberInput({ id, value, onChange, defaultCountry, invalid }: Props) {
  const t = useT()
  const { data } = useQuery('phoneNumber.carrierNumbers', loadCarrierNumbers)
  const numbers = data?.numbers ?? []
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const matches = useMemo(() => matchCarrierNumbers(numbers, value), [numbers, value])
  const shown = open && numbers.length > 0
  useAnchoredList(shown, root, list, { match: true })

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  useEffect(() => {
    if (shown) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [shown, active, listId])

  function pick(e164: string) {
    onChange(e164)
    setOpen(false)
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (!numbers.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      if (!open) {
        setOpen(true)
        setActive(0)
        return
      }
      setActive(i => (e.key === 'ArrowDown' ? Math.min(matches.length - 1, i + 1) : Math.max(0, i - 1)))
    } else if (e.key === 'Enter' && shown && matches[active]) {
      // Takes the highlighted number; the next Enter goes on as before.
      e.preventDefault()
      e.stopPropagation()
      pick(matches[active])
    } else if (e.key === 'Escape' && shown) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div className={cx('k-select', 'cn-pick', shown && 'open')} ref={root}>
      <PhoneInput
        id={id}
        value={value}
        defaultCountry={defaultCountry}
        invalid={invalid}
        autoComplete="off"
        placeholder={numbers.length ? t('settings.carrier.numbers.placeholder') : undefined}
        onChange={e164 => {
          onChange(e164)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={onKey}
        // Picking a listed number keeps the focus in the field; leaving it (the country picker too) closes the list.
        onBlur={() => setOpen(false)}
        combobox={
          numbers.length
            ? {
                role: 'combobox',
                'aria-expanded': shown,
                'aria-controls': listId,
                'aria-autocomplete': 'list',
                'aria-activedescendant': shown && matches[active] ? `${listId}-${active}` : undefined,
                onFocus: () => setOpen(true),
                onClick: () => setOpen(true),
              }
            : undefined
        }
      />
      {shown && (
        <div
          ref={list}
          id={listId}
          popover="manual"
          role="listbox"
          aria-label={t('settings.carrier.numbers.list')}
          className="k-select-list cn-list k-float"
        >
          {matches.map((n, i) => (
            <div
              key={n}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cx('k-select-opt', i === active && 'active')}
              onMouseEnter={() => setActive(i)}
              // Keeps the focus in the field, so the list does not close before the click.
              onMouseDown={e => e.preventDefault()}
              onClick={() => pick(n)}
            >
              <span className="k-select-opt-t">{formatNumber(n)}</span>
            </div>
          ))}
          {!matches.length && <div className="cn-empty">{t('settings.carrier.numbers.noMatch')}</div>}
          {data?.more && <div className="cn-empty">{t('settings.carrier.numbers.more')}</div>}
        </div>
      )}
    </div>
  )
}
