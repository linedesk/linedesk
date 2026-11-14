import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { InboxTab } from '../inbox-model.ts'
import { InboxEmpty, type InboxEmptyProps } from './InboxEmpty.tsx'
import { listFrame } from './listFrame.ts'

const base: InboxEmptyProps = { tab: 'you', search: null, assistant: 'Maya', handledCount: 0, hasAnyCalls: true }
const render = (props: Partial<InboxEmptyProps>) => renderToStaticMarkup(<InboxEmpty {...base} {...props} />)
const views: InboxTab[] = ['you', 'ai', 'spam', 'reminders', 'done', 'mine', 'member', 'unassigned']

describe('InboxEmpty', () => {
  test('every view uses the same empty state: picture, title, at most one line', () => {
    for (const tab of views) {
      const html = render({ tab })
      expect(html).toMatch(/^<div class="zero" role="status"><svg class="zero-art"/)
      expect(html).toContain('<h2>')
      expect(html.match(/<p /g)?.length ?? 0).toBeLessThanOrEqual(1)
    }
  })

  test('the words are the view’s own', () => {
    expect(render({ tab: 'you' })).toContain('<h2>Nothing needs you right now</h2>')
    expect(render({ tab: 'ai' })).toContain('<h2>Nothing handled by Maya right now</h2>')
    expect(render({ tab: 'ai' })).toContain('Calls Maya resolves on its own show up here.')
    expect(render({ tab: 'spam' })).toContain('<h2>No spam right now</h2>')
    expect(render({ tab: 'done' })).toContain('<h2>Nothing done yet</h2>')
    expect(render({ tab: 'reminders' })).toContain('<h2>No reminders</h2>')
  })

  test('Needs you points to what the assistant resolved', () => {
    expect(render({ tab: 'you', handledCount: 2 })).toContain('Maya resolved <b>2</b> calls on its own. Press')
    expect(render({ tab: 'you', handledCount: 1 })).toContain('<b>1</b> call on its own')
    expect(render({ tab: 'you', handledCount: 0 })).not.toContain('zero-greet')
  })

  test('no call at all: every view says so; the line goes when the first-call line already explains it', () => {
    for (const tab of views) {
      expect(render({ tab, hasAnyCalls: false })).toContain('<h2>No calls yet</h2>')
      expect(render({ tab, hasAnyCalls: false })).toContain('Calls Maya answers show up here.')
      expect(render({ tab, hasAnyCalls: false, quiet: true })).not.toContain('zero-greet')
    }
  })

  test('search with no hit says what was searched, in the same component', () => {
    expect(render({ tab: 'ai', search: 'faucet' })).toContain('<h2>No call mentions “faucet”</h2>')
  })
})

describe('listFrame', () => {
  const hint = 'When someone calls, Maya answers.'

  test('the first-call line and the column headings do not depend on the view', () => {
    // listFrame takes no view at all: what it decides is the same for Needs you, Handled and Spam.
    for (const count of [0, 3]) {
      const frame = listFrame({ search: null, loadState: 'ready', count, firstCallHint: hint, selectable: true })
      expect(frame).toEqual({ firstCallLine: true, columnHeads: true, empty: count === 0 })
    }
  })

  test('an empty view keeps its column headings', () => {
    const frame = listFrame({ search: null, loadState: 'ready', count: 0, firstCallHint: null, selectable: true })
    expect(frame.columnHeads).toBe(true)
    expect(frame.empty).toBe(true)
  })

  test('before the first sync: no empty state and no first-call line; headings only over calls already there', () => {
    const loading = listFrame({ search: null, loadState: 'loading', count: 0, firstCallHint: hint, selectable: true })
    expect(loading).toEqual({ firstCallLine: false, columnHeads: false, empty: false })
    expect(
      listFrame({ search: null, loadState: 'loading', count: 2, firstCallHint: hint, selectable: true }).columnHeads,
    ).toBe(true)
  })

  test('search hides the first-call line; once a real call came in it is gone everywhere', () => {
    expect(
      listFrame({ search: 'x', loadState: 'ready', count: 0, firstCallHint: hint, selectable: true }).firstCallLine,
    ).toBe(false)
    expect(
      listFrame({ search: null, loadState: 'ready', count: 0, firstCallHint: null, selectable: true }).firstCallLine,
    ).toBe(false)
  })

  test('no headings where rows cannot be selected', () => {
    expect(
      listFrame({ search: null, loadState: 'ready', count: 3, firstCallHint: null, selectable: false }).columnHeads,
    ).toBe(false)
  })
})
