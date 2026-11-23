// Lists of the UI kit, for the short lists on settings pages (accounts, calendars, keys, members…):
// one compact row per item (lead mark, title with a muted line, quiet status, actions at the right),
// a one-line empty state, and a small menu for a row's or a section's less frequent actions.
// Styles in list.css (k-list, k-row, k-menu).
import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useRef, useState } from 'react'
import { useAnchoredList } from './floating.ts'
import { Button, cx } from './kit.tsx'
import type { IconName } from './icons.ts'
import './list.css'
import { useT } from '@linedesk/i18n/react'

export function List({
  label,
  busy,
  className,
  children,
}: {
  label?: string
  /** Part of every row is still loading (a status skeleton): the one aria-busy area for it. */
  busy?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <ul className={cx('k-list', className)} aria-label={label} aria-busy={busy || undefined}>
      {children}
    </ul>
  )
}

type ListRowProps = {
  /** A small mark at the left: a provider logo, an avatar. */
  lead?: ReactNode
  title: ReactNode
  /** One muted line under the title. */
  sub?: ReactNode
  /** Quiet status at the right, before the actions: a badge, a role, a length. */
  aside?: ReactNode
  actions?: ReactNode
  /** Below the row's line, full width: an inline form, a log. */
  below?: ReactNode
  /** Dimmed (switched off). */
  off?: boolean
  className?: string
}

export function ListRow({ lead, title, sub, aside, actions, below, off, className }: ListRowProps) {
  return (
    <li className={cx('k-row', off && 'is-off', className)}>
      <div className="k-row-line">
        {lead && <span className="k-row-lead">{lead}</span>}
        <span className="k-row-main">
          <span className="k-row-title">{title}</span>
          {sub && <span className="k-row-sub">{sub}</span>}
        </span>
        {aside && <span className="k-row-aside">{aside}</span>}
        {actions && <span className="k-row-actions">{actions}</span>}
      </div>
      {below}
    </li>
  )
}

/**
 * Column headings above a page's list of grid rows (inbox calls, contacts): muted, sticky while the
 * list scrolls, on the rows' own grid (the list sets `grid-template-columns` for both; styles under
 * `.ib-cols` in styles.css and app.css). Phones stack the rows, so the headings are hidden there.
 * Screen readers skip them: each row already says what it is. `lead` sits in the rows' gutter, where
 * their checkboxes are (the inbox's select-all box).
 */
export function ColumnHeads({
  labels,
  lead,
  className,
  ref,
}: {
  labels: readonly string[]
  lead?: ReactNode
  className?: string
  ref?: Ref<HTMLDivElement>
}) {
  return (
    <div className={cx('ib-cols', className)} role="presentation" ref={ref}>
      {lead}
      {labels.map(label => (
        <span key={label} aria-hidden="true">
          {label}
        </span>
      ))}
    </div>
  )
}

/** The short line in place of an empty list ("No keys yet."). */
export function ListEmpty({ children }: { children: ReactNode }) {
  return <p className="k-list-empty">{children}</p>
}

/** A row's Edit: a small pencil button. */
export function EditButton({ name, onClick }: { name: string; onClick: () => void }) {
  const t = useT()
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="pencil"
      aria-label={t('common.list.edit', { name })}
      title={t('common.list.edit', { name })}
      onClick={onClick}
    />
  )
}

/**
 * A row's Delete: a small trash button that asks once in place, like Revoke and Remove elsewhere. The
 * first click turns it into a red "Delete"; a second click deletes, leaving it (blur) takes it back.
 */
export function DeleteButton({ name, onDelete }: { name: string; onDelete: () => void }) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  return (
    <Button
      size="sm"
      variant={confirming ? 'danger' : 'ghost'}
      icon={confirming ? undefined : 'trash'}
      aria-label={confirming ? t('common.list.deleteNow', { name }) : t('common.list.delete', { name })}
      title={confirming ? t('common.list.clickAgain') : t('common.list.delete', { name })}
      onBlur={() => setConfirming(false)}
      onClick={() => (confirming ? onDelete() : setConfirming(true))}
    >
      {confirming ? t('common.action.delete') : null}
    </Button>
  )
}

export type MenuItem = {
  id: string
  label: string
  /** A mark before the label: an icon or a provider logo. */
  lead?: ReactNode
  /** Red: removes or disconnects something. */
  danger?: boolean
  disabled?: boolean
  /** Tooltip. */
  title?: string
  onSelect: () => void
}

type MenuButtonProps = {
  items: MenuItem[]
  /** The button's text; without it the button shows only the icon (default ⋯). */
  label?: string
  icon?: IconName
  /** Accessible name and tooltip of the button. */
  title: string
  variant?: 'secondary' | 'ghost'
  disabled?: boolean
  /** Which edge of the button the menu lines up with. */
  align?: 'start' | 'end'
}

const itemsIn = (root: HTMLElement | null) => [
  ...(root?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
]

/**
 * A button that opens a small menu: arrow keys move, Enter picks, Esc or a click outside closes and
 * the focus goes back to the button.
 */
export function MenuButton({
  items,
  label,
  icon = 'more',
  title,
  variant = 'ghost',
  disabled,
  align = 'end',
}: MenuButtonProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuItems = () => itemsIn(root.current)
  useAnchoredList(open, root, menu, { minWidth: 180, align })

  useEffect(() => {
    if (!open) return
    itemsIn(root.current)[0]?.focus()
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])

  const close = () => {
    setOpen(false)
    root.current?.querySelector<HTMLElement>('.k-menu-btn')?.focus()
  }
  function onKeyDown(e: KeyboardEvent) {
    if (!open) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const all = menuItems()
    const at = all.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1
    all[(next + all.length) % all.length]?.focus()
  }
  const choose = (item: MenuItem) => {
    close()
    item.onSelect()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys and Esc for the menu inside
    <span className="k-menu-wrap" ref={root} onKeyDown={onKeyDown}>
      <Button
        size="sm"
        variant={variant}
        icon={label ? (icon === 'more' ? undefined : icon) : icon}
        className="k-menu-btn"
        aria-label={label ? undefined : title}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
      >
        {label}
      </Button>
      {open && (
        <div
          ref={menu}
          popover="manual"
          className={cx('k-menu', `k-menu-${align}`, 'k-float')}
          role="menu"
          aria-label={title}
        >
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={cx('k-menu-item', item.danger && 'is-danger')}
              disabled={item.disabled}
              title={item.title}
              onClick={() => choose(item)}
            >
              {item.lead}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
