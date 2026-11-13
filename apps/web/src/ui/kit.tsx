// The small pieces of the reference UI kit: Icon, Kbd, Button, Badge. Class names match styles.css.
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { useBrand } from '../brand.ts'
import { filledIcons, icons, type IconName } from './icons.ts'

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const filled = filledIcons.has(name)
  return (
    <svg
      className={cx('k-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icons[name].map(([Tag, attrs]) => (
        <Tag key={Object.values(attrs).join(' ')} {...attrs} />
      ))}
    </svg>
  )
}

export type NoteTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
const noteIcons: Record<NoteTone, IconName | null> = {
  neutral: null,
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'alert',
}

type NoteProps = {
  tone?: NoteTone
  /** One short sentence: what is going on. The body says what it means or what to do. */
  title?: ReactNode
  /** Buttons on the right (e.g. "Back to Phone"). Links to read more go in the body. */
  action?: ReactNode
  /** Defaults: danger "alert" (announced at once), success "status", the rest "note". */
  role?: 'alert' | 'status' | 'note'
  id?: string
  className?: string
  children?: ReactNode
}

/**
 * The one way to show a message on a page (docs/design-principles.md, Messages): neutral for a plain hint, info for
 * context, success for a result, warning when it works but something important is missing, danger when it failed.
 * Not for the result of a click (that is a toast) or a problem with one field (that is the field's error line).
 */
export function Note({ tone = 'neutral', title, action, role, id, className, children }: NoteProps) {
  const icon = noteIcons[tone]
  return (
    <div
      className={cx('k-note', tone !== 'neutral' && `k-note-${tone}`, className)}
      role={role ?? (tone === 'danger' ? 'alert' : tone === 'success' ? 'status' : 'note')}
      id={id}
    >
      {icon && <Icon name={icon} size={16} className="k-note-icon" />}
      <div className="k-note-body">
        {title && <strong className="k-note-title">{title}</strong>}
        {children && <div className="k-note-text">{children}</div>}
      </div>
      {action && <div className="k-note-action">{action}</div>}
    </div>
  )
}

export function Kbd({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cx('k-kbds', className)}>
      {keys.map(k => (
        <kbd key={k} className="k-kbd">
          {k}
        </kbd>
      ))}
    </span>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `danger-outline`: a weighty step that destroys nothing (red text and border, no red fill). */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline'
  size?: 'sm' | 'md'
  icon?: IconName
  shortcut?: string[]
  /** Working on it: a small spinner in place of the icon, the button disabled, no shortcut shown. */
  busy?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  shortcut,
  busy,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'k-btn',
        `k-btn-${variant}`,
        `k-btn-${size}`,
        icon && !children && 'k-btn-icon',
        busy && 'is-busy',
        className,
      )}
    >
      {busy ? <Spinner /> : icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children ? <span>{children}</span> : null}
      {shortcut && !busy && <Kbd keys={shortcut} />}
    </button>
  )
}

/** A small spinner in the current text colour, for a button or a line that is working on something. */
export function Spinner() {
  return <span className="k-spin" aria-hidden="true" />
}

type BadgeProps = {
  /** `ok`: a working state (Connected), in ink; `danger` only for errors. */
  tone?: 'neutral' | 'ok' | 'danger' | 'info' | 'outline'
  dot?: boolean
  /** Tooltip. */
  title?: string
  children: ReactNode
}

export function Badge({ tone = 'neutral', dot, title, children }: BadgeProps) {
  return (
    <span className={cx('k-badge', `k-badge-${tone}`, dot && 'k-badge-dot')} title={title}>
      {children}
    </span>
  )
}

const initials = (name: string) =>
  name
    .split(/[\s&]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]!.toUpperCase())
    .join('')

export function Avatar({ name, size = 32 }: { name: string; size?: 20 | 24 | 32 | 40 }) {
  return (
    <span className={cx('k-avatar', `k-avatar-${size}`)} role="img" aria-label={name}>
      {initials(name) || '?'}
    </span>
  )
}

/**
 * The Linedesk mark (interim, "the lit line key"): a desk-phone line key whose light is on.
 * Drawn in currentColor on the dark `.ws-mark` square; the light is the live green. Source files: brand/.
 */
export function LogoMark({ size = 21 }: { size?: number }) {
  return (
    <svg
      className="k-logo"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="13" width="40" height="22" rx="11" stroke="currentColor" strokeWidth={4.5} />
      <circle cx="15" cy="24" r="5" fill="#4ADE80" />
      <line x1="24" y1="24" x2="34" y2="24" stroke="currentColor" strokeWidth={4.5} strokeLinecap="round" />
    </svg>
  )
}

/**
 * The install's logo (Admin, Branding) when an instance admin set one, else the Linedesk mark on its dark square.
 * `label` names it for screen readers; without one it is decoration next to the product name.
 */
export function BrandMark({
  className = 'ws-mark',
  size,
  label,
}: {
  className?: string
  size?: number
  label?: string
}) {
  const { logoUrl } = useBrand()
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true }
  if (logoUrl)
    return (
      <span className={cx(className, 'is-logo')} {...a11y}>
        <img src={logoUrl} alt="" />
      </span>
    )
  return (
    <span className={className} {...a11y}>
      <LogoMark size={size} />
    </span>
  )
}

/** The page around sign-in, sign-up and invitations: the install's mark above a centred column, no card. */
export function AuthPage({ children }: { children: ReactNode }) {
  const { name } = useBrand()
  return (
    <main className="auth">
      <div className="auth-column">
        <BrandMark className="auth-mark" size={28} label={name} />
        {children}
      </div>
    </main>
  )
}
