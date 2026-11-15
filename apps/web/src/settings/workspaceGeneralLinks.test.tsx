// Workspace settings › General: the call language's help names where the app's own language is set, and that name
// is the shared in-app link (ui/AppLink.tsx) to Account › Preferences, for admins and read-only members alike.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

vi.mock('./settings-api.ts', () => ({
  useWorkspaceSettings: () => ({ data: null, error: null, reload: async () => {} }),
  patchWorkspaceSettings: vi.fn(),
  refreshWorkspaceSettings: vi.fn(),
  callAction: vi.fn(),
}))
vi.mock('../store.tsx', () => ({ useRun: () => vi.fn(), useRows: () => [] }))
vi.mock('../shell/WorkspaceSwitcher.tsx', () => ({ useWorkspaces: () => [] }))

const { WorkspaceGeneral } = await import('./WorkspaceGeneral.tsx')

const render = (canEdit: boolean) =>
  renderToStaticMarkup(
    <WorkspaceGeneral canEdit={canEdit} name="Brightwater Plumbing & Heating" onRenamed={() => {}} toast={() => {}} />,
  )

const PREFERENCES_LINK = '<a class="k-link" href="#account/preferences">Account › Preferences</a>'

test('the call language help links to Account › Preferences', () => {
  expect(render(true)).toContain(`change that under ${PREFERENCES_LINK}.`)
})

test('a member who only reads the settings gets the same link', () => {
  const html = render(false)
  expect(html).toContain(`change that under ${PREFERENCES_LINK}. Only admins can change this.`)
})
