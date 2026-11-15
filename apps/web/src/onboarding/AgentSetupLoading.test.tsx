import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { AgentSetup, ProgressSkeleton, stepSkeletonRow } from './AgentSetup.tsx'

// The setup page before its first read of the setup state (docs/design-principles.md rule 15): every part that will
// be shown is a skeleton of its shape, the page says it is busy once, and no "Loading…" text or empty card.
const page = () => renderToStaticMarkup(<AgentSetup onManual={() => {}} onDone={() => {}} />)

test('the setup page while its state loads: busy once, skeletons for the title, the link button and the checklist', () => {
  const html = page()
  expect(html).toMatch(/role="main"[^>]*aria-busy="true"/)
  expect(html.match(/role="status"/g)).toHaveLength(1)
  expect(html).toContain('Loading the setup')
  expect(html).not.toMatch(/Loading…|Loading\.\.\./)
  // The checklist card is there with all its rows, not empty space that the steps pop into.
  expect(html).toContain('aria-label="Setup progress"')
  expect(html.match(/class="sk-check as-item"/g)).toHaveLength(12)
  // Nothing that depends on the state is shown as if it were known.
  expect(html).not.toContain('Create a setup link')
  expect(html).not.toContain('Set up by hand instead')
  expect(html).not.toContain('<h1')
  // The words that need no data show at once.
  expect(html).toContain('Give your agent a setup link')
  expect(html).toContain('This server')
})

test('the checklist skeleton has the shape of the steps: groups, workspace dropdown, a mark per row, buttons where they come', () => {
  const html = renderToStaticMarkup(<ProgressSkeleton reserved={false} />)
  expect(html).toContain('as-group as-group-ws')
  expect(html).toMatch(/as-ws-head.*Workspace.*class="sk sk-block"[^>]*height:28px/)
  expect(html.match(/sk-round/g)).toHaveLength(12)
  expect(html.match(/sk-check-action/g)).toHaveLength(2)
})

test('a step row is about as wide as its name and hint, wider for a longer one', () => {
  expect(stepSkeletonRow('email').label).toBeLessThan(stepSkeletonRow('answering').label)
  expect(stepSkeletonRow('test_call')).toMatchObject({ action: expect.any(Number) })
  expect(stepSkeletonRow('unknown-step').label).toBeGreaterThan(0)
})
