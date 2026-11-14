import type { AdminWorkspace, UsageRow } from './api.ts'
import { formatMinutes, monthLabel, recentMonths, sortRows, usageByWorkspace } from './model.ts'
import { SortTh, useSort } from './parts.tsx'

type Column = 'name' | 'month'
type Props = { workspaces: AdminWorkspace[]; usage: UsageRow[]; months: number }

/** Answered minutes and calls per workspace and calendar month (UTC). */
export function Usage({ workspaces, usage, months }: Props) {
  const { sort, toggle } = useSort<Column>({ key: 'month', dir: 'desc' })
  const columns = recentMonths(months)
  const grid = usageByWorkspace(usage)
  const current = (w: AdminWorkspace) => grid.get(w.id)?.get(columns[0]!)?.minutes ?? 0
  const rows = sortRows(workspaces, sort.key === 'name' ? w => w.name : current, sort.dir)

  return (
    <div className="adm-card">
      <div className="adm-scroll">
        <table className="adm-table adm-stack adm-stack-grid">
          <thead>
            <tr>
              <SortTh label="Workspace" column="name" sort={sort} onSort={toggle} />
              {columns.map((month, i) =>
                i === 0 ? (
                  <SortTh
                    key={month}
                    label={monthLabel(month)}
                    column="month"
                    first="desc"
                    numeric
                    sort={sort}
                    onSort={toggle}
                  />
                ) : (
                  <th key={month} scope="col" className="adm-num">
                    {monthLabel(month)}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map(w => (
              <tr key={w.id}>
                <th scope="row">{w.name}</th>
                {columns.map(month => {
                  const cell = grid.get(w.id)?.get(month)
                  return (
                    <td key={month} className="adm-num" data-label={monthLabel(month)}>
                      {cell ? formatMinutes(cell.minutes) : '–'}
                      {cell ? (
                        <span className="adm-sub">
                          {cell.calls} {cell.calls === 1 ? 'call' : 'calls'}
                        </span>
                      ) : null}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
