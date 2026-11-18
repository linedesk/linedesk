// Settings › Assistant › Languages: only languages a connected voice speaks, and with a Flux model "Any supported
// language" covers Flux's 10 and says so (coordinator decision on LIN-268).
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

vi.mock('../cachedQuery.ts', () => ({
  useQuery: () => ({ data: undefined, error: null, reload: () => {} }),
  refreshQuery: () => {},
}))
vi.mock('./settings-api.ts', () => ({ readAction: vi.fn(), useWriteAction: () => vi.fn() }))

const { Languages } = await import('./AssistantSettings.tsx')

const FLUX = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja']
const installed = [...FLUX, 'pl', 'sv', 'tr']
const NOTE = 'Covers the 10 core languages'

function render(languages: { main: 'en'; mode: 'any' | 'allowed'; allowed: string[] }, anyCovers?: string[]) {
  const draft = { name: 'Maya', languages } as never
  return renderToStaticMarkup(
    <Languages draft={draft} set={() => {}} onMainLanguage={() => {}} installed={installed} anyCovers={anyCovers} />,
  )
}

const checked = (html: string) => (html.match(/checked=""/g) ?? []).length

test('"any" with a Flux model ticks only Flux\'s languages and says how to get the others', () => {
  const html = render({ main: 'en', mode: 'any', allowed: [] }, FLUX)
  expect(html).toContain(NOTE)
  expect(checked(html)).toBe(FLUX.length - 1) // all but the main language
})

test('"any" that covers every offered language has no note; the list is what the voice speaks', () => {
  const html = render({ main: 'en', mode: 'any', allowed: [] }, installed)
  expect(html).not.toContain(NOTE)
  expect(checked(html)).toBe(installed.length - 1)
  expect(html).not.toContain('Hungarian')
  expect(render({ main: 'en', mode: 'allowed', allowed: ['pl'] }, FLUX)).not.toContain(NOTE)
})

test('the main language marks the country default, and says so only once it was set by hand (LIN-580)', () => {
  const languages = { main: 'de', mode: 'english', allowed: [] }
  const line = (follows: boolean, onCountryLanguage?: () => void) =>
    renderToStaticMarkup(
      <Languages
        draft={{ name: 'Maya', languages, main_language_follows: follows } as never}
        set={() => {}}
        onMainLanguage={() => {}}
        onCountryLanguage={onCountryLanguage}
        country="Germany"
        countryLanguage="de"
        installed={installed}
      />,
    )
  // Following: no line under the select; the country's language says "(country default)" on the select.
  const following = line(true, () => {})
  expect(following).not.toContain('follows-line')
  expect(following).not.toContain('Changes when the country changes.')
  expect(following).not.toContain('Set by hand')
  expect(following).toMatch(/<span>Deutsch[^<]*\(country default\)<\/span>/)
  // Set by hand: one click back to the country's language, for those who can change it.
  const byHand = line(false, () => {})
  expect(byHand).toMatch(/Set by hand.*<button type="button" class="k-link">Use country default \(Deutsch/)
  expect(byHand).toMatch(/<span>Deutsch[^<]*\(country default\)<\/span>/)
  // A member reads what the country would give instead of a button.
  const readOnly = line(false)
  expect(readOnly).toContain('Country default: Deutsch')
  expect(readOnly).not.toContain('<button type="button" class="k-link">')
})
