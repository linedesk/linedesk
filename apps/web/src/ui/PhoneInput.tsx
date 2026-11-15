// The one phone number field of the app: a country picker (flag and calling code, searchable by name, ISO code and
// calling code) in the field's frame, then the number, formatted for that country as it is typed. Its value is E.164
// ("+4930123456"); a pasted international number (+49…, 0049…) picks its country. Whether the value is a whole phone
// number is phoneNumberProblem's (@linedesk/actions): the form shows it under the field (FormField `error`).
import { phonePlaceholder, phoneFromValue, typePhone } from '@linedesk/actions'
import {
  type ChangeEvent,
  type FocusEvent,
  Fragment,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { optionGroups } from './controls.tsx'
import { useAnchoredList } from './floating.ts'
import { cx, Icon } from './kit.tsx'
import {
  caretAfterDigits,
  digitsBefore,
  meantEdit,
  type PhoneCountryOption,
  phoneCountryOptions,
  searchPhoneCountries,
} from './phoneInputModel.ts'
import './phone-input.css'

type Props = {
  /** The number field's id: a FormField's label points at it. */
  id?: string
  /** E.164 ("+15035550142"), "" for none; a number saved as typed before ("(503) 555-0142") is read in `defaultCountry`. */
  value: string
  /** E.164 as far as typed ("+150355"), "" when the field is empty. */
  onChange: (e164: string) => void
  /** The country the field starts with while the value names none (useDefaultPhoneCountry). */
  defaultCountry: string
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  /** Without one: an example number of the picked country ("(201) 555-0123"). */
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
  autoFocus?: boolean
  /** The browser's autofill hint; "tel" by default, "off" for someone else's number. */
  autoComplete?: string
  size?: 'sm' | 'md'
  className?: string
  /** The number field, to focus it (e.g. when the form shows a problem under it). */
  inputRef?: Ref<HTMLInputElement | null>
}

/** Shows at most this many countries at once; the search narrows the rest. */
const SHOWN_MAX = 250

export function PhoneInput({
  id,
  value,
  onChange,
  defaultCountry,
  onBlur,
  onKeyDown,
  placeholder,
  invalid,
  disabled,
  autoFocus,
  autoComplete = 'tel',
  size = 'md',
  className,
  inputRef,
}: Props) {
  const [field, setField] = useState(() => phoneFromValue(value, defaultCountry))
  // The value this field sent last: a value from outside (a reset, a saved number) is shown anew, its own is not.
  const sent = useRef(value)
  // Picked by hand or by a pasted number: a default country that arrives later (settings loading) no longer moves it.
  const chosen = useRef(!!value.trim())
  const input = useRef<HTMLInputElement>(null)
  useImperativeHandle(inputRef, () => input.current as HTMLInputElement)
  const caret = useRef<number | null>(null)
  const deleting = useRef<'backward' | 'forward' | null>(null)

  useEffect(() => {
    if (value === sent.current) return
    sent.current = value
    chosen.current = chosen.current || !!value.trim()
    setField(current => phoneFromValue(value, current.country))
  }, [value])
  useEffect(() => {
    if (chosen.current || field.display) return
    setField(current => (current.display ? current : { ...current, country: defaultCountry }))
  }, [defaultCountry, field.display])

  // The caret stays after the same digit when the number is formatted again.
  useLayoutEffect(() => {
    if (caret.current === null || !input.current) return
    input.current.setSelectionRange(caret.current, caret.current)
    caret.current = null
  })

  function send(next: { country: string; display: string; e164: string }) {
    setField(next)
    if (next.e164 !== sent.current) {
      sent.current = next.e164
      onChange(next.e164)
    }
  }

  function onType(e: ChangeEvent<HTMLInputElement>) {
    const el = e.target
    const edit = meantEdit(field.display, el.value, el.selectionStart ?? el.value.length, deleting.current)
    deleting.current = null
    const next = typePhone(edit.text, field.country)
    if (next.country !== field.country) chosen.current = true
    const atEnd = edit.caret >= edit.text.length
    caret.current = atEnd ? next.display.length : caretAfterDigits(next.display, digitsBefore(edit.text, edit.caret))
    send(next)
  }

  function pickCountry(country: string) {
    chosen.current = true
    // The digits typed so far stay; they are formatted for the new country.
    const digits = field.display.replace(/\D/g, '')
    send(digits ? typePhone(digits, country) : { country, display: '', e164: '' })
    input.current?.focus()
  }

  return (
    <span
      className={cx(
        'k-input k-phone',
        size === 'sm' && 'k-input-sm',
        invalid && 'k-input-invalid',
        disabled && 'is-disabled',
        className,
      )}
    >
      <CountryPicker country={field.country} onPick={pickCountry} disabled={disabled} size={size} />
      <input
        ref={input}
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        placeholder={placeholder ?? phonePlaceholder(field.country)}
        value={field.display}
        onChange={onType}
        onBlur={onBlur}
        onKeyDown={e => {
          deleting.current = e.key === 'Backspace' ? 'backward' : e.key === 'Delete' ? 'forward' : null
          onKeyDown?.(e)
        }}
      />
    </span>
  )
}

type PickerProps = {
  country: string
  onPick: (country: string) => void
  disabled?: boolean
  size: 'sm' | 'md'
}

/**
 * The country of the number: a button with the flag and calling code; its list opens with a search. Arrow keys
 * move, Enter picks, Esc closes; typing a letter or digit on the button opens the list searching for it.
 */
function CountryPicker({ country, onPick, disabled, size }: PickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const options = phoneCountryOptions()
  const current = options.find(o => o.value === country)
  const matches = useMemo(
    () => (open ? searchPhoneCountries(options, query).slice(0, SHOWN_MAX) : []),
    [open, options, query],
  )
  // The list is as wide as the whole field (the frame around picker and number), never wider.
  const frame = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    frame.current = root.current?.closest('.k-phone') ?? root.current
  })
  useAnchoredList(open, frame, list, { match: true })

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

  function show(typed = '') {
    if (disabled) return
    setQuery(typed)
    setActive(
      typed
        ? 0
        : Math.max(
            0,
            options.findIndex(o => o.value === country),
          ),
    )
    setOpen(true)
  }
  function close() {
    setOpen(false)
    button.current?.focus()
  }
  function pick(option: PhoneCountryOption) {
    setOpen(false)
    onPick(option.value)
  }
  function onButtonKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      show()
    } else if (/^[\p{L}\d+]$/u.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      show(e.key)
    }
  }
  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    // The search owns its keys: none of them reaches the app's shortcuts or closes a dialog around it.
    e.stopPropagation()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(i => Math.min(matches.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(i => Math.max(0, i - 1))
    } else if (e.key === 'Home' && !query) {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End' && !query) {
      e.preventDefault()
      setActive(matches.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const option = matches[active]
      if (option) pick(option)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') setOpen(false)
  }

  const label = current ? `${current.name} +${current.callingCode}` : country
  const searching = !!query.trim()
  return (
    <span className="k-phone-country" ref={root}>
      <button
        ref={button}
        type="button"
        className="k-phone-country-btn"
        disabled={disabled}
        title={`Country code: ${label}`}
        aria-label={`Country code: ${label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
        onKeyDown={onButtonKey}
      >
        <span className="k-phone-flag" aria-hidden="true">
          {current?.flag}
        </span>
        <span className="k-phone-code">+{current?.callingCode}</span>
        <Icon name="down" size={size === 'sm' ? 12 : 14} />
      </button>
      {open && (
        <div ref={list} popover="manual" className="k-select-list k-phone-list k-float">
          <input
            autoFocus
            className="k-phone-search"
            placeholder="Search a country or +49"
            aria-label="Search countries"
            aria-controls={listId}
            aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onSearchKey}
          />
          <div id={listId} role="listbox" aria-label="Countries" className="k-phone-options">
            {(searching ? [{ group: undefined, start: 0, options: matches }] : optionGroups(matches)).map(run => {
              const items = run.options.map((o, k) => {
                const i = run.start + k
                return (
                  <div
                    key={o.value}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={o.value === country}
                    className={cx('k-select-opt', i === active && 'active')}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                  >
                    <span className="k-phone-flag" aria-hidden="true">
                      {o.flag}
                    </span>
                    <span className="k-phone-opt-name">{o.name}</span>
                    <span className="k-phone-opt-code">+{o.callingCode}</span>
                    {o.value === country && <Icon name="check" size={14} />}
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
            {!matches.length && <div className="k-phone-empty">No country matches "{query}".</div>}
          </div>
        </div>
      )}
    </span>
  )
}
