// Form pieces of the UI kit, one pattern for every edit form: a Card per section (title and at most
// one line of description), a FormField per control (label above, a short description only when
// needed, the validation message under it), a SaveBar that shows only while the form has changes,
// and a Dialog for forms that open from a list. Styles in form.css (k-card, k-field, k-dialog, …).

import {
  Children,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { dayFieldLabel } from '../time.ts'
import { Backdrop } from './Backdrop.tsx'
import { type HelpContent, HelpTip, helpContent } from './HelpTip.tsx'
import { Button, cx, Icon } from './kit.tsx'
import './form.css'
import { NO_PASSWORD_MANAGER } from './passwordManager.ts'
import { useT } from '@linedesk/i18n/react'

export { type HelpContent, HelpTip } from './HelpTip.tsx'

type CardProps = {
  id?: string
  /** Without a title the card has no header (a form that its page already names). */
  title?: ReactNode
  /** One short line. Anything longer goes in `help`. */
  description?: ReactNode
  /** Secondary detail, behind a (?) next to the title (HelpTip). */
  help?: HelpContent
  /** Controls at the right of the title, e.g. a switch or an Add button. */
  actions?: ReactNode
  className?: string
  children?: ReactNode
}

/** A section of a settings page: a raised card with a title row. */
export function Card({ id, title, description, help, actions, className, children }: CardProps) {
  const headingId = id && title ? `${id}-h` : undefined
  return (
    <section id={id} className={cx('k-card', className)} aria-labelledby={headingId}>
      {(title || actions) && (
        <header className="k-card-head">
          <div className="k-card-title">
            {title && (
              <h2 id={headingId}>
                {title}
                {help && <HelpTip {...helpContent(help)} />}
              </h2>
            )}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="k-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

type FieldProps = {
  /** The control's id: the label points at it. */
  id?: string
  label: ReactNode
  /** Muted line under the label, only when the label alone is not enough. */
  description?: ReactNode
  /** Detail behind a (?) next to the label (HelpTip). */
  help?: HelpContent
  /** The validation message, shown under the control. */
  error?: string | null
  /** Shown next to the label, e.g. "Optional". */
  aside?: ReactNode
  /** Right after the label, outside it: a small button about the label's words (e.g. edit business hours). */
  labelAfter?: ReactNode
  className?: string
  children: ReactNode
}

export function FormField({ id, label, description, help, error, aside, labelAfter, className, children }: FieldProps) {
  return (
    <div className={cx('k-field', error && 'k-field-invalid', className)}>
      <div className="k-field-label">
        <label htmlFor={id}>{label}</label>
        {labelAfter}
        {help && <HelpTip {...helpContent(help)} />}
        {aside && <span className="k-field-aside">{aside}</span>}
      </div>
      {description && <p className="k-field-desc">{description}</p>}
      {children}
      {error && <FormMessage>{error}</FormMessage>}
    </div>
  )
}

/** A validation message under a field. */
export function FormMessage({ children }: { children: ReactNode }) {
  return (
    <p className="k-field-msg" role="alert">
      {children}
    </p>
  )
}

type InputProps = Omit<ComponentProps<'input'>, 'size'> & {
  invalid?: boolean
  end?: ReactNode
  /** The control height (--control-h, --control-h-sm), the same scale as Select and Button: one size per row. */
  size?: 'sm' | 'md'
}

/** A text input in the kit's frame. `end` sits inside the frame at the right (a unit, a button). */
export function Input({ invalid, end, size = 'md', className, ...rest }: InputProps) {
  return (
    <span className={cx('k-input', size === 'sm' && 'k-input-sm', invalid && 'k-input-invalid', className)}>
      <input aria-invalid={invalid || undefined} {...rest} />
      {end}
    </span>
  )
}

type DateInputProps = Omit<ComponentProps<'input'>, 'size' | 'type' | 'value' | 'onChange' | 'placeholder'> & {
  /** "YYYY-MM-DD", or "" for no day. */
  value: string
  onChange: (value: string) => void
  /** Shown while no day is picked. */
  placeholder?: string
  invalid?: boolean
  size?: 'sm' | 'md'
}

/**
 * A day field in the Input frame that shows the day the app's way ("Nov 14, 2026") whatever the browser's
 * language; a plain `<input type="date">` shows "tt.mm.jjjj" on a German Mac. The native field stays, see-through
 * over the frame, for the browser's calendar, min and max, forms and screen readers: a click, Enter, Space or
 * Alt+Down opens the calendar, Backspace or Delete clears the day.
 */
export function DateInput({
  value,
  onChange,
  placeholder,
  invalid,
  size = 'md',
  className,
  disabled,
  required,
  onClick,
  onKeyDown,
  ...rest
}: DateInputProps) {
  const t = useT()
  const open = (input: HTMLInputElement) => {
    try {
      input.showPicker()
    } catch {
      // Not allowed here (no user gesture, an older browser): the arrow keys still change the day.
    }
  }
  return (
    <span
      className={cx(
        'k-input k-date',
        size === 'sm' && 'k-input-sm',
        invalid && 'k-input-invalid',
        disabled && 'is-disabled',
        className,
      )}
    >
      <Icon name="calendar" size={size === 'sm' ? 13 : 14} />
      <span className={cx('k-date-text', !value && 'is-empty')} aria-hidden="true">
        {value ? dayFieldLabel(value) : (placeholder ?? t('common.dateInput.placeholder'))}
      </span>
      <input
        type="date"
        value={value}
        disabled={disabled}
        required={required}
        aria-invalid={invalid || undefined}
        onChange={e => onChange(e.target.value)}
        onClick={e => {
          onClick?.(e)
          if (!e.defaultPrevented) open(e.currentTarget)
        }}
        onKeyDown={e => {
          onKeyDown?.(e)
          if (e.defaultPrevented) return
          if (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown')) {
            e.preventDefault()
            open(e.currentTarget)
          } else if ((e.key === 'Backspace' || e.key === 'Delete') && !required) {
            e.preventDefault()
            onChange('')
          } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
            // Typed digits would go into the browser's hidden day, month and year parts, in its own order: off.
            e.preventDefault()
          }
        }}
        {...rest}
      />
    </span>
  )
}

export function Textarea({ invalid, className, ...rest }: ComponentProps<'textarea'> & { invalid?: boolean }) {
  return (
    <textarea
      className={cx('ta', invalid && 'k-input-invalid', className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  )
}

type SecretProps = {
  id: string
  value: string
  onChange: (value: string) => void
  /** Last four characters of the stored secret: shows "•••• 1234 · Replace" until Replace is chosen. */
  storedLast4?: string | null
  placeholder?: string
  autoFocus?: boolean
  invalid?: boolean
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
}

/**
 * A secret (API key, token). Not type=password: browsers offer to save a password field as a login
 * and the key would end up in the password manager, so it is masked by CSS and can be shown.
 */
export function SecretInput({
  id,
  value,
  onChange,
  storedLast4,
  placeholder,
  autoFocus,
  invalid,
  onKeyDown,
}: SecretProps) {
  const t = useT()
  const [shown, setShown] = useState(false)
  const [replacing, setReplacing] = useState(!storedLast4)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (replacing && storedLast4) input.current?.focus()
  }, [replacing, storedLast4])

  if (!replacing) {
    return (
      <div className="k-secret-stored">
        <span className="k-secret-dots" id={id}>
          •••• {storedLast4}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setReplacing(true)} autoFocus={autoFocus}>
          {t('common.action.replace')}
        </Button>
      </div>
    )
  }
  return (
    <Input
      ref={input}
      id={id}
      type="text"
      className={cx(!shown && 'k-secret')}
      {...NO_PASSWORD_MANAGER}
      // Typed exactly as given: no capital first letter or correction on phones (an iCloud app password is lower case).
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      autoFocus={autoFocus}
      invalid={invalid}
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      end={
        <button
          type="button"
          className="k-input-btn"
          aria-pressed={shown}
          aria-label={shown ? t('common.secret.hide') : t('common.secret.show')}
          title={shown ? t('common.secret.hide') : t('common.secret.show')}
          onClick={() => setShown(s => !s)}
        >
          <Icon name={shown ? 'eyeOff' : 'eye'} size={14} />
        </button>
      }
    />
  )
}

export function Separator() {
  return <hr className="k-sep" />
}

/** ⌘S or ⌘↵ (Ctrl on Windows and Linux) submits the form, instead of the browser saving the page. */
export function onSaveKey(e: KeyboardEvent<HTMLFormElement>, canSave: boolean) {
  if (!(e.metaKey || e.ctrlKey) || (e.key.toLowerCase() !== 's' && e.key !== 'Enter')) return
  e.preventDefault()
  if (canSave) e.currentTarget.requestSubmit()
}

type SaveBarProps = {
  dirty: boolean
  saving?: boolean
  onCancel: () => void
  /** Why Save is off, e.g. a field is invalid. */
  disabled?: boolean
  label?: string
  /** Replaces "Unsaved changes", e.g. to say which sections have them. */
  note?: ReactNode
}

/** Cancel and Save, sticky at the bottom; shows only while there are changes. Submit the form to save. */
export function SaveBar({ dirty, saving, onCancel, disabled, label, note }: SaveBarProps) {
  const t = useT()
  if (!dirty && !saving) return null
  return (
    <div className="k-savebar" role="region" aria-label={t('common.unsaved')}>
      <span className="k-savebar-note">{note ?? t('common.unsaved')}</span>
      <Button variant="ghost" onClick={onCancel} disabled={saving} title={t('common.saveBar.undoTip')}>
        {t('common.action.cancel')}
      </Button>
      <Button
        busy={saving}
        type="submit"
        variant="primary"
        disabled={saving || disabled}
        shortcut={['⌘', 'S']}
        title={t('common.action.saveWithKey', { key: '⌘S' })}
      >
        {saving ? t('common.action.saving') : (label ?? t('common.action.save'))}
      </Button>
    </div>
  )
}

type DialogProps = {
  title: ReactNode
  description?: ReactNode
  /** Shown left of the title, e.g. a logo. */
  icon?: ReactNode
  onClose: () => void
  /** Buttons at the bottom. */
  footer?: ReactNode
  /** Makes body and footer one form: Enter in a field submits, ⌘S too. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void
  size?: 'sm' | 'md' | 'lg'
  children?: ReactNode
}

/** A modal over the page. Esc, the ✕ or a click outside closes it; focus stays inside. */
export function Dialog({ title, description, icon, onClose, footer, onSubmit, size = 'md', children }: DialogProps) {
  const t = useT()
  const titleId = useId()
  const descId = useId()
  const box = useRef<HTMLDivElement>(null)
  // Focus starts in the first field (the backdrop's trap would pick the ✕, the first control in the DOM).
  useEffect(() => {
    const at = document.activeElement
    if (at && box.current?.querySelector('.k-dialog-body')?.contains(at)) return
    const body = box.current?.querySelector('.k-dialog-body')
    ;(
      body?.querySelector<HTMLElement>(':is(input, textarea):not(:disabled)') ??
      body?.querySelector<HTMLElement>('.k-btn-primary:not(:disabled)')
    )?.focus()
  }, [])
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    onClose()
  }
  const content = (
    <>
      {Children.toArray(children).length > 0 && <div className="k-dialog-body">{children}</div>}
      {footer && <footer className="k-dialog-foot">{footer}</footer>}
    </>
  )
  return (
    <Backdrop onClose={onClose}>
      <div
        ref={box}
        className={cx('k-dialog', `k-dialog-${size}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        onKeyDown={onKey}
      >
        <header className="k-dialog-head">
          {icon}
          <div className="k-dialog-title">
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descId}>{description}</p>}
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon="close"
            aria-label={t('common.action.close')}
            title={t('common.action.closeWithKey', { key: 'esc' })}
            onClick={onClose}
          />
        </header>
        {onSubmit ? (
          <form className="k-dialog-form" noValidate onSubmit={onSubmit} onKeyDown={e => onSaveKey(e, true)}>
            {content}
          </form>
        ) : (
          content
        )}
      </div>
    </Backdrop>
  )
}
