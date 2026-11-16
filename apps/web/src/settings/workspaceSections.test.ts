import { expect, test, vi } from 'vitest'

vi.mock('../team/TeamPage.tsx', () => ({ TeamSection: () => null }))
const { shownSectionIds } = await import('./WorkspaceSettings.tsx')

test('during support access the export goes, API keys stay; members see neither', () => {
  expect(shownSectionIds(true, true)).toEqual(['general', 'team', 'phone', 'recordings', 'export', 'developers', 'danger'])
  expect(shownSectionIds(false, true)).toEqual(['general', 'team', 'phone', 'recordings', 'developers', 'danger'])
  expect(shownSectionIds(false, false)).toEqual(['general', 'team', 'phone', 'recordings', 'danger'])
})
