import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { fetchAuthMethods, type LegalLinks } from '../auth.ts'
import { useQuery } from '../cachedQuery.ts'
import { Avatar, Icon } from '../ui/kit.tsx'
import type { IconName } from '../ui/icons.ts'
import { refreshWorkspaces, useWorkspaces, WorkspaceSwitcher } from './WorkspaceSwitcher.tsx'

/** `onAdmin` is set for instance admins only: Admin then leads the menu. */
type Props = { name: string; workspaceName: string; workspaceId: string; onError: (message: string) => void; navOpen: boolean; onAdmin?: () => void; onAccount: () => void; onTeam: () => void; onSignOut: () => void }

/** This install's terms, privacy and support links: the last known ones at once, none that are not set. */
export const loadAuthMethods = () => fetchAuthMethods({ attempts: 1 })
function useLegalLinks(): LegalLinks | null {
  return useQuery('auth-methods', loadAuthMethods, { persist: true }).data?.links ?? null
}

function LinkItem({ label, icon, href }: { label: string; icon: IconName; href: string }) {
  const external = !href.startsWith('mailto:')
  return <a role="menuitem" className="nav-item" href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}><Icon name={icon} size={15} /><span className="lbl">{label}</span></a>
}

function Item({ label, icon, onClick }: { label: string; icon: IconName; onClick: () => void }) {
  return <button type="button" role="menuitem" className="nav-item" onClick={onClick}><Icon name={icon} size={15} /><span className="lbl">{label}</span></button>
}

/** The profile row at the bottom of the navigation. Clicking it opens a small menu above it. */
export function ProfileMenu({ name, workspaceName, workspaceId, onError, navOpen, onAdmin, onAccount, onTeam, onSignOut }: Props) {
  const [open, setOpen] = useState(false)
  const links = useLegalLinks()
  const workspaces = useWorkspaces() // known with the session; here so the menu never waits for it
  const hasLinks = !!(links?.terms || links?.privacy || links?.supportEmail)
  useEffect(() => { if (!navOpen) setOpen(false) }, [navOpen]) // the menu never outlives the navigation
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const items = () => [...(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]

  useEffect(() => {
    if (!open) return
    void refreshWorkspaces() // in the background: the menu already shows the last known list
    root.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
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
          <WorkspaceSwitcher all={workspaces} currentId={workspaceId} onError={m => { setOpen(false); onError(m) }} />
          {onAdmin && <Item label="Admin" icon="shield" onClick={choose(onAdmin)} />}
          <Item label="Account settings" icon="user" onClick={choose(onAccount)} />
          <Item label="Team" icon="users" onClick={choose(onTeam)} />
          {hasLinks && <hr />}
          {links?.supportEmail && <LinkItem label="Help" icon="mail" href={`mailto:${links.supportEmail}`} />}
          {links?.terms && <LinkItem label="Terms" icon="globe" href={links.terms} />}
          {links?.privacy && <LinkItem label="Privacy" icon="globe" href={links.privacy} />}
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
