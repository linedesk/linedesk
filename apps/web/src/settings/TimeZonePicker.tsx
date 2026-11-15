// The business's time zone as a searchable list: each zone with its GMT offset and the time there now. Search by
// city, region, zone name or offset ("berlin", "eastern", "gmt+1", "utc-5").
import { useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAnchoredList } from '../ui/floating.ts'
import { cx, Icon } from '../ui/kit.tsx'
import {
  browserTimeZone,
  clockIn,
  gmtOffset,
  searchTimeZones,
  timeZoneLabel,
  timeZoneOptions,
  timeZoneSearchExample,
} from './timeZones.ts'

/** The time shown moves on while the page is open. */
function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

/** Shows at most this many zones at once; the search narrows the rest. */
const SHOWN_MAX = 120

type Props = { value: string; onChange: (zone: string) => void; disabled?: boolean; id?: string }

export function TimeZonePicker({ value, onChange, disabled, id }: Props) {
  const t = useT()
  const now = useNow()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const options = useMemo(() => timeZoneOptions(value), [value])
  const matches = useMemo(
    () => (open ? searchTimeZones(options, query, now).slice(0, SHOWN_MAX) : []),
    [open, options, query, now],
  )

  useAnchoredList(open, button, list, { minWidth: 240 })
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
    if (disabled) return
    setQuery('')
    setActive(
      Math.max(
        0,
        options.findIndex(o => o.value === value),
      ),
    )
    setOpen(true)
  }
  function close() {
    setOpen(false)
    button.current?.focus()
  }
  function pick(zone: string) {
    close()
    if (zone !== value) onChange(zone)
  }
  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    // The search owns its keys: none of them reaches the app's shortcuts.
    e.stopPropagation()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(i => Math.min(matches.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const zone = matches[active]
      if (zone) pick(zone.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') setOpen(false)
  }

  const offset = gmtOffset(value, now)
  const clock = clockIn(value, now)
  return (
    <div className={cx('k-select', 'k-select-md', 'tz', open && 'open')} ref={root}>
      <button
        ref={button}
        id={id}
        type="button"
        className="k-select-btn"
        disabled={disabled}
        title={t('settings.timeZone.label')}
        aria-label={t('settings.timeZone.button', { zone: timeZoneLabel(value), offset, clock })}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            show()
          }
        }}
      >
        <span>{timeZoneLabel(value)}</span>
        <span className="tz-meta">
          {offset} · {clock}
        </span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div ref={list} popover="manual" className="k-select-list tz-list k-float">
          <input
            autoFocus
            className="tz-search"
            placeholder={t('settings.timeZone.searchPlaceholder', {
              example: timeZoneSearchExample(browserTimeZone(), now),
            })}
            aria-label={t('settings.timeZone.search')}
            aria-controls={listId}
            aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onSearchKey}
          />
          <div id={listId} role="listbox" aria-label={t('settings.timeZone.list')} className="tz-options">
            {matches.map((o, i) => (
              <div
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={o.value === value}
                className={cx('k-select-opt', i === active && 'active')}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
              >
                <span className="k-select-opt-t">
                  <span>{o.label}</span>
                </span>
                <span className="tz-meta">
                  {gmtOffset(o.value, now)} · {clockIn(o.value, now)}
                </span>
                {o.value === value && <Icon name="check" size={14} />}
              </div>
            ))}
            {!matches.length && <div className="tz-empty">{t('settings.timeZone.noMatch', { query })}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
