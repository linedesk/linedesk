// Workspaces: a searchable list; a click opens the workspace with its facts and actions.
import { useState } from 'react'
import { Badge, Button } from '../ui/kit.tsx'
import { AdminList, type Column, type ListKeys } from './AdminList.tsx'
import { type AdminWorkspace, runAdmin } from './api.ts'
import { formatMinutes } from './model.ts'
import { errorText, type Notify } from './notify.ts'
import { Confirm, day, when } from './parts.tsx'

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
        {w.phone_numbers[0] ?? '–'}
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

type ListProps = { workspaces: AdminWorkspace[]; onOpen: (id: string) => void; keysRef: { current: ListKeys | null } }

export function WorkspacesList({ workspaces, onOpen, keysRef }: ListProps) {
  return (
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
    />
  )
}

type DetailProps = { workspace: AdminWorkspace; notify: Notify; reload: () => Promise<void> }

export function WorkspaceDetail({ workspace: w, notify, reload }: DetailProps) {
  const [confirming, setConfirming] = useState(false)
  const set = async (disabled: boolean) => {
    await runAdmin(disabled ? 'workspace.disable' : 'workspace.enable', { workspaceId: w.id })
    await reload()
  }
  async function disable() {
    await set(true)
    setConfirming(false)
    notify(`${w.name} is disabled. Its calls are no longer answered.`)
  }
  async function enable() {
    try {
      await set(false)
      notify(`${w.name} is enabled. Its calls are answered again.`)
    } catch (err) {
      notify(errorText(err))
    }
  }

  return (
    <>
      <div className="adm-card">
        <dl className="adm-facts">
          <Fact label="Status">{w.disabled_at ? `Disabled ${when(w.disabled_at)}` : 'Active'}</Fact>
          <Fact label="Phone numbers">
            <span className="adm-mono">{w.phone_numbers.join(', ') || 'None'}</span>
          </Fact>
          <Fact label="Members">{w.members}</Fact>
          <Fact label="Calls, last 30 days">{w.calls_30d}</Fact>
          <Fact label="Answered this month">{formatMinutes(w.minutes_this_month)}</Fact>
          <Fact label="Last call">{when(w.last_call_at)}</Fact>
          <Fact label="Created">{day(w.created_at)}</Fact>
        </dl>
      </div>
      <div className="adm-card adm-actions-card">
        {w.disabled_at ? (
          <ActionRow
            title="Enable workspace"
            text="Calls to its numbers are answered again."
            button={
              <Button size="sm" onClick={() => void enable()}>
                Enable
              </Button>
            }
          />
        ) : confirming ? (
          <Confirm
            typed={w.name}
            action="Disable workspace"
            onConfirm={disable}
            onCancel={() => setConfirming(false)}
            text={
              <>
                Calls to {w.name} will no longer be answered and its members can only read. Type the workspace name to
                confirm.
              </>
            }
          />
        ) : (
          <ActionRow
            title="Disable workspace"
            text="Its numbers stop being answered; members can still sign in and read."
            button={
              <Button size="sm" onClick={() => setConfirming(true)}>
                Disable…
              </Button>
            }
          />
        )}
      </div>
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

export function ActionRow({ title, text, button }: { title: string; text: string; button: React.ReactNode }) {
  return (
    <div className="adm-action">
      <div>
        <b>{title}</b>
        <span className="help">{text}</span>
      </div>
      {button}
    </div>
  )
}
