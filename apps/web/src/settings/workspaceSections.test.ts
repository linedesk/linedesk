import { expect, test, vi } from 'vitest'

vi.mock('../team/TeamPage.tsx', () => ({ TeamSection: () => null }))
const { shownSectionIds } = await import('./WorkspaceSettings.tsx')

test('members and support access see no export; API keys moved to Integrations', () => {
  expect(shownSectionIds(true)).toEqual(['general', 'team', 'phone', 'recordings', 'export', 'danger'])
  expect(shownSectionIds(false)).toEqual(['general', 'team', 'phone', 'recordings', 'danger'])
})

test('Billing only on a billed workspace, for the person who manages it (Linedesk Cloud)', () => {
  expect(shownSectionIds(true, true)).toEqual(['general', 'team', 'phone', 'recordings', 'export', 'billing', 'danger'])
  expect(shownSectionIds(true, false)).not.toContain('billing')
})
