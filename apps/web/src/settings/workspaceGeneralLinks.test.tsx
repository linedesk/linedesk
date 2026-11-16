// Workspace settings › General: no workspace call language (removed 2026-11-16; the assistant's main language picks the
// call language), and during support access every field is read-only and says why.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

vi.mock('./settings-api.ts', () => ({
  useWorkspaceSettings: () => ({ data: null, error: null, reload: async () => {} }),
  patchWorkspaceSettings: vi.fn(),
  refreshWorkspaceSettings: vi.fn(),
  callAction: vi.fn(),
  useWriteAction: () => vi.fn(),
}))
vi.mock('../store.tsx', () => ({ useRun: () => vi.fn(), useRows: () => [] }))
vi.mock('../shell/WorkspaceSwitcher.tsx', () => ({ useWorkspaces: () => [] }))

const { WorkspaceGeneral } = await import('./WorkspaceGeneral.tsx')
const { SupportAccessContext } = await import('../supportAccess.ts')

const render = (canEdit: boolean, supportAccess = false) =>
  renderToStaticMarkup(
    <SupportAccessContext.Provider value={supportAccess}>
      <WorkspaceGeneral canEdit={canEdit} name="Brightwater Plumbing & Heating" onRenamed={() => {}} toast={() => {}} />
    </SupportAccessContext.Provider>,
  )

test('there is no call language field, for admins and read-only members alike', () => {
  for (const canEdit of [true, false]) {
    const html = render(canEdit)
    expect(html).not.toContain('ws-language')
    expect(html).not.toContain('Call language')
  }
})

test('during support access every field is read-only and says why', () => {
  const html = render(false, true)
  expect(html).toContain('Read-only while you are signed in as another user.')
  expect(html).not.toContain('Only admins can change this.')
  expect(html).toMatch(/id="ws-name"[^>]*readOnly|readOnly[^>]*id="ws-name"/i)
})
