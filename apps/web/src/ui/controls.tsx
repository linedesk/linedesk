// Form controls of the UI kit: Checkbox, Switch, RadioCard and Select. Use these instead of the
// browser's own controls, so every page looks the same. Styles in controls.css (k-check, sw,
// k-radio, k-select). Checkbox and RadioCard keep a hidden native input for keyboard and screen readers.
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useAnchoredList } from './floating.ts'
import { cx, Icon } from './kit.tsx'
import './controls.css'
import { useT } from '@linedesk/i18n/react'

type CheckboxProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  children?: ReactNode
  label?: string
  disabled?: boolean
  className?: string
  /** Some but not all of a group are checked: a dash instead of the tick. */
  indeterminate?: boolean
}

export function Checkbox({ checked, onChange, children, label, disabled, className, indeterminate }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  })
  return (
    <label className={cx('k-check', disabled && 'k-check-off', className)}>
      <input
        ref={ref}
        type="checkbox"
        className="k-check-input"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="k-check-box" aria-hidden="true">
        <Icon name="check" size={12} />
      </span>
      {children && <span className="k-check-text">{children}</span>}
    </label>
  )
}

export function Switch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean
  onChange: (on: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      className="sw"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  )
}

type RadioCardProps = {
  name: string
  checked: boolean
  onPick: () => void
  title: ReactNode
  description?: ReactNode
  disabled?: boolean
}

/** One choice of a radio group, as a card: put several in a `role="radiogroup"` container. */
export function RadioCard({ name, checked, onPick, title, description, disabled }: RadioCardProps) {
  const id = useId()
  return (
    <label className={cx('k-radio', checked && 'on', disabled && 'k-radio-off')} htmlFor={id}>
      <input
        id={id}
        type="radio"
        className="k-radio-input"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onPick}
      />
      <span className="k-radio-dot" aria-hidden="true" />
      <span className="k-radio-text">
        <b>{title}</b>
        {description && <span>{description}</span>}
      </span>
    </label>
  )
}

export type SelectOption<T extends string> = {
  value: T
  label: string
  description?: string
  /**
   * A heading over this option and the ones after it with the same group ("All currencies"), with a line above it.
   * Options without one come first, with no heading. The heading is not an option: arrow keys and typing skip it.
   */
  group?: string
  /** Shown but not pickable; `description` says why ("Has an owner"). */
  disabled?: boolean
}

/** The options as the list shows them: runs of consecutive options with the same group, each with its first index. */
export function optionGroups<O extends { group?: string }>(
  options: readonly O[],
): { group: string | undefined; start: number; options: O[] }[] {
  const runs: { group: string | undefined; start: number; options: O[] }[] = []
  options.forEach((o, i) => {
    const last = runs.at(-1)
    if (last && last.group === o.group) last.options.push(o)
    else runs.push({ group: o.group, start: i, options: [o] })
  })
  return runs
}

type SelectProps<T extends string> = {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  /** Accessible name; also the tooltip. */
  label: string
  id?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  /** Which edge of the button the open list lines up with; `end` for a select at the right of a row. */
  align?: 'start' | 'end'
}

/** Keys typed within this many ms of each other form one search ("los a"). */
const TYPEAHEAD_MS = 700

/**
 * The option whose label starts with what was typed, or -1. The first letter searches from the top,
 * further letters from the option found (`from`), and the same letter again moves to the next one.
 */
export function typeaheadIndex(labels: readonly string[], typed: string, from: number): number {
  const query = typed.toLowerCase()
  const repeat = query.length > 1 && [...query].every(c => c === query[0])
  const prefix = repeat ? query[0]! : query
  // A new search starts at the top; more letters refine from where it is; the same letter again moves on.
  const start = repeat ? from + 1 : query.length === 1 ? 0 : from
  for (let k = 0; k < labels.length; k++) {
    const i = (start + k) % labels.length
    if (labels[i]!.toLowerCase().startsWith(prefix)) return i
  }
  return -1
}

/** A button that opens a list. Arrow keys move, typing jumps to a label, Enter or Space picks, Esc closes. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  size = 'md',
  align = 'start',
}: SelectProps<T>) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = options.find(o => o.value === value)
  const typed = useRef({ text: '', at: 0 })
  useAnchoredList(open, button, list, { minWidth: 240, align })

  useEffect(() => {
    if (!open) return
    list.current?.focus()
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])

  // A long list (time zones) keeps the active option in view while the keys move it.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])

  function jumpTo(key: string) {
    const now = Date.now()
    typed.current = { text: now - typed.current.at < TYPEAHEAD_MS ? typed.current.text + key : key, at: now }
    const i = typeaheadIndex(
      options.map(o => o.label),
      typed.current.text,
      active,
    )
    if (i >= 0) setActive(i)
  }

  function show() {
    if (disabled) return
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
  function pick(option: SelectOption<T>) {
    if (option.disabled) return
    close()
    if (option.value !== value) onChange(option.value)
  }
  function onButtonKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      show()
    }
  }
  function onListKey(e: KeyboardEvent) {
    // The list owns its keys: none of them reaches the app's shortcuts.
    e.stopPropagation()
    if (e.key === 'Tab') return setOpen(false)
    e.preventDefault()
    if (e.key === 'ArrowDown') setActive(i => Math.min(options.length - 1, i + 1))
    else if (e.key === 'ArrowUp') setActive(i => Math.max(0, i - 1))
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(options.length - 1)
    else if (e.key === 'Enter' || (e.key === ' ' && Date.now() - typed.current.at >= TYPEAHEAD_MS)) {
      const o = options[active]
      if (o) pick(o)
    } else if (e.key === 'Escape') close()
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) jumpTo(e.key)
  }

  return (
    <div className={cx('k-select', `k-select-${size}`, align === 'end' && 'k-select-end', open && 'open')} ref={root}>
      <button
        ref={button}
        id={id}
        type="button"
        className="k-select-btn"
        disabled={disabled}
        title={label}
        aria-label={`${label}: ${current?.label ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={onButtonKey}
      >
        <span>{current?.label ?? t('common.select.choose')}</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div
          ref={list}
          id={listId}
          popover="manual"
          className="k-select-list k-float"
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
        >
          {optionGroups(options).map(run => {
            const items = run.options.map((o, k) => {
              const i = run.start + k
              return (
                <div
                  key={o.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled || undefined}
                  className={cx('k-select-opt', i === active && 'active', o.disabled && 'is-off')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o)}
                >
                  <span className="k-select-opt-t">
                    <span>{o.label}</span>
                    {o.description && <small>{o.description}</small>}
                  </span>
                  {o.value === value && <Icon name="check" size={14} />}
                </div>
              )
            })
            if (run.group === undefined) return <Fragment key={run.start}>{items}</Fragment>
            const headingId = `${listId}-g${run.start}`
            return (
              <div key={run.start} role="group" aria-labelledby={headingId} className="k-select-group">
                <div id={headingId} role="presentation" className="k-select-group-h">
                  {run.group}
                </div>
                {items}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
