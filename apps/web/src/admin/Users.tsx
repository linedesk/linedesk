import { useState } from 'react'
import { Badge, Button } from '../ui/kit.tsx'
import { Section } from '../settings/fields.tsx'
import { type AdminUser, runAdmin } from './api.ts'
import { sortRows } from './model.ts'
import { Confirm, day, runAndToast, SortTh, useSort, when } from './parts.tsx'

type Column = 'name' | 'signin' | 'created'
const sortValue: Record<Column, (u: AdminUser) => string | number | null> = {
  name: u => u.name || u.email,
  signin: u => (u.last_sign_in_at ? Date.parse(u.last_sign_in_at) : null),
  created: u => Date.parse(u.created_at),
}

type Pending = { userId: string; step: 'disable' | 'grant' | 'revoke' }
type Props = { users: AdminUser[]; currentUserId: string; toast: (text: string) => void; reload: () => Promise<void> }

export function Users({ users, currentUserId, toast, reload }: Props) {
  const { sort, toggle } = useSort<Column>({ key: 'name', dir: 'asc' })
  const [pending, setPending] = useState<Pending | null>(null)
  const rows = sortRows(users, sortValue[sort.key], sort.dir)
  const label = (u: AdminUser) => u.name || u.email

  async function confirmed(run: () => Promise<unknown>, done: string) {
    await run()
    setPending(null)
    await reload()
    toast(done)
  }
  const steps: Record<Pending['step'], (u: AdminUser) => { text: string; action: string; run: () => Promise<void> }> = {
    disable: u => ({
      text: `${label(u)} is signed out everywhere and cannot sign in again until enabled.`,
      action: 'Disable user',
      run: () => confirmed(() => runAdmin('user.disable', { userId: u.id }), `${label(u)} is disabled and signed out.`),
    }),
    grant: u => ({
      text: `${label(u)} will see every workspace and user, and can change the provider keys.`,
      action: 'Make instance admin',
      run: () =>
        confirmed(() => runAdmin('instanceAdmin.grant', { userId: u.id }), `${label(u)} is an instance admin.`),
    }),
    revoke: u => ({
      text: `${label(u)} loses access to this page.`,
      action: 'Remove instance admin',
      run: () =>
        confirmed(
          () => runAdmin('instanceAdmin.revoke', { userId: u.id }),
          `${label(u)} is no longer an instance admin.`,
        ),
    }),
  }
  const enable = (u: AdminUser) =>
    runAndToast(() => runAdmin('user.enable', { userId: u.id }), `${label(u)} can sign in again.`, toast, reload)

  return (
    <Section id="adm-users" title="Users" description="Everyone with an account, in any workspace.">
      <div className="adm-scroll">
        <table className="adm-table">
          <thead>
            <tr>
              <SortTh label="User" column="name" sort={sort} onSort={toggle} />
              <th scope="col">Workspaces</th>
              <SortTh label="Last sign-in" column="signin" first="desc" sort={sort} onSort={toggle} />
              <SortTh label="Created" column="created" first="desc" sort={sort} onSort={toggle} />
              <th scope="col">
                <span className="adm-sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(u => {
              const step = pending?.userId === u.id ? pending.step : null
              const ask = (next: Pending['step']) => () => setPending({ userId: u.id, step: next })
              const isSelf = u.id === currentUserId
              return (
                <UserRow
                  key={u.id}
                  user={u}
                  isSelf={isSelf}
                  asking={step}
                  onAsk={ask}
                  onEnable={() => void enable(u)}
                  confirm={
                    step && (
                      <Confirm {...steps[step](u)} onConfirm={steps[step](u).run} onCancel={() => setPending(null)} />
                    )
                  }
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

type RowProps = {
  user: AdminUser
  isSelf: boolean
  asking: Pending['step'] | null
  onAsk: (step: Pending['step']) => () => void
  onEnable: () => void
  confirm: React.ReactNode
}

function UserRow({ user: u, isSelf, asking, onAsk, onEnable, confirm }: RowProps) {
  return (
    <>
      <tr className={u.disabled_at ? 'adm-off' : undefined}>
        <th scope="row">
          {u.name || '–'}
          {isSelf && <Badge>You</Badge>}
          {u.instance_admin && <Badge>Instance admin</Badge>}
          {u.disabled_at && <Badge>Disabled</Badge>}
          <span className="adm-sub">{u.email}</span>
        </th>
        <td>
          {u.workspaces.length
            ? u.workspaces.map(w => (
                <span key={w.id} className="adm-line">
                  {w.name} <span className="adm-sub-inline">{w.role}</span>
                </span>
              ))
            : '–'}
        </td>
        <td>{when(u.last_sign_in_at)}</td>
        <td>{day(u.created_at)}</td>
        <td className="adm-actions">
          {u.instance_admin
            ? !isSelf &&
              !u.instance_admin_by_env && (
                <Button size="sm" variant="ghost" aria-expanded={asking === 'revoke'} onClick={onAsk('revoke')}>
                  Remove admin
                </Button>
              )
            : !u.disabled_at && (
                <Button size="sm" variant="ghost" aria-expanded={asking === 'grant'} onClick={onAsk('grant')}>
                  Make admin
                </Button>
              )}
          {u.instance_admin_by_env && (
            <span className="help" title="Listed in INSTANCE_ADMIN_EMAILS">
              Admin by environment
            </span>
          )}
          {u.disabled_at ? (
            <Button size="sm" variant="ghost" onClick={onEnable}>
              Enable
            </Button>
          ) : (
            !isSelf && (
              <Button size="sm" variant="ghost" aria-expanded={asking === 'disable'} onClick={onAsk('disable')}>
                Disable
              </Button>
            )
          )}
        </td>
      </tr>
      {confirm && (
        <tr className="adm-confirm-row">
          <td colSpan={5}>{confirm}</td>
        </tr>
      )}
    </>
  )
}
