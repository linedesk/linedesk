// Users: a searchable list with Invite user; a click opens the user with their workspaces and actions.
import { useState } from 'react'
import { confirmText, startImpersonation } from '../impersonation.ts'
import { Card } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { AdminList, type Column, type ListKeys } from './AdminList.tsx'
import { type AdminUser, runAdmin } from './api.ts'
import { InviteUser } from './InviteUser.tsx'
import { errorText, type Notify } from './notify.ts'
import { Confirm, day, when } from './parts.tsx'
import { ServerSet } from './ProviderDialog.tsx'
import { ActionRow, Fact } from './WorkspacesPage.tsx'

const label = (u: AdminUser) => u.name || u.email

const columns: Column<AdminUser>[] = [
  {
    key: 'name',
    label: 'User',
    sort: label,
    render: u => (
      <span className="adm-who">
        <span className="adm-strong">
          {label(u)}
          {u.instance_admin && <Badge>Admin</Badge>}
          {u.disabled_at && <Badge>Disabled</Badge>}
        </span>
        <span className="adm-sub">{u.email}</span>
      </span>
    ),
  },
  { key: 'workspaces', label: 'Workspaces', wide: true, render: u => u.workspaces.map(w => w.name).join(', ') || '–' },
  {
    key: 'signin',
    label: 'Last sign-in',
    firstDir: 'desc',
    sort: u => (u.last_sign_in_at ? Date.parse(u.last_sign_in_at) : null),
    render: u => when(u.last_sign_in_at),
  },
]

type ListProps = {
  users: AdminUser[]
  onOpen: (id: string) => void
  keysRef: { current: ListKeys | null }
  notify: Notify
  reload: () => Promise<void>
}

export function UsersList({ users, onOpen, keysRef, notify, reload }: ListProps) {
  return (
    <>
      <InviteUser toast={notify} reload={reload} />
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
      />
    </>
  )
}

type Step = 'disable' | 'grant' | 'revoke' | 'impersonate'
type DetailProps = { user: AdminUser; currentUserId: string; notify: Notify; reload: () => Promise<void> }

export function UserDetail({ user: u, currentUserId, notify, reload }: DetailProps) {
  const [step, setStep] = useState<Step | null>(null)
  const isSelf = u.id === currentUserId
  const run = async (name: 'user.disable' | 'user.enable' | 'instanceAdmin.grant' | 'instanceAdmin.revoke') => {
    await runAdmin(name, { userId: u.id })
    await reload()
  }
  const confirmed = (name: Parameters<typeof run>[0], done: string) => async () => {
    await run(name)
    setStep(null)
    notify(done)
  }
  const steps: Record<Step, { text: string; action: string; variant?: 'primary'; run: () => Promise<void> }> = {
    impersonate: {
      text: confirmText(label(u)),
      action: `Sign in as ${label(u)}`,
      variant: 'primary',
      // Reloads into the app as this user; throws with the reason when refused.
      run: () => startImpersonation(u.id),
    },
    disable: {
      text: `${label(u)} is signed out everywhere and cannot sign in again until enabled.`,
      action: 'Disable user',
      run: confirmed('user.disable', `${label(u)} is disabled and signed out.`),
    },
    grant: {
      text: `${label(u)} will see every workspace and user, and can change the provider keys.`,
      action: 'Make instance admin',
      run: confirmed('instanceAdmin.grant', `${label(u)} is an instance admin.`),
    },
    revoke: {
      text: `${label(u)} loses access to Admin.`,
      action: 'Remove instance admin',
      run: confirmed('instanceAdmin.revoke', `${label(u)} is no longer an instance admin.`),
    },
  }
  async function enable() {
    try {
      await run('user.enable')
      notify(`${label(u)} can sign in again.`)
    } catch (err) {
      notify(errorText(err))
    }
  }

  return (
    <>
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
          <Fact label="Workspaces">
            {u.workspaces.length
              ? u.workspaces.map(w => (
                  <span key={w.id} className="adm-line">
                    {w.name} <span className="adm-sub-inline">{w.role.charAt(0).toUpperCase() + w.role.slice(1)}</span>
                  </span>
                ))
              : 'None'}
          </Fact>
        </dl>
      </Card>
      <Card title="Actions" className="adm-actions-card">
        {step ? (
          <Confirm {...steps[step]} onConfirm={steps[step].run} onCancel={() => setStep(null)} />
        ) : (
          <>
            {!isSelf && !u.instance_admin && !u.disabled_at && (
              <ActionRow
                title="Sign in as this user"
                text="See Linedesk exactly as they do, for up to an hour. Recorded as done by you."
                button={
                  <Button size="sm" title={`Sign in as ${label(u)}`} onClick={() => setStep('impersonate')}>
                    Sign in as {label(u)}…
                  </Button>
                }
              />
            )}
            {!u.instance_admin && !u.disabled_at && (
              <ActionRow
                title="Make instance admin"
                text="Sees every workspace and user, and sets the provider keys."
                button={
                  <Button size="sm" onClick={() => setStep('grant')}>
                    Make admin…
                  </Button>
                }
              />
            )}
            {u.instance_admin && !isSelf && !u.instance_admin_by_env && (
              <ActionRow
                title="Remove instance admin"
                text="They keep their workspaces and lose access to Admin."
                button={
                  <Button size="sm" onClick={() => setStep('revoke')}>
                    Remove admin…
                  </Button>
                }
              />
            )}
            {u.disabled_at ? (
              <ActionRow
                title="Enable user"
                text="They can sign in again."
                button={
                  <Button size="sm" onClick={() => void enable()}>
                    Enable
                  </Button>
                }
              />
            ) : (
              !isSelf && (
                <ActionRow
                  title="Disable user"
                  text="Signs them out everywhere; they cannot sign in until enabled."
                  button={
                    <Button size="sm" onClick={() => setStep('disable')}>
                      Disable…
                    </Button>
                  }
                />
              )
            )}
            {isSelf && <p className="help">This is you: you can't disable yourself or remove your own admin access.</p>}
          </>
        )}
      </Card>
    </>
  )
}
