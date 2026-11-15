// The workspaces a member belongs to, at the top of the workspace menu: the current one is checked (also when it
// is the only one), choosing another makes it active and reloads into it (each workspace has its own local store). Below them,
// invitations to other workspaces: Join or Decline.
import type { MyInvitation } from '@linedesk/actions'
import { useState, type KeyboardEvent } from 'react'
import { fetchQuery, useQuery } from '../cachedQuery.ts'
import { WORKSPACES_QUERY } from '../session.ts'
import { Button, Icon } from '../ui/kit.tsx'
import { declineInvitation, joinWorkspace, roleLabel, switchToWorkspace } from './invitations.ts'
import { WorkspaceMark } from './WorkspaceMark.tsx'
import { useT } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'

/**
 * `disabled`: an admin turned the workspace off; it shows greyed out and cannot be chosen. `iconUrl`: its icon
 * (Workspace settings › General), null or absent: its initial shows.
 */
export type Workspace = { id: string; name: string; disabled?: boolean; iconUrl?: string | null }

/** From this many workspaces the list gets a filter field and scrolls instead of growing. */
export const WORKSPACE_FILTER_FROM = 6

/** Workspaces that match the filter, by name, case-insensitive; the current one always first. */
export function filterWorkspaces(all: Workspace[], currentId: string, query: string): Workspace[] {
  const q = query.trim().toLowerCase()
  const byName = [...all].sort((a, b) => a.name.localeCompare(b.name))
  const current = byName.filter(w => w.id === currentId)
  const others = byName.filter(w => w.id !== currentId && (!q || w.name.toLowerCase().includes(q)))
  return q ? others : [...current, ...others]
}

async function loadWorkspaces(): Promise<Workspace[]> {
  const res = await fetch('/v1/me/workspaces', { credentials: 'include' })
  if (!res.ok) throw new Error(i18n().t('shell.switcher.loadFailed'))
  return (await res.json()) as Workspace[]
}

/**
 * The member's workspaces: known from the session at boot (and the last visit), checked again in
 * the background when the menu opens and on focus. Used where it is always mounted (the workspace
 * button), so the open menu shows the list on its first frame and never waits for it.
 */
export function useWorkspaces(): Workspace[] | null {
  return useQuery(WORKSPACES_QUERY, loadWorkspaces, { persist: true }).data ?? null
}

/** After joining or leaving a workspace (an accepted invitation, a removal): load the list again. */
export const refreshWorkspaces = () => fetchQuery(WORKSPACES_QUERY, loadWorkspaces, { persist: true })

type Props = {
  all: Workspace[] | null
  currentId: string
  invitations: MyInvitation[]
  /** After a decline: load the invitations again. */
  onInvitationsChanged: () => void
  onError: (message: string) => void
}

/** The workspace section of the workspace menu: always the workspaces (at least the current one), then invitations. */
export function WorkspaceSwitcher({ all, currentId, invitations, onInvitationsChanged, onError }: Props) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const switcher = !!all && all.length >= 1
  if (!switcher && !invitations.length) return null
  const fail = (e: unknown) => {
    setBusy(null)
    onError(e instanceof Error ? e.message : String(e))
  }
  const join = (i: MyInvitation) => () => {
    if (busy) return
    setBusy(i.invitationId)
    // Reloads into the workspace; the session then brings the new list of workspaces.
    joinWorkspace(i.invitationId).catch(fail)
  }
  const decline = (i: MyInvitation) => () => {
    if (busy) return
    setBusy(i.invitationId)
    declineInvitation(i.invitationId).then(() => {
      setBusy(null)
      onError(t('shell.switcher.declined', { workspace: i.workspaceName }))
      onInvitationsChanged()
    }, fail)
  }
  const invitationList = invitations.length > 0 && (
    <>
      <div className="me-ws-head">{t('shell.switcher.invitations')}</div>
      {invitations.map(i => (
        <div key={i.invitationId} className="me-inv">
          <div className="me-inv-t">
            <span className="lbl" title={i.workspaceName}>{i.workspaceName}</span>
            <small>
              {t('shell.switcher.invitedBy', { role: roleLabel(i.role), name: i.invitedBy })}
            </small>
          </div>
          <div className="me-inv-acts">
            <Button busy={busy === i.invitationId} size="sm" variant="primary" role="menuitem" disabled={!!busy} onClick={join(i)} title={t('shell.switcher.joinTip', { workspace: i.workspaceName, role: roleLabel(i.role) })}>
              {busy === i.invitationId ? t('shell.switcher.joining') : t('shell.switcher.join')}
            </Button>
            <Button size="sm" variant="ghost" role="menuitem" disabled={!!busy} onClick={decline(i)} title={t('shell.switcher.declineTip', { workspace: i.workspaceName })}>
              {t('shell.switcher.decline')}
            </Button>
          </div>
        </div>
      ))}
    </>
  )
  if (!switcher) return <div className="me-ws" role="group" aria-label={t('shell.switcher.invitations')}>{invitationList}</div>
  const many = all.length >= WORKSPACE_FILTER_FROM
  const shown = filterWorkspaces(all, currentId, query)

  const choose = (w: Workspace) => () => {
    const id = w.id
    if (id === currentId || w.disabled || busy) return
    setBusy(id)
    switchToWorkspace(id).catch(fail)
  }
  // Arrow down from the filter moves into the list; other keys type into it.
  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowDown') return
    e.preventDefault()
    e.currentTarget.closest('.me-ws')?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus()
  }

  return (
    <div className="me-ws" role="group" aria-label={t('shell.switcher.workspaces')}>
      <div className="me-ws-head">{t('shell.switcher.workspaces')}</div>
      {many && (
        <input
          className="me-ws-filter"
          type="search"
          placeholder={t('shell.switcher.filter', { count: all.length })}
          aria-label={t('shell.switcher.filterLabel')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onFilterKey}
        />
      )}
      <div className={many ? 'me-ws-list is-scroll' : 'me-ws-list'}>
        {shown.map(w => (
          <button key={w.id} type="button" role="menuitemradio" aria-checked={w.id === currentId} aria-disabled={w.disabled && w.id !== currentId ? true : undefined} className={w.disabled ? 'nav-item is-ws-disabled' : 'nav-item'} onClick={choose(w)} title={w.id === currentId ? t('shell.switcher.current') : w.disabled ? t('shell.switcher.disabledTip', { workspace: w.name }) : t('shell.tabNotice.switchTo', { workspace: w.name })}>
            <WorkspaceMark name={w.name} iconUrl={w.iconUrl} size="sm" />
            <span className="lbl">{w.name}</span>
            {w.id === currentId && <Icon name="check" size={15} />}
            {w.disabled && <span className="me-ws-busy">{t('shell.switcher.disabled')}</span>}
            {busy === w.id && <span className="me-ws-busy">{t('shell.switcher.switching')}</span>}
          </button>
        ))}
        {shown.length === 0 && <div className="me-ws-none">{t('shell.switcher.noMatch', { query })}</div>}
      </div>
      {invitationList}
    </div>
  )
}
