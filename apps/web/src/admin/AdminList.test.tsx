import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { AdminList } from './AdminList.tsx'
import type { AdminAction } from './actions.tsx'
import { RowActions } from './actions.tsx'

type Row = { id: string; name: string; last: string }
const rows: Row[] = [{ id: '1', name: 'Dana Ruiz', last: 'Never' }]
const columns = [
  { key: 'name', label: 'User', render: (r: Row) => r.name },
  { key: 'last', label: 'Last sign-in', render: (r: Row) => r.last },
]
const action = (id: string): AdminAction => ({ id, label: `${id}…`, icon: 'ban', tip: id, run: async () => {} })

const list = (withActions: boolean) =>
  renderToStaticMarkup(
    <AdminList
      rows={rows}
      rowId={r => r.id}
      columns={columns}
      initialSort={{ key: 'name', dir: 'asc' }}
      searchText={r => r.name}
      searchLabel="Search users"
      onOpen={() => {}}
      keysRef={{ current: null }}
      empty="No users"
      rowActions={withActions ? () => <RowActions actions={[action('disable')]} onPick={() => {}} /> : undefined}
    />,
  )

test('row actions get a column of their own, with a heading, so they never sit on a cell', () => {
  const html = list(true)
  expect(html).toContain('class="adm-list adm-list-acts"')
  expect(html).toMatch(/<div role="columnheader" class="adm-cell adm-cell-acts" aria-label="Actions"><\/div>/)
  expect(html).toContain('<div class="adm-cell adm-cell-acts"><div class="adm-rowacts">')
})

test('a list without row actions keeps its columns as they were', () => {
  const html = list(false)
  expect(html).toContain('class="adm-list"')
  expect(html).not.toContain('adm-cell-acts')
})

test('the ⋯ of a row is the shared menu button', () => {
  const html = renderToStaticMarkup(
    <RowActions actions={[action('impersonate'), action('disable')]} onPick={() => {}} />,
  )
  expect(html).toContain('class="adm-rowacts-more"><span class="k-menu-wrap">')
  expect(html).toContain('aria-haspopup="menu"')
  expect(html).not.toContain('adm-rowmenu')
})

// jsdom has no layout, so the stylesheet is checked: no actions laid over the row, a reserved column, the ⋯ on phones.
test('the stylesheet reserves the actions column and folds the icons into a 44px ⋯ on phones and touch', () => {
  const css = readFileSync(new URL('./admin.css', import.meta.url), 'utf8')
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.()>:]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
  expect(rule('.adm-cell.adm-cell-acts')).not.toContain('position: absolute')
  expect(css).not.toMatch(/\.adm-cell-acts[^{]*\{[^}]*position: absolute/)
  expect(rule('.adm-list-acts > .adm-row')).toContain('var(--adm-acts-w)')
  const phone =
    /@media \(max-width: 767px\), \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  expect(phone).toMatch(/\.adm-rowacts-icons \{\s*display: none;/)
  expect(phone).toMatch(/\.adm-rowacts-more \{\s*display: inline-flex;/)
  expect(phone).toMatch(/\.adm-rowacts-more \.k-menu-btn \{\s*width: 44px;\s*height: 44px;/)
  expect(phone).toMatch(/--adm-acts-w: 44px;/)
})
