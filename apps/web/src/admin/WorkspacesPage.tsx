// Workspaces: a searchable list; a click opens the workspace with its facts and actions.
import { type FormEvent, useEffect, useState } from 'react'
import { Card, FormField, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { ActionBar, RowActions, useActionRunner, workspaceActions } from './actions.tsx'
import { AdminList, type Column, type ListKeys } from './AdminList.tsx'
import { type AdminUser, type AdminWorkspace, runAdmin } from './api.ts'
import { WorkspaceMembersCard } from './Memberships.tsx'
import { formatMinutes, formatUsd, parseSpendingCap } from './model.ts'
import { errorText, type Notify } from './notify.ts'
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
          <Fact label="Estimated cost this month">{formatUsd(w.cost_this_month)}</Fact>
          <Fact label="Last call">{when(w.last_call_at)}</Fact>
          <Fact label="Created">{day(w.created_at)}</Fact>
        </dl>
      </Card>
      <SpendingCapCard workspace={w} notify={notify} reload={reload} />
      <WorkspaceMembersCard workspace={w} users={users} notify={notify} reload={reload} />
      {runner.dialog}
    </>
  )
}

/** The workspace's monthly spending cap: empty is no cap. Instance admins only (the whole admin area is). */
function SpendingCapCard({ workspace: w, notify, reload }: { workspace: AdminWorkspace; notify: Notify; reload: () => Promise<void> }) {
  const saved = w.spending_cap_usd === null ? '' : String(w.spending_cap_usd)
  const [text, setText] = useState(saved)
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => setText(saved), [saved])
  const reached = w.spending_cap_usd !== null && w.cost_this_month >= w.spending_cap_usd
  async function save(e: FormEvent) {
    e.preventDefault()
    const parsed = parseSpendingCap(text)
    if ('problem' in parsed) return setProblem(parsed.problem)
    setProblem(null)
    setSaving(true)
    try {
      await runAdmin('workspace.setSpendingCap', { workspaceId: w.id, capUsd: parsed.capUsd })
      await reload()
      notify(parsed.capUsd === null ? `${w.name} has no spending cap.` : `${w.name}'s monthly spending cap is ${formatUsd(parsed.capUsd)}.`)
    } catch (err) {
      setProblem(errorText(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Card
      title="Monthly spending cap"
      description="On the estimated cost of this month's calls (UTC). Once reached, the assistant stops answering: callers hear that the business will call back, and each call is filed as missed with Call back. Owners and instance admins get an email at 80% and 100%."
      className="adm-detail"
    >
      <form onSubmit={save} className="adm-cap-form">
        <FormField id="adm-spending-cap" label="Cap in USD" aside="Empty: no cap" error={problem}>
          <Input id="adm-spending-cap" inputMode="decimal" placeholder="No cap" value={text} invalid={!!problem} onChange={e => setText(e.target.value)} />
        </FormField>
        <Button type="submit" variant="primary" disabled={saving || text.trim() === saved}>
          Save
        </Button>
      </form>
      {reached && <p className="adm-cap-note">Reached this month: the assistant is not answering this workspace's calls.</p>}
    </Card>
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
