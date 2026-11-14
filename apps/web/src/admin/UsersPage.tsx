// Users: a searchable list with Add user; a click opens the user with their workspaces and actions.
import { Card } from '../ui/form.tsx'
import { Avatar, Badge } from '../ui/kit.tsx'
import { AddUser } from './AddUser.tsx'
import { ActionBar, RowActions, useActionRunner, userActions } from './actions.tsx'
import { AdminList, type Column, type ListKeys } from './AdminList.tsx'
import type { AdminUser, AdminWorkspace } from './api.ts'
import { UserWorkspaces } from './Memberships.tsx'
import type { Notify } from './notify.ts'
import { day, when } from './parts.tsx'
import { ServerSet } from './ProviderDialog.tsx'
import { Fact } from './WorkspacesPage.tsx'

const label = (u: AdminUser) => u.name || u.email

const columns: Column<AdminUser>[] = [
  {
    key: 'name',
    label: 'User',
    sort: label,
    render: u => (
      <span className="adm-person">
        <Avatar name={label(u)} size={24} src={u.avatar_url} />
        <span className="adm-who">
          <span className="adm-strong">
            {label(u)}
            {u.instance_admin && <Badge>Admin</Badge>}
            {u.disabled_at && <Badge>Disabled</Badge>}
          </span>
          <span className="adm-sub">{u.email}</span>
        </span>
      </span>
    ),
  },
  { key: 'workspaces', label: 'Workspaces', wide: true, render: u => <WorkspacesCell user={u} /> },
  {
    key: 'signin',
    label: 'Last sign-in',
    firstDir: 'desc',
    sort: u => (u.last_sign_in_at ? Date.parse(u.last_sign_in_at) : null),
    render: u => when(u.last_sign_in_at),
  },
]

/** Their workspaces; none yet: where they are invited, else "No workspace", both muted. */
export function workspacesText(u: Pick<AdminUser, 'workspaces' | 'invitations'>): { text: string; muted: boolean } {
  if (u.workspaces.length) return { text: u.workspaces.map(w => w.name).join(', '), muted: false }
  if (u.invitations.length)
    return { text: `Invited to ${u.invitations.map(i => i.workspace_name).join(', ')}`, muted: true }
  return { text: 'No workspace', muted: true }
}

function WorkspacesCell({ user }: { user: AdminUser }) {
  const { text, muted } = workspacesText(user)
  return muted ? <span className="adm-muted">{text}</span> : <>{text}</>
}

type ListProps = {
  users: AdminUser[]
  workspaces: AdminWorkspace[]
  currentUserId: string
  onOpen: (id: string) => void
  keysRef: { current: ListKeys | null }
  notify: Notify
  reload: () => Promise<void>
}

export function UsersList({ users, workspaces, currentUserId, onOpen, keysRef, notify, reload }: ListProps) {
  const runner = useActionRunner(notify)
  return (
    <>
      <AddUser workspaces={workspaces} toast={notify} reload={reload} />
      <AdminList
        rows={users}
        rowId={u => u.id}
        columns={columns}
        initialSort={{ key: 'name', dir: 'asc' }}
        searchText={u => `${u.name} ${u.email} ${u.workspaces.map(w => w.name).join(' ')}`}
        searchLabel="Search users"
        onOpen={u => onOpen(u.id)}
        keysRef={keysRef}
        empty="No users yet."
        rowActions={u => <RowActions actions={userActions(u, currentUserId, reload)} onPick={runner.pick} />}
      />
      {runner.dialog}
    </>
  )
}

type DetailProps = {
  user: AdminUser
  workspaces: AdminWorkspace[]
  currentUserId: string
  notify: Notify
  reload: () => Promise<void>
}

export function UserDetail({ user: u, workspaces, currentUserId, notify, reload }: DetailProps) {
  const runner = useActionRunner(notify)
  const actions = userActions(u, currentUserId, reload)
  return (
    <>
      <ActionBar actions={actions} onPick={runner.pick} />
      <Card title="Details" className="adm-detail">
        <dl className="adm-facts">
          <Fact label="Email">{u.email}</Fact>
          <Fact label="Status">{u.disabled_at ? `Disabled ${when(u.disabled_at)}` : 'Active'}</Fact>
          <Fact label="Instance admin">
            {u.instance_admin ? 'Yes' : 'No'}
            {u.instance_admin_by_env && <ServerSet />}
          </Fact>
          <Fact label="Last sign-in">{when(u.last_sign_in_at)}</Fact>
          <Fact label="Created">{day(u.created_at)}</Fact>
        </dl>
      </Card>
      <UserWorkspaces user={u} workspaces={workspaces} notify={notify} reload={reload} />
      {runner.dialog}
    </>
  )
}
