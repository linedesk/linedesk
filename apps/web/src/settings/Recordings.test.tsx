// Settings › Recordings with recording off on the server: the saved choices stay as they are but greyed out, and one
// note says what turns recording on (a link to Server admin › Providers for an instance admin, "ask" for everyone else).
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { setProviderAudience } from '../providerAudience.ts'

const settings = vi.hoisted(() => ({
  data: {
    recordingOn: false,
    recordingRetentionDays: 0,
    recordingNoticeOn: true,
    recordingNotice: 'This call may be recorded.',
  } as Record<string, unknown>,
}))
vi.mock('./settings-api.ts', () => ({
  useWorkspaceSettings: () => ({ data: settings.data, error: null, reload: async () => {} }),
  patchWorkspaceSettings: vi.fn(),
}))
vi.mock('../store.tsx', () => ({ useRun: () => vi.fn() }))

const { Recordings } = await import('./Recordings.tsx')

const render = (recordingOn: boolean, canEdit = true) => {
  settings.data = { ...settings.data, recordingOn }
  return renderToStaticMarkup(<Recordings canEdit={canEdit} toast={() => {}} />)
}
const disabledControls = (html: string) => (html.match(/disabled=""/g) ?? []).length

afterEach(() => setProviderAudience('member'))

test('recording off on the server: a note says so, the saved choices stay but cannot change', () => {
  const html = render(false)
  expect(html).toContain('Recording is off on this server.')
  expect(html).toContain('Ask your server admin to turn on recording.')
  expect(html).not.toContain('#admin/providers/recording')
  // Kept as saved: the switch is still on and the sentence still there, greyed out.
  expect(html).toContain('This call may be recorded.')
  expect(html).toContain('is-dimmed')
  // The retention select, the notice switch and the sentence.
  expect(disabledControls(html)).toBe(3)
})

test('an instance admin gets the link to the place that turns recording on', () => {
  setProviderAudience('admin')
  const html = render(false)
  expect(html).toContain('href="#admin/providers/recording"')
  expect(html).not.toContain('Ask your server admin')
})

test('recording on: no note, the controls work as before', () => {
  const html = render(true)
  expect(html).not.toContain('Recording is off on this server.')
  expect(html).not.toContain('is-dimmed')
  expect(disabledControls(html)).toBe(0)
  // A member still reads them only.
  expect(disabledControls(render(true, false))).toBe(3)
})
