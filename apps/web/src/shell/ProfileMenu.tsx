import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Avatar, Icon } from '../ui/kit.tsx'
import type { IconName } from '../ui/icons.ts'

/** `onAdmin` is set for instance admins only: Admin then leads the menu. */
type Props = { name: string; workspaceName: string; navOpen: boolean; onAdmin?: () => void; onAccount: () => void; onSignOut: () => void }

function Item({ label, icon, onClick }: { label: string; icon: IconName; onClick: () => void }) {
  return <button type="button" role="menuitem" className="nav-item" onClick={onClick}><Icon name={icon} size={15} /><span className="lbl">{label}</span></button>
}

/** The profile row at the bottom of the navigation. Clicking it opens a small menu above it. */
export function ProfileMenu({ name, workspaceName, navOpen, onAdmin, onAccount, onSignOut }: Props) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (!navOpen) setOpen(false) }, [navOpen]) // the menu never outlives the navigation
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const items = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onMouseDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation() // the menu has the keyboard while it is open
    const all = items()
    const at = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape' || e.key === 'Tab') { setOpen(false); trigger.current?.focus() } // Tab then moves on from the row
    else if (e.key === 'ArrowDown') { e.preventDefault(); all[(at + 1) % all.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(at - 1 + all.length) % all.length]?.focus() }
  }
  const choose = (run: () => void) => () => { setOpen(false); run() }

  return (
    <div className="me-wrap" ref={root}>
      {open && (
        <div className="me-menu" role="menu" aria-label="Account" onKeyDown={onKeyDown}>
          {onAdmin && <Item label="Admin" icon="gear" onClick={choose(onAdmin)} />}
          <Item label="Account settings" icon="user" onClick={choose(onAccount)} />
          <hr />
          <Item label="Sign out" icon="arrow-up-right" onClick={choose(onSignOut)} />
        </div>
      )}
      <button type="button" ref={trigger} className="me" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Avatar name={name || workspaceName} size={24} />
        <div><b>{name}</b><small>{workspaceName}</small></div>
        <Icon name="down" size={14} className="me-chevron" />
      </button>
    </div>
  )
}
