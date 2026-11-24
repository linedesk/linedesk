// Read-only settings for members (UI cleanup S3): one note at the top of the section says why, not a line under every
// field; during support access the note says that instead.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { SupportAccessContext } from '../supportAccess.ts'

vi.mock('./settings-api.ts', () => ({
  useWorkspaceSettings: () => ({ data: null, error: null, reload: async () => {} }),
  patchWorkspaceSettings: vi.fn(),
  refreshWorkspaceSettings: vi.fn(),
  callAction: vi.fn(),
  useWriteAction: () => vi.fn(),
}))
vi.mock('../store.tsx', () => ({ useRun: () => vi.fn(), useRows: () => [], useAssistants: () => [] }))

const { WorkspaceGeneral } = await import('./WorkspaceGeneral.tsx')

test('a member sees why once, at the top of the section, not under every field', () => {
  const html = renderToStaticMarkup(
    <WorkspaceGeneral canEdit={false} name="Brightwater" onRenamed={() => {}} toast={() => {}} />,
  )
  expect(html.split('Only admins can change these settings.').length - 1).toBe(1)
  expect(html).not.toContain('Only admins can change this.')
  expect(html.indexOf('Only admins can change these settings.')).toBeLessThan(html.indexOf('id="ws-name"'))
})

test('owners and admins see no read-only note', () => {
  const html = renderToStaticMarkup(
    <WorkspaceGeneral canEdit name="Brightwater" onRenamed={() => {}} toast={() => {}} />,
  )
  expect(html).not.toContain('Only admins can change')
})

test('during support access the section note says so instead', () => {
  const html = renderToStaticMarkup(
    <SupportAccessContext.Provider value={true}>
      <WorkspaceGeneral canEdit={false} name="Brightwater" onRenamed={() => {}} toast={() => {}} />
    </SupportAccessContext.Provider>,
  )
  expect(html.split('Read-only while you are signed in as another user.').length - 1).toBe(1)
})
