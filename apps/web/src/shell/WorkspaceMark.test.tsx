import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { WorkspaceMark, workspaceIconOf } from './WorkspaceMark.tsx'

describe('WorkspaceMark', () => {
  test('shows the icon when the workspace has one', () => {
    const html = renderToStaticMarkup(
      <WorkspaceMark name="Brightwater Plumbing" iconUrl="/v1/workspace-icons/ws1.png?v=ab12" />,
    )
    expect(html).toContain('<img src="/v1/workspace-icons/ws1.png?v=ab12" alt=""/>')
    expect(html).toContain('has-icon')
    expect(html).not.toContain('>B<')
  })

  test('shows the initial without an icon', () => {
    for (const iconUrl of [null, undefined, '']) {
      const html = renderToStaticMarkup(<WorkspaceMark name="brightwater Plumbing" iconUrl={iconUrl} />)
      expect(html).toBe('<span class="ws-initial" aria-hidden="true">B</span>')
    }
  })

  test('sizes for the switcher rows and the preview in General; the invitation dot stays on top', () => {
    expect(renderToStaticMarkup(<WorkspaceMark name="A" iconUrl={null} size="sm" />)).toContain('ws-initial is-sm')
    expect(renderToStaticMarkup(<WorkspaceMark name="A" iconUrl={null} size="lg" />)).toContain('ws-initial is-lg')
    const withDot = renderToStaticMarkup(
      <WorkspaceMark name="A" iconUrl="/i.png">
        <span className="me-dot" />
      </WorkspaceMark>,
    )
    expect(withDot).toContain('<img src="/i.png" alt=""/><span class="me-dot"></span>')
  })
})

describe('workspaceIconOf', () => {
  const list = [
    { id: 'ws1', name: 'One', iconUrl: '/one.png' },
    { id: 'ws2', name: 'Two', iconUrl: null },
    { id: 'ws3', name: 'Three' },
  ]
  test('the icon of that workspace in the member list, else null', () => {
    expect(workspaceIconOf(list, 'ws1')).toBe('/one.png')
    expect(workspaceIconOf(list, 'ws2')).toBeNull()
    expect(workspaceIconOf(list, 'ws3')).toBeNull() // remembered by an older version: no iconUrl yet
    expect(workspaceIconOf(list, 'ws9')).toBeNull()
    expect(workspaceIconOf(null, 'ws1')).toBeNull()
  })
})
