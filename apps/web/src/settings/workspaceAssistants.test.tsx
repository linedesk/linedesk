// Workspace settings › Assistants: every assistant, each a link into its own settings, with the numbers it answers;
// New assistant only for owners and admins; one line when there is none.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'

const data = vi.hoisted(() => ({
  assistants: [] as { id: string; name: string; created_at: string }[],
  numbers: [] as { id: string; e164: string; assistant_id: string | null; created_at: string }[],
}))

vi.mock('../store.tsx', () => ({
  useRun: () => vi.fn(),
  useAssistants: () => data.assistants,
  useRows: () => data.numbers,
}))
vi.mock('../ui/LoadStates.tsx', () => ({
  useLoadState: () => 'ready',
  Loading: ({ children }: { children: unknown }) => children,
  SkeletonList: () => null,
}))

const { WorkspaceAssistants, assistantRows } = await import('./WorkspaceAssistants.tsx')

const front = { id: 'as_front', name: 'Front desk', created_at: '2026-01-01T00:00:00Z' }
const after = { id: 'as_after', name: 'After hours', created_at: '2026-02-01T00:00:00Z' }
const main = { id: 'pn_main', e164: '+14155550100', assistant_id: null, created_at: '2026-01-01T00:00:00Z' }
const night = { id: 'pn_night', e164: '+14155550199', assistant_id: 'as_after', created_at: '2026-02-01T00:00:00Z' }

const render = (canEdit: boolean) => renderToStaticMarkup(<WorkspaceAssistants canEdit={canEdit} toast={() => {}} />)

beforeEach(() => {
  data.assistants = []
  data.numbers = []
})

test('each assistant links to its own settings, with the numbers it answers', () => {
  expect(assistantRows([front, after], [night, main])).toEqual([
    { id: 'as_front', name: 'Front desk', href: '#assistant/as_front/general', numbers: ['+1 415 555 0100'] },
    { id: 'as_after', name: 'After hours', href: '#assistant/as_after/general', numbers: ['+1 415 555 0199'] },
  ])
  // A number that names no assistant is the default's (the first) only.
  expect(assistantRows([after, front], [main])[1]!.numbers).toEqual([])
})

test('lists every assistant as a link into its settings', () => {
  data.assistants = [front, after]
  data.numbers = [main]
  const html = render(false)
  expect(html).toContain('<a class="k-row-line wa-row" href="#assistant/as_front/general"')
  expect(html).toContain('<a class="k-row-line wa-row" href="#assistant/as_after/general"')
  expect(html.indexOf('Front desk')).toBeLessThan(html.indexOf('After hours'))
  expect(html).toContain('+1 415 555 0100')
  expect(html).toContain('Answers no number yet')
  expect(html).not.toContain('No assistant yet.')
})

test('New assistant for owners and admins only', () => {
  data.assistants = [front]
  expect(render(true)).toContain('New assistant')
  expect(render(false)).not.toContain('New assistant')
})

test('one short line when there is no assistant', () => {
  const html = render(true)
  expect(html).toContain('No assistant yet.')
  expect(html).not.toContain('wa-row')
})
