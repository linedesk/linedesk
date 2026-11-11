// Workspaces: a searchable list; a click opens the workspace with its facts and actions.
import { Card } from '../ui/form.tsx'
import { Badge } from '../ui/kit.tsx'
import { ActionBar, RowActions, useActionRunner, workspaceActions } from './actions.tsx'
import { AdminList, type Column, type ListKeys } from './AdminList.tsx'
import type { AdminUser, AdminWorkspace } from './api.ts'
import { WorkspaceMembersCard } from './Memberships.tsx'
import { formatMinutes } from './model.ts'
import type { Notify } from './notify.ts'
import { day, when } from './parts.tsx'
import { formatNumber } from '../onboarding/flow.ts'

const columns: Column<AdminWorkspace>[] = [
  {
    key: 'name',
    label: 'Workspace',
    sort: w => w.name,
    render: w => (
      <span className="adm-strong">
        {w.name}
        {w.disabled_at && <Badge>Disabled</Badge>}
      </span>
    ),
  },
  {
    key: 'numbers',
    label: 'Number',
    wide: true,
    render: w => (
      <span className="adm-mono">
        {w.phone_numbers[0] ? formatNumber(w.phone_numbers[0]) : '–'}
        {w.phone_numbers.length > 1 && ` +${w.phone_numbers.length - 1}`}
      </span>
    ),
  },
  {
    key: 'calls',
    label: 'Calls, 30 days',
    numeric: true,
    firstDir: 'desc',
    sort: w => w.calls_30d,
    render: w => w.calls_30d,
  },
  {
    key: 'last',
    label: 'Last call',
    firstDir: 'desc',
    wide: true,
    sort: w => (w.last_call_at ? Date.parse(w.last_call_at) : null),
    render: w => when(w.last_call_at),
  },
]

type ListProps = {
  workspaces: AdminWorkspace[]
  onOpen: (id: string) => void
  keysRef: { current: ListKeys | null }
  notify: Notify
  reload: () => Promise<void>
}

export function WorkspacesList({ workspaces, onOpen, keysRef, notify, reload }: ListProps) {
  const runner = useActionRunner(notify)
  return (
    <>
      <AdminList
        rows={workspaces}
        rowId={w => w.id}
        columns={columns}
        initialSort={{ key: 'name', dir: 'asc' }}
        searchText={w => `${w.name} ${w.phone_numbers.join(' ')}`}
        searchLabel="Search workspaces"
        onOpen={w => onOpen(w.id)}
        keysRef={keysRef}
        empty="No workspaces yet."
        rowActions={w => <RowActions actions={workspaceActions(w, reload)} onPick={runner.pick} />}
      />
      {runner.dialog}
    </>
  )
}

type DetailProps = { workspace: AdminWorkspace; users: AdminUser[]; notify: Notify; reload: () => Promise<void> }

export function WorkspaceDetail({ workspace: w, users, notify, reload }: DetailProps) {
  const runner = useActionRunner(notify)
  return (
    <>
      <ActionBar actions={workspaceActions(w, reload)} onPick={runner.pick} />
      <Card title="Details" className="adm-detail">
        <dl className="adm-facts">
          <Fact label="Status">{w.disabled_at ? `Disabled ${when(w.disabled_at)}` : 'Active'}</Fact>
          <Fact label="Phone numbers">
            <span className="adm-mono">{w.phone_numbers.map(formatNumber).join(', ') || 'None'}</span>
          </Fact>
          <Fact label="Calls, last 30 days">{w.calls_30d}</Fact>
          <Fact label="Answered this month">{formatMinutes(w.minutes_this_month)}</Fact>
          <Fact label="Last call">{when(w.last_call_at)}</Fact>
          <Fact label="Created">{day(w.created_at)}</Fact>
        </dl>
      </Card>
      <WorkspaceMembersCard workspace={w} users={users} notify={notify} reload={reload} />
      {runner.dialog}
    </>
  )
}

export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
