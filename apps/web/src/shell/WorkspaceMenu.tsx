// The workspace button at the top of the navigation: the current workspace's initial and name. It opens
// a menu with the other workspaces and invitations (WorkspaceSwitcher), New workspace…, Workspace settings
// and, for owners and admins, Invite people…
import type { MyInvitation } from '@linedesk/actions'
import type { IconName } from '../ui/icons.ts'
import { Icon, Kbd } from '../ui/kit.tsx'
import { refreshInvitations } from './invitations.ts'
import { useMenu } from './useMenu.ts'
import { refreshWorkspaces, useWorkspaces, WorkspaceSwitcher } from './WorkspaceSwitcher.tsx'

export type WorkspaceMenuItem = 'switcher' | 'new' | 'settings' | 'invite'

/**
 * What the workspace menu lists. `count`: the member's workspaces (null while unknown); `invitations`: to
 * other workspaces; `canCreate`: POST /v1/workspaces would allow a new one; `canManage`: may invite (team:write).
 * The switcher shows from two workspaces or any invitation (as WorkspaceSwitcher itself); settings always.
 */
export function workspaceMenuItems({
  count,
  invitations,
  canCreate,
  canManage,
}: {
  count: number | null
  invitations: number
  canCreate: boolean
  canManage: boolean
}): WorkspaceMenuItem[] {
  const items: WorkspaceMenuItem[] = []
  if ((count ?? 0) >= 2 || invitations > 0) items.push('switcher')
  if (canCreate) items.push('new')
  items.push('settings')
  if (canManage) items.push('invite')
  return items
}

/** The first letter of the workspace's name, for its square at the top of the navigation. */
export const workspaceInitial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'

type Props = {
  name: string
  id: string
  navOpen: boolean
  invitations: MyInvitation[]
  onInvitationsChanged: () => void
  toast: (message: string) => void
  canManage: boolean
  /** Set only where POST /v1/workspaces would allow this person to create a workspace. */
  onNewWorkspace?: () => void
  onSettings: () => void
  onInvite: () => void
}

function Item({ label, icon, keys, onClick }: { label: string; icon: IconName; keys?: string[]; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="nav-item" onClick={onClick}>
      <Icon name={icon} size={15} />
      <span className="lbl">{label}</span>
      {keys && <Kbd keys={keys} />}
    </button>
  )
}

export function WorkspaceMenu({
  name,
  id,
  navOpen,
  invitations,
  onInvitationsChanged,
  toast,
  canManage,
  onNewWorkspace,
  onSettings,
  onInvite,
}: Props) {
  // In the background when it opens: the menu already shows the last known lists.
  const menu = useMenu(navOpen, () => {
    void refreshWorkspaces()
    void refreshInvitations()
  })
  const workspaces = useWorkspaces() // known with the session; here so the menu never waits for it
  const items = workspaceMenuItems({
    count: workspaces?.length ?? null,
    invitations: invitations.length,
    canCreate: !!onNewWorkspace,
    canManage,
  })
  const waiting = invitations.length
  return (
    <div className="ws-wrap" ref={menu.root}>
      <button
        type="button"
        ref={menu.trigger}
        className="ws-btn"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => menu.setOpen(!menu.open)}
        onKeyDown={menu.onTriggerKeyDown}
        title={
          waiting
            ? `${name}: ${waiting === 1 ? 'an invitation' : `${waiting} invitations`} to join`
            : `${name}: switch, settings, invite`
        }
      >
        <span className="ws-initial" aria-hidden="true">
          {workspaceInitial(name)}
          {waiting > 0 && <span className="me-dot" />}
        </span>
        <span className="ws-name">{name}</span>
        <Icon name="down" size={14} className="me-chevron" />
      </button>
      {menu.open && (
        <div className="ws-menu" role="menu" aria-label="Workspace" onKeyDown={menu.onKeyDown}>
          {items.includes('switcher') && (
            <WorkspaceSwitcher
              all={workspaces}
              currentId={id}
              invitations={invitations}
              onInvitationsChanged={onInvitationsChanged}
              onError={m => {
                menu.setOpen(false)
                toast(m)
              }}
            />
          )}
          {onNewWorkspace && items.includes('new') && (
            <>
              <Item label="New workspace…" icon="plus" onClick={menu.choose(onNewWorkspace)} />
              <hr />
            </>
          )}
          <Item label="Workspace settings" icon="gear" keys={['G', 'S']} onClick={menu.choose(onSettings)} />
          {items.includes('invite') && <Item label="Invite people…" icon="users" onClick={menu.choose(onInvite)} />}
        </div>
      )}
    </div>
  )
}
