// The one settings head (UI cleanup S1/S2): a context line above the nav at one size and place, actions at its right,
// and the phone's tab row faded at an edge with more tabs behind it.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { fadeOf, SettingsLayout } from './SettingsLayout.tsx'

const sections = [
  { id: 'general', label: 'General' },
  { id: 'team', label: 'Team' },
] as const

const render = (props: { context?: string; actions?: string }) =>
  renderToStaticMarkup(
    <SettingsLayout
      page="workspace"
      title="Workspace settings"
      context={props.context && <span className="sl-context-text">{props.context}</span>}
      actions={props.actions && <button type="button">{props.actions}</button>}
      sections={sections}
      current="general"
    >
      <p>body</p>
    </SettingsLayout>,
  )

test('the context line holds the page context and its actions, above the nav', () => {
  const html = render({ context: 'Brightwater Plumbing & Heating', actions: 'Start test call' })
  const line = html.slice(html.indexOf('class="sl-context"'), html.indexOf('<nav'))
  expect(line).toContain('Brightwater Plumbing &amp; Heating')
  expect(line).toContain('class="sl-actions"')
  expect(line).toContain('Start test call')
})

test('no context and no actions: no empty line (Server admin, Partner area)', () => {
  expect(render({})).not.toContain('sl-context')
})

test('the tab row fades only at an edge with more tabs behind it', () => {
  expect(fadeOf({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })).toBeUndefined()
  expect(fadeOf({ scrollWidth: 600, clientWidth: 300, scrollLeft: 0 })).toBe('end')
  expect(fadeOf({ scrollWidth: 600, clientWidth: 300, scrollLeft: 150 })).toBe('both')
  expect(fadeOf({ scrollWidth: 600, clientWidth: 300, scrollLeft: 300 })).toBe('start')
})
