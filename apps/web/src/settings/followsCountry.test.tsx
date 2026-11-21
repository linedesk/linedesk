// Workspace settings › General: the time zone and the appointment value's currency follow the workspace's country.
// Following: no line under the field, the country's option says "(country default)". Set by hand: "Set by hand · Use
// country default (…)", and the country's option keeps its mark.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

let data: Record<string, unknown> = {}
vi.mock('./settings-api.ts', () => ({
  useWorkspaceSettings: () => ({ data, error: null, reload: async () => {} }),
  patchWorkspaceSettings: vi.fn(),
  refreshWorkspaceSettings: vi.fn(),
  callAction: vi.fn(),
  useWriteAction: () => vi.fn(),
}))
let calendars: { id: string }[] = [{ id: 'cal_1' }]
vi.mock('../store.tsx', () => ({
  useRun: () => vi.fn(),
  useRows: (table: string) => (table === 'calendar_connections' ? calendars : []),
  useAssistant: () => null,
}))
vi.mock('../shell/WorkspaceSwitcher.tsx', () => ({ useWorkspaces: () => [] }))

const { WorkspaceGeneral } = await import('./WorkspaceGeneral.tsx')
const { countryDefaultOptions } = await import('./fields.tsx')
const { i18n } = await import('../i18n/index.tsx')

const render = (settings: Record<string, unknown>) => {
  data = {
    resolvedCountry: 'US',
    countryTimeZone: 'America/New_York',
    countryCurrency: 'USD',
    jobValueCents: 35000,
    ...settings,
  }
  return renderToStaticMarkup(
    <WorkspaceGeneral canEdit name="Brightwater Plumbing & Heating" onRenamed={() => {}} toast={() => {}} />,
  )
}

test('following the country: no hint line, the picked time zone and currency say "(country default)"', () => {
  const html = render({
    timeZone: 'America/New_York',
    timeZoneFollowsCountry: true,
    jobValueCurrency: 'USD',
    jobValueCurrencyFollowsCountry: true,
  })
  expect(html).not.toContain('follows-line')
  expect(html).not.toContain('workspace country')
  expect(html).not.toContain('Changes when the country changes')
  expect(html).not.toContain('Set by hand')
  expect(html).toContain('<span>New York · Eastern Time (country default)</span>')
  expect(html).toContain('<span>USD · $ (country default)</span>')
})

test("set by hand: the reset line, and only the country's own option is marked", () => {
  const html = render({
    timeZone: 'America/Chicago',
    timeZoneFollowsCountry: false,
    jobValueCurrency: 'EUR',
    jobValueCurrencyFollowsCountry: false,
  })
  expect(html).toMatch(
    /Set by hand.*<button type="button" class="k-link">Use country default \(New York · Eastern Time\)/,
  )
  expect(html).toMatch(/Currency set by hand.*<button type="button" class="k-link">Use country default \(USD\)/)
  expect(html).toContain('<span>Chicago · Central Time</span>')
  expect(html).toContain('<span>EUR · €</span>')
  expect(html).not.toContain('(country default)</span>')
})

test("the mark goes on the country's option only, and only once the country's value is known", () => {
  const t = i18n().t
  const options = [
    { value: 'USD', label: 'USD · $' },
    { value: 'EUR', label: 'EUR · €' },
  ]
  expect(countryDefaultOptions(options, 'USD', t).map(o => o.label)).toEqual(['USD · $ (country default)', 'EUR · €'])
  expect(countryDefaultOptions(options, null, t).map(o => o.label)).toEqual(['USD · $', 'EUR · €'])
})

test('no calendar and no booking yet: no appointment value', () => {
  calendars = []
  try {
    expect(render({ jobValueCurrency: 'USD' })).not.toContain('ws-appointment-value')
  } finally {
    calendars = [{ id: 'cal_1' }]
  }
})
