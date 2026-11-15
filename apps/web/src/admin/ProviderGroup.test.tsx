import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

// Every admin write goes through runAdmin: switching tabs must never call it.
const runAdmin = vi.hoisted(() => vi.fn())
vi.mock('./api.ts', async importOriginal => ({ ...(await importOriginal<object>()), runAdmin }))

const { AnsweringWayTabs } = await import('./ProviderGroup.tsx')

type TabProps = { id: string; onClick: () => void; onKeyDown: (e: unknown) => void }
const tabsOf = (el: ReactElement<{ children: ReactElement<TabProps>[] }>) => el.props.children

test('the Answering tabs: tablist, the chosen tab selected and focusable, In use and the check', () => {
  const html = renderToStaticMarkup(
    <AnsweringWayTabs selected="realtime" marks={{ realtime: 'in_use', three_stage: 'works' }} onSelect={() => {}} />,
  )
  expect(html).toContain('role="tablist"')
  const tab = (way: string) => html.match(new RegExp(`<button[^>]*id="adm-way-tab-${way}"[^>]*>`))?.[0] ?? ''
  expect(tab('realtime')).toContain('role="tab"')
  expect(tab('realtime')).toContain('aria-selected="true"')
  expect(tab('realtime')).toContain('tabindex="0"')
  expect(tab('three_stage')).toContain('aria-selected="false"')
  expect(tab('three_stage')).toContain('tabindex="-1"')
  expect(html).toContain('aria-controls="adm-way-panel"')
  expect(html).toContain('<span class="adm-way-use">In use</span>')
  expect(html).toContain('aria-label="Works, not in use"')
})

/** A component's element tree, made inside a render: its hooks (the language) need one. */
let captured: ReactElement | null = null
function Capture({ make }: { make: () => ReactElement }) {
  captured = make()
  return null
}
function elementOf(make: () => ReactElement): ReactElement {
  renderToStaticMarkup(<Capture make={make} />)
  return captured!
}

test('switching tabs, by click or arrow key, only changes the view: it does not change which one answers calls', () => {
  const onSelect = vi.fn()
  const el = elementOf(() =>
    AnsweringWayTabs({ selected: 'realtime', marks: { realtime: 'in_use', three_stage: null }, onSelect }),
  )
  const [realtime, three] = tabsOf(el as ReactElement<{ children: ReactElement<TabProps>[] }>)
  three!.props.onClick()
  expect(onSelect).toHaveBeenLastCalledWith('three_stage')
  const key = (k: string) => ({ key: k, preventDefault: () => {}, currentTarget: { parentElement: null } })
  realtime!.props.onKeyDown(key('ArrowRight'))
  expect(onSelect).toHaveBeenLastCalledWith('three_stage')
  realtime!.props.onKeyDown(key('a'))
  expect(onSelect).toHaveBeenCalledTimes(2)
  expect(runAdmin).not.toHaveBeenCalled()
})

test('the Answering tabs say every word through the catalog (pseudo-locale)', async () => {
  const { enMessages, PSEUDO_LOCALE } = await import('@linedesk/i18n')
  const { pseudoMessages } = await import('@linedesk/i18n/pseudo')
  const { createI18n, I18nProvider } = await import('@linedesk/i18n/react')
  const html = renderToStaticMarkup(
    <I18nProvider value={createI18n(PSEUDO_LOCALE, pseudoMessages(enMessages))}>
      <AnsweringWayTabs selected="realtime" marks={{ realtime: 'in_use', three_stage: 'works' }} onSelect={() => {}} />
    </I18nProvider>,
  )
  expect(html).not.toContain('One realtime model')
  expect(html).not.toContain('>In use<')
  expect(html).toContain('⟦')
})
