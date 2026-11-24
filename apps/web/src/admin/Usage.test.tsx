// Server admin › Usage: only the listed workspaces count; a deleted workspace's charge must not show the dollar note.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { AdminWorkspace, UsageRow } from './api.ts'
import { monthLabel, recentMonths } from './model.ts'
import { Usage } from './Usage.tsx'

const [month] = recentMonths(1)
const workspaces = [{ id: 'a', name: 'Brightwater Plumbing & Heating' }] as AdminWorkspace[]
const row = (workspace_id: string, charged_micros: number | null): UsageRow => ({
  workspace_id,
  workspace_name: null,
  month: month!,
  calls: 3,
  minutes: 4,
  charged_micros,
})

test('the dollar note only when a listed workspace has a dollar amount', () => {
  const gone = renderToStaticMarkup(
    <Usage workspaces={workspaces} usage={[row('a', null), row('gone', 0)]} months={12} />,
  )
  expect(gone).not.toContain('adm-usage-note')
  expect(gone).not.toContain('6 calls') // the deleted workspace's calls are not in the total either
  const billed = renderToStaticMarkup(<Usage workspaces={workspaces} usage={[row('a', 1_500_000)]} months={12} />)
  expect(billed).toContain('adm-usage-note')
  expect(billed).toContain('$1.50')
})

test('months on a time axis: the oldest on the left, the current month on the very right', () => {
  const months = recentMonths(3) // newest first
  const html = renderToStaticMarkup(<Usage workspaces={workspaces} usage={[row('a', null)]} months={3} />)
  const head = html.slice(0, html.indexOf('</thead>'))
  const at = months.map(m => head.indexOf(monthLabel(m)))
  expect(at.every(i => i > 0)).toBe(true)
  expect(at[2]!).toBeLessThan(at[1]!)
  expect(at[1]!).toBeLessThan(at[0]!)
})
