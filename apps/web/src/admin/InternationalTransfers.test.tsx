// Server admin › System › International transfers: countries by name as chips (no typed codes), the empty state, a list
// set in the server's env without remove or add, and the last 24 hours and limits as short rows.
import type { OutboundCountriesData } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'

let data: OutboundCountriesData | undefined
vi.mock('../cachedQuery.ts', async original => ({
  ...(await original<object>()),
  useQuery: () => ({ data, error: null, reload: async () => {} }),
}))

const { InternationalTransfers, addableCountries, transferStats } = await import('./InternationalTransfers.tsx')

const base: OutboundCountriesData = {
  countries: [],
  fromEnv: false,
  usage: { transferMinutes: 6, installTransferMinutes: 6, transfers: 4, forwardingChecks: 0 },
  limits: { minutesPerWorkspaceDay: 120, minutesInstallDay: 2000, transferMaxMinutes: 30 },
  highRisk: ['CU'],
  twilioBlocked: null,
  spendCapsUnconfirmed: [],
}

beforeEach(() => {
  data = base
})

test('with no countries it says each workspace calls only its own, with the picker to add one', () => {
  const html = renderToStaticMarkup(<InternationalTransfers />)
  expect(html).toContain('International transfers')
  expect(html).toContain('Only each workspace’s own countries')
  expect(html).toContain('Add country')
  expect(html).not.toContain('country codes')
})

test('allowed countries show by name, each with a remove button', () => {
  data = { ...base, countries: ['CA', 'MX'] }
  const html = renderToStaticMarkup(<InternationalTransfers />)
  expect(html).toContain('Canada')
  expect(html).toContain('Mexico')
  expect(html).toContain('aria-label="Remove Canada"')
  expect(html).not.toContain('Only each workspace’s own countries')
})

test('a list set by OUTBOUND_COUNTRIES can be neither changed nor added to here', () => {
  data = { ...base, countries: ['CA'], fromEnv: true }
  const html = renderToStaticMarkup(<InternationalTransfers />)
  expect(html).toContain('Canada')
  expect(html).not.toContain('Remove Canada')
  expect(html).not.toContain('Add country')
  expect(html).toContain('Set by OUTBOUND_COUNTRIES on this server.')
})

test('the picker offers every country but the allowed ones', () => {
  const codes = addableCountries(['CA']).map(o => o.value)
  expect(codes).not.toContain('CA')
  expect(codes).toContain('MX')
  expect(addableCountries([]).find(o => o.value === 'DE')).toMatchObject({ label: 'Germany', meta: 'DE' })
})

test('the stats: one row for the last 24 hours and one per limit', () => {
  expect(transferStats(base)).toEqual([
    { label: 'Last 24 hours', value: '4 transfers · 6 min · 0 forwarding checks' },
    { label: 'Limit per workspace', value: '120 min a day' },
    { label: 'Limit for the server', value: '2,000 min a day' },
    { label: 'Longest transfer', value: '30 min' },
  ])
})

test("the minutes on this server's carrier account get a row only when they differ", () => {
  const rows = transferStats({ ...base, usage: { ...base.usage, installTransferMinutes: 2 } })
  expect(rows[1]).toEqual({ label: 'On this server’s carrier account', value: '2 min' })
})

test('a limit of 0 shows that transfers are off instead of the limits', () => {
  const rows = transferStats({ ...base, limits: { ...base.limits, transferMaxMinutes: 0 } })
  expect(rows.map(r => r.label)).toEqual(['Last 24 hours', 'Limits'])
  expect(rows[1]?.value).toBe('Transfers are off (a limit is 0)')
})
