import { useState } from 'react'
import { Badge, Button } from '../ui/kit.tsx'
import { Section } from '../settings/fields.tsx'
import { type AdminWorkspace, runAdmin } from './api.ts'
import { formatMinutes, sortRows } from './model.ts'
import { Confirm, day, runAndToast, SortTh, useSort, when } from './parts.tsx'

type Column = 'name' | 'calls' | 'last'
const sortValue: Record<Column, (w: AdminWorkspace) => string | number | null> = {
  name: w => w.name,
  calls: w => w.calls_30d,
  last: w => (w.last_call_at ? Date.parse(w.last_call_at) : null),
}

type Props = { workspaces: AdminWorkspace[]; toast: (text: string) => void; reload: () => Promise<void> }

export function Workspaces({ workspaces, toast, reload }: Props) {
  const { sort, toggle } = useSort<Column>({ key: 'name', dir: 'asc' })
  const [confirming, setConfirming] = useState<string | null>(null)
  const rows = sortRows(workspaces, sortValue[sort.key], sort.dir)

  async function disable(workspace: AdminWorkspace) {
    await runAdmin('workspace.disable', { workspaceId: workspace.id })
    setConfirming(null)
    await reload()
    toast(`${workspace.name} is disabled. Its calls are no longer answered.`)
  }
  const enable = (workspace: AdminWorkspace) =>
    runAndToast(
      () => runAdmin('workspace.enable', { workspaceId: workspace.id }),
      `${workspace.name} is enabled. Its calls are answered again.`,
      toast,
      reload,
    )

  return (
    <Section id="adm-workspaces" title="Workspaces" description="Every business on this install.">
      <div className="adm-scroll">
        <table className="adm-table">
          <thead>
            <tr>
              <SortTh label="Workspace" column="name" sort={sort} onSort={toggle} />
              <th scope="col">Phone numbers</th>
              <th scope="col" className="adm-num">
                Members
              </th>
              <SortTh label="Calls, 30 days" column="calls" first="desc" numeric sort={sort} onSort={toggle} />
              <th scope="col" className="adm-num">
                This month
              </th>
              <SortTh label="Last call" column="last" first="desc" sort={sort} onSort={toggle} />
              <th scope="col">Created</th>
              <th scope="col">
                <span className="adm-sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(w => (
              <WorkspaceRow
                key={w.id}
                workspace={w}
                confirming={confirming === w.id}
                onAsk={() => setConfirming(w.id)}
                onCancel={() => setConfirming(null)}
                onDisable={() => disable(w)}
                onEnable={() => void enable(w)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="help">No workspaces yet.</p>}
    </Section>
  )
}

type RowProps = {
  workspace: AdminWorkspace
  confirming: boolean
  onAsk: () => void
  onCancel: () => void
  onDisable: () => Promise<void>
  onEnable: () => void
}

function WorkspaceRow({ workspace: w, confirming, onAsk, onCancel, onDisable, onEnable }: RowProps) {
  return (
    <>
      <tr className={w.disabled_at ? 'adm-off' : undefined}>
        <th scope="row">
          {w.name}
          {w.disabled_at && <Badge>Disabled</Badge>}
        </th>
        <td className="adm-mono">{w.phone_numbers.join(', ') || '–'}</td>
        <td className="adm-num">{w.members}</td>
        <td className="adm-num">{w.calls_30d}</td>
        <td className="adm-num">{formatMinutes(w.minutes_this_month)}</td>
        <td>{when(w.last_call_at)}</td>
        <td>{day(w.created_at)}</td>
        <td className="adm-actions">
          {w.disabled_at ? (
            <Button size="sm" variant="ghost" onClick={onEnable}>
              Enable
            </Button>
          ) : (
            <Button size="sm" variant="ghost" aria-expanded={confirming} onClick={onAsk}>
              Disable
            </Button>
          )}
        </td>
      </tr>
      {confirming && (
        <tr className="adm-confirm-row">
          <td colSpan={8}>
            <Confirm
              typed={w.name}
              action="Disable workspace"
              onConfirm={onDisable}
              onCancel={onCancel}
              text={<>Calls to {w.name} will no longer be answered. Type the workspace name to confirm.</>}
            />
          </td>
        </tr>
      )}
    </>
  )
}
