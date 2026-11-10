// The small pieces of the reference UI kit: Icon, Kbd, Button, Badge. Class names match styles.css.
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { filledIcons, icons, type IconName } from './icons.ts'

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const filled = filledIcons.has(name)
  return (
    <svg className={cx('k-icon', className)} width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {icons[name].map(([Tag, attrs]) => <Tag key={Object.values(attrs).join(' ')} {...attrs} />)}
    </svg>
  )
}

export function Kbd({ keys, className }: { keys: string[]; className?: string }) {
  return <span className={cx('k-kbds', className)}>{keys.map(k => <kbd key={k} className="k-kbd">{k}</kbd>)}</span>
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: IconName
  shortcut?: string[]
}

export function Button({ variant = 'secondary', size = 'md', icon, shortcut, className, children, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} className={cx('k-btn', `k-btn-${variant}`, `k-btn-${size}`, icon && !children && 'k-btn-icon', className)}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children ? <span>{children}</span> : null}
      {shortcut && <Kbd keys={shortcut} />}
    </button>
  )
}

export function Badge({ tone = 'neutral', dot, children }: { tone?: 'neutral' | 'danger' | 'info'; dot?: boolean; children: ReactNode }) {
  return <span className={cx('k-badge', `k-badge-${tone}`, dot && 'k-badge-dot')}>{children}</span>
}
