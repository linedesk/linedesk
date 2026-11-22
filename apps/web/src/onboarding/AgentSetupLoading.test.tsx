import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { AgentSetup } from './AgentSetup.tsx'

// The setup page before its first read of the setup state (docs/design-principles.md rule 15): every part that will
// be shown is a skeleton of its shape, the page says it is busy once, and no "Loading…" text or empty card.
const page = () => renderToStaticMarkup(<AgentSetup onManual={() => {}} onDone={() => {}} />)

test('the setup page while its state loads: busy once, skeletons for the title and the link button, no checklist', () => {
  const html = page()
  expect(html).toMatch(/role="main"[^>]*aria-busy="true"/)
  expect(html.match(/role="status"/g)).toHaveLength(1)
  expect(html).toContain('Loading the setup')
  expect(html).not.toMatch(/Loading…|Loading\.\.\./)
  // The checklist shows only once the agent is connected (or all is set up), so it is no part of the first view.
  expect(html).not.toContain('aria-label="Setup progress"')
  // Nothing that depends on the state is shown as if it were known.
  expect(html).not.toContain('Create a setup link')
  expect(html).not.toContain('Set up by hand instead')
  expect(html).not.toContain('<h1')
  // The words that need no data show at once.
  expect(html).toContain('Give your agent a setup link')
})
