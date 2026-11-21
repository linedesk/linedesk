import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import type { AdminWorkspace, UsageRow } from './api.ts'
import { usdOfMicros } from './billingModel.ts'
import {
  formatMinutes,
  monthLabel,
  monthsWithUsage,
  recentMonths,
  sortRows,
  type UsageCell,
  usageByWorkspace,
  usageTotals,
} from './model.ts'
import { EMPTY, SortTh, useSort } from './parts.tsx'

type Column = 'name' | 'month'
type Props = { workspaces: AdminWorkspace[]; usage: UsageRow[]; months: number }

/**
 * Answered minutes, calls and, with billing, the dollars charged per workspace and calendar month (UTC). Only months
 * back to the first usage get a column; workspaces without calls in them wait behind a button. The dollar note shows
 * only when a listed workspace has a dollar amount.
 */
export function Usage({ workspaces, usage, months }: Props) {
  const t = useT()
  const { sort, toggle } = useSort<Column>({ key: 'month', dir: 'desc' })
  const [showIdle, setShowIdle] = useState(false)
  // Only usage of the workspaces listed here: a deleted workspace's calls or charges would change the months, the
  // total and the dollar note without a row to show them.
  const ids = new Set(workspaces.map(w => w.id))
  const listed = usage.filter(u => ids.has(u.workspace_id))
  const columns = monthsWithUsage(recentMonths(months), listed)
  const grid = usageByWorkspace(listed)
  const used = (w: AdminWorkspace) => columns.some(month => grid.get(w.id)?.has(month))
  const current = (w: AdminWorkspace) => grid.get(w.id)?.get(columns[0]!)?.minutes ?? 0
  const byName = (w: AdminWorkspace) => w.name
  const active = sortRows(workspaces.filter(used), sort.key === 'name' ? byName : current, sort.dir)
  const idle = sortRows(
    workspaces.filter(w => !used(w)),
    byName,
    sort.key === 'name' ? sort.dir : 'asc',
  )
  const idleShown = showIdle || active.length === 0
  const totals = usageTotals(grid, columns)
  const billed = listed.some(u => u.charged_micros !== null)

  return (
    <div className="adm-card">
      <div className="adm-scroll">
        <table className="adm-table adm-stack adm-stack-grid adm-usage">
          <thead>
            <tr>
              <SortTh label={t('admin.usage.workspace')} column="name" sort={sort} onSort={toggle} />
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
            {active.length > 1 && (
              <tr className="adm-total">
                <th scope="row">{t('admin.usage.total')}</th>
                {columns.map(month => (
                  <UsageTd key={month} month={month} cell={totals.get(month)} />
                ))}
              </tr>
            )}
            {[...active, ...(idleShown ? idle : [])].map(w => (
              <tr key={w.id}>
                <th scope="row">
                  <span className="adm-usage-name" title={w.name}>
                    {w.name}
                  </span>
                </th>
                {columns.map(month => (
                  <UsageTd key={month} month={month} cell={grid.get(w.id)?.get(month)} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(idle.length > 0 && active.length > 0) || billed ? (
        <div className="adm-usage-foot">
          {idle.length > 0 && active.length > 0 && (
            <button type="button" className="k-btn k-btn-ghost k-btn-sm" onClick={() => setShowIdle(!showIdle)}>
              {showIdle ? t('admin.usage.hideIdle') : t('admin.usage.showIdle', { count: idle.length })}
            </button>
          )}
          {billed && <p className="adm-usage-note">{t('admin.usage.chargedNote')}</p>}
        </div>
      ) : null}
    </div>
  )
}

/** One month: minutes, then calls and the dollars charged on one quiet line; a muted dash without calls. */
function UsageTd({ month, cell }: { month: string; cell: UsageCell | undefined }) {
  const t = useT()
  return (
    <td className="adm-num" data-label={monthLabel(month)}>
      {cell ? (
        <>
          {formatMinutes(cell.minutes)}
          <span className="adm-sub">
            {t('admin.usage.calls', { count: cell.calls })}
            {cell.chargedMicros !== null &&
              ` · ${t('admin.usage.charged', { amount: usdOfMicros(cell.chargedMicros) })}`}
          </span>
        </>
      ) : (
        <span className="adm-usage-empty">{EMPTY}</span>
      )}
    </td>
  )
}
