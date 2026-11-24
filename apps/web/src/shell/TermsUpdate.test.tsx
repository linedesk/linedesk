// A new terms version, asked once in the app of a bill's owner (TermsUpdate.tsx, LIN-420): the links to both texts;
// nothing without terms to accept, and nothing for a version postponed in this tab or session. (The dialog itself
// needs a page to render: its parts are checked here.)
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { laterChosenFor, termsToAsk, TermsUpdateText } from './TermsUpdate.tsx'

const terms = {
  termsUrl: 'https://desk.example.com/terms',
  termsVersion: '2026-11-18',
  privacyUrl: 'https://desk.example.com/privacy',
  privacyVersion: '2026-11-10',
}

afterEach(() => vi.unstubAllGlobals())

test('what it says: Accept agrees to the terms and acknowledges the privacy policy, both linked', () => {
  const html = renderToStaticMarkup(<TermsUpdateText terms={terms} />)
  expect(html).toContain('href="https://desk.example.com/terms"')
  expect(html).toContain('href="https://desk.example.com/privacy"')
  expect(html).toContain('By clicking Accept, you agree to them')
  expect(html).toContain('Privacy Policy')
})

test('asked while there are terms to accept, not after Later in this tab for this version', () => {
  expect(termsToAsk(terms, null)).toEqual(terms)
  expect(termsToAsk(null, null)).toBeNull()
  expect(termsToAsk(terms, '2026-11-18')).toBeNull()
  // Later for an older version does not hide a newer one.
  expect(termsToAsk(terms, '2026-11-17')).toEqual(terms)
})

test('Later counts for this session and this version only; without storage it asks again', () => {
  const stored = new Map<string, string>([['linedesk.termsUpdate.later', '2026-11-18']])
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => stored.get(k) ?? null })
  expect(laterChosenFor('2026-11-18')).toBe(true)
  expect(laterChosenFor('2026-12-01')).toBe(false)
  expect(termsToAsk(terms, null)).toBeNull()
  expect(termsToAsk({ ...terms, termsVersion: '2026-12-01' }, null)).not.toBeNull()
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw new Error('blocked')
    },
  })
  expect(laterChosenFor('2026-11-18')).toBe(false)
})
