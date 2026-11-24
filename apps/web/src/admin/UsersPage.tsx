// Users: a searchable list with Add user; a click opens the user with their workspaces and actions.
import { useT } from '@linedesk/i18n/react'
import { useMemo, useState } from 'react'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { Select } from '../ui/controls.tsx'
import { Card } from '../ui/form.tsx'
import { Avatar, Badge } from '../ui/kit.tsx'
import { AddUser } from './AddUser.tsx'
import { ActionBar, RowActions, useActionRunner, userActions } from './actions.tsx'
import { AdminList, type Column, type ListKeys } from './AdminList.tsx'
import { type AdminUser, type AdminWorkspace, filterUsers, type UserFilter } from './api.ts'
import { UserWorkspaces } from './Memberships.tsx'
import type { Notify } from './notify.ts'
import { day, when } from './parts.tsx'
import { ServerSet } from './ProviderDialog.tsx'
import { Fact } from './WorkspacesPage.tsx'

const label = (u: AdminUser) => u.name || u.email

type Translate = ReturnType<typeof useT>

const userColumns = (t: Translate): Column<AdminUser>[] => [
  {
    key: 'name',
    label: t('admin.users.column.user'),
    sort: label,
    render: u => (
      <span className="adm-person">
        <Avatar name={label(u)} size={24} src={u.avatar_url} />
        <span className="adm-who">
          <span className="adm-strong">
            <span className="adm-name">{label(u)}</span>
            {u.instance_admin && <Badge>{t('admin.users.badge.serverAdmin')}</Badge>}
            {u.disabled_at && <Badge>{t('admin.users.badge.disabled')}</Badge>}
          </span>
          <span className="adm-sub">{u.email}</span>
        </span>
      </span>
    ),
  },
  {
    key: 'workspaces',
    label: t('admin.users.column.workspaces'),
    wide: true,
    render: u => <WorkspacesCell user={u} />,
  },
  {
    key: 'signin',
    label: t('admin.users.column.lastSignIn'),
    firstDir: 'desc',
    sort: u => (u.last_sign_in_at ? Date.parse(u.last_sign_in_at) : null),
    render: u => when(u.last_sign_in_at),
  },
]

const names = (items: string[]) => fmt().list(items, { type: 'unit', style: 'short' })

/** Their workspaces; none yet: where they are invited, else "No workspace", both muted. */
export function workspacesText(u: Pick<AdminUser, 'workspaces' | 'invitations'>): { text: string; muted: boolean } {
  const { t } = i18n()
  if (u.workspaces.length) return { text: names(u.workspaces.map(w => w.name)), muted: false }
  if (u.invitations.length)
    return {
      text: t('admin.users.invitedTo', { workspaces: names(u.invitations.map(i => i.workspace_name)) }),
      muted: true,
    }
  return { text: t('admin.users.noWorkspace'), muted: true }
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
  const t = useT()
  const [filter, setFilter] = useState<UserFilter>('all')
  const shown = useMemo(() => filterUsers(users, filter), [users, filter])
  const columns = useMemo(() => userColumns(t), [t])
  const filters = [
    { value: 'all' as const, label: t('admin.users.filter.all') },
    { value: 'noWorkspace' as const, label: t('admin.users.filter.noWorkspace') },
  ]
  return (
    <>
      <AddUser workspaces={workspaces} users={users} toast={notify} reload={reload} />
      <AdminList
        rows={shown}
        tools={
          <div className="adm-list-tools">
            <Select
              value={filter}
              options={filters}
              onChange={setFilter}
              label={t('admin.users.filter.label')}
              size="sm"
            />
          </div>
        }
        rowId={u => u.id}
        columns={columns}
        initialSort={{ key: 'name', dir: 'asc' }}
        searchText={u => `${u.name} ${u.email} ${u.workspaces.map(w => w.name).join(' ')}`}
        searchLabel={t('admin.users.search')}
        label={t('admin.sections.users.label')}
        onOpen={u => onOpen(u.id)}
        keysRef={keysRef}
        empty={filter === 'noWorkspace' ? t('admin.users.noWorkspaceEmpty') : t('admin.users.empty')}
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
  const t = useT()
  const actions = userActions(u, currentUserId, reload)
  return (
    <>
      <ActionBar actions={actions} onPick={runner.pick} />
      <Card title={t('admin.users.details')} className="adm-detail">
        <dl className="adm-facts">
          <Fact label={t('admin.users.fact.email')}>{u.email}</Fact>
          <Fact label={t('admin.users.fact.status')}>
            {u.disabled_at
              ? t('admin.users.fact.disabledAt', { when: when(u.disabled_at) })
              : t('admin.users.fact.active')}
          </Fact>
          <Fact label={t('admin.users.fact.serverAdmin')}>
            {u.instance_admin ? t('admin.users.fact.yes') : t('admin.users.fact.no')}
            {u.instance_admin_by_env && <ServerSet />}
          </Fact>
          <Fact label={t('admin.users.fact.lastSignIn')}>{when(u.last_sign_in_at)}</Fact>
          <Fact label={t('admin.users.fact.created')}>{day(u.created_at)}</Fact>
          <Fact label={t('admin.users.fact.terms')}>
            {u.terms
              ? t('admin.users.fact.termsAccepted', { version: u.terms.terms_version, when: when(u.terms.accepted_at) })
              : t('admin.users.fact.termsNone')}
          </Fact>
        </dl>
      </Card>
      <UserWorkspaces user={u} workspaces={workspaces} notify={notify} reload={reload} />
      {runner.dialog}
    </>
  )
}
