// The area code of a new number: the area codes a number can be bought in, of the workspace's country (AREA_CODES:
// the US, Canada, Puerto Rico), as a searchable list under the field, built like CarrierNumberInput. Search by code,
// city, state or province ("503", "portland", "OR", "ontario"). Only a code from the list is taken: the value is the
// three digits, or empty while what is typed is not one of them.
import {
  type AreaCode,
  areaCodeLabel,
  areaCodesIn,
  BUYABLE_AREA_CODES,
  buyableAreaCode,
  searchAreaCodes,
} from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Input } from '../ui/form.tsx'
import { useAnchoredList } from '../ui/floating.ts'
import { cx, Icon } from '../ui/kit.tsx'

/** "503 · Portland, OR" for a code in the list; the code itself otherwise. */
export const areaCodeText = (code: string): string => {
  const a = buyableAreaCode(code)
  return a ? areaCodeLabel(a) : code
}

/** The codes a workspace in `country` picks from; no country (Server admin › Providers, Try it): every buyable one. */
export const areaCodeList = (country?: string | null): readonly AreaCode[] =>
  country ? areaCodesIn(country) : BUYABLE_AREA_CODES

/**
 * The area codes to show for what is in the field. The label of the picked code (shown when the field opens) is no
 * search: the whole list shows, so another code is one arrow key away.
 */
export function areaCodeMatches(query: string, value: string, list: readonly AreaCode[] = BUYABLE_AREA_CODES) {
  return value && query === areaCodeText(value) ? [...list] : searchAreaCodes(list, query)
}

/** The code typed in full ("503", " 503 "), when it is in the list: taken without picking it. */
export const typedAreaCode = (query: string, list: readonly AreaCode[] = BUYABLE_AREA_CODES): string => {
  const digits = query.trim()
  return /^\d{3}$/.test(digits) && list.some(a => a.code === digits) ? digits : ''
}

/**
 * `label` names the field for screen readers where no visible label points at `id` (Server admin › Providers, Try it).
 * `country`: the workspace's, whose area codes are listed; none: every country's numbers can be bought in.
 */
type Props = { id: string; value: string; onChange: (code: string) => void; label?: string; country?: string | null }

export function AreaCodeInput({ id, value, onChange, label, country }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(() => areaCodeText(value))
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const codes = useMemo(() => areaCodeList(country), [country])
  const matches = useMemo(() => areaCodeMatches(query, value, codes), [query, value, codes])
  useAnchoredList(open, root, list, { match: true })

  // Closed, the field shows the picked code with its city (or nothing): what was typed and not picked is dropped.
  useEffect(() => {
    if (!open) setQuery(areaCodeText(value))
  }, [open, value])
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])

  function show() {
    if (open) return
    setQuery(areaCodeText(value))
    // Opens on the picked code.
    setActive(
      Math.max(
        0,
        codes.findIndex(a => a.code === value),
      ),
    )
    setOpen(true)
  }
  function pick(code: string) {
    setOpen(false)
    setQuery(areaCodeText(code))
    if (code !== value) onChange(code)
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      if (!open) return show()
      setActive(i => (e.key === 'ArrowDown' ? Math.min(matches.length - 1, i + 1) : Math.max(0, i - 1)))
    } else if (e.key === 'Enter' && open && matches[active]) {
      // Takes the highlighted code; the next Enter goes on as before.
      e.preventDefault()
      e.stopPropagation()
      pick(matches[active].code)
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div className={cx('k-select', 'cn-pick', open && 'open')} ref={root}>
      <Input
        id={id}
        aria-label={label}
        value={query}
        placeholder={t('settings.areaCode.search')}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        onFocus={e => {
          show()
          e.currentTarget.select()
        }}
        onClick={show}
        onChange={e => {
          const next = e.target.value
          setQuery(next)
          setActive(0)
          setOpen(true)
          const typed = typedAreaCode(next, codes)
          if (typed !== value) onChange(typed)
        }}
        onKeyDown={onKey}
        end={<Icon name="down" size={14} />}
      />
      {open && (
        <div
          ref={list}
          id={listId}
          popover="manual"
          role="listbox"
          aria-label={t('settings.areaCode.list')}
          className="k-select-list cn-list k-float"
        >
          {matches.map((a, i) => (
            <div
              key={a.code}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={a.code === value}
              className={cx('k-select-opt', i === active && 'active')}
              onMouseEnter={() => setActive(i)}
              // Keeps the focus in the field, so the list does not close before the click.
              onMouseDown={e => e.preventDefault()}
              onClick={() => pick(a.code)}
            >
              <span className="k-select-opt-t">{areaCodeLabel(a)}</span>
              {a.code === value && <Icon name="check" size={14} />}
            </div>
          ))}
          {!matches.length && <div className="cn-empty">{t('settings.areaCode.noMatch')}</div>}
        </div>
      )}
    </div>
  )
}
