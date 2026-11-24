// Settings › Assistant › AI disclosure: every mode can be picked in every country (the owner decides); a mode that may
// break the law where the workspace is gets a hint, "not even when asked" a warning (legal review 2026-11-17, A2).
import { AI_DISCLOSURE_MODES } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

const settings = vi.hoisted(() => ({ data: { resolvedCountry: 'US' } as Record<string, unknown> }))
vi.mock('../cachedQuery.ts', () => ({
  useQuery: () => ({ data: undefined, error: null, reload: () => {} }),
  refreshQuery: () => {},
}))
vi.mock('./settings-api.ts', () => ({
  readAction: vi.fn(),
  useWriteAction: () => vi.fn(),
  useWorkspaceSettings: () => ({ data: settings.data, error: null, reload: async () => {} }),
}))

const { AiDisclosureRow } = await import('./AssistantSettings.tsx')

const render = (ai_disclosure: string, country: string) => {
  settings.data = { resolvedCountry: country }
  const draft = { name: 'Maya', greeting: 'Thanks for calling Brightwater. How can I help?', ai_disclosure } as never
  return renderToStaticMarkup(<AiDisclosureRow draft={draft} set={() => {}} />).replaceAll('&#x27;', "'")
}

const LAW_EU = 'In the EU, callers must be told that they are talking to an AI (EU AI Act, Art. 50)'
const LAW_US = 'Some US states, such as Maine, require telling callers'
const WARNING = "Maya won't say it is an AI, even when a caller asks."

test('every mode can be picked and shows as stored, also in the EU', () => {
  expect(AI_DISCLOSURE_MODES).toHaveLength(5)
  expect(render('never_confirm', 'DE')).toContain('<span>Never, not even when asked</span>')
  expect(render('never', 'GB')).toContain("<span>Don't mention</span>")
})

test('"don\'t mention" and "only when asked": a quiet hint by country', () => {
  for (const mode of ['never', 'when_asked']) {
    expect(render(mode, 'DE')).toContain(LAW_EU)
    expect(render(mode, 'GB')).toContain(LAW_EU)
    expect(render(mode, 'US')).toContain(LAW_US)
    expect(render(mode, 'US')).not.toContain('k-note-warning')
  }
})

test('"never, not even when asked": the warning, by country', () => {
  const eu = render('never_confirm', 'FR')
  expect(eu).toContain('k-note-warning')
  expect(eu).toContain(`${WARNING} In the EU this goes against the law`)
  const us = render('never_confirm', 'US')
  expect(us).toContain(`${WARNING} Some US states, such as Utah and Maine, require saying it.`)
})

test('saying it at the start: no hint, no warning', () => {
  for (const mode of ['at_start', 'at_start_consent'])
    for (const country of ['DE', 'US']) {
      const html = render(mode, country)
      for (const text of [LAW_EU, LAW_US, WARNING, 'k-note-warning']) expect(html).not.toContain(text)
    }
})
