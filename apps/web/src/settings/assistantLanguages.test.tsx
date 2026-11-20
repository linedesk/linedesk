// Settings › Assistant › Languages: one question for callers in another language (stay, switch to theirs, switch only
// to picked ones), only languages a connected voice speaks, and "Switch to the caller's language" names the languages it
// switches to: with a Flux model only Flux's 10, not the whole pick list (coordinator decision on LIN-268; LIN-624).
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

vi.mock('../cachedQuery.ts', () => ({
  useQuery: () => ({ data: undefined, error: null, reload: () => {} }),
  refreshQuery: () => {},
}))
vi.mock('./settings-api.ts', () => ({ readAction: vi.fn(), useWriteAction: () => vi.fn() }))

const { Languages } = await import('./AssistantSettings.tsx')
const { addableLanguages, anyModeOthers, offeredLanguages, withLanguage, withoutLanguage } = await import(
  './assistantDraft.ts'
)

const FLUX = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'hi', 'ja']
const installed = [...FLUX, 'pl', 'sv', 'tr']
const NOTE = 'For any other language, choose'

function render(
  languages: { main: 'en'; mode: 'any' | 'allowed' | 'english'; allowed: string[] },
  anyCovers?: string[],
) {
  const draft = { name: 'Maya', languages } as never
  return renderToStaticMarkup(
    <Languages draft={draft} set={() => {}} onMainLanguage={() => {}} installed={installed} anyCovers={anyCovers} />,
  )
}

const checked = (html: string) => (html.match(/checked=""/g) ?? []).length
/** The radio card that is picked: its title. */
const pickedMode = (html: string) => html.match(/k-radio on"[^>]*>.*?<b>([^<]*)<\/b>/)?.[1]

test("one question with three answers, worded from the owner's view; one of them picked", () => {
  const html = render({ main: 'en', mode: 'any', allowed: [] }, installed)
  expect(html).toContain('When a caller speaks another language')
  expect(html).toContain('Stay in English')
  expect(html).toContain('Switch to the caller’s language')
  expect(html).toContain('Switch only to languages I pick')
  expect(checked(html)).toBe(1)
  expect(pickedMode(html)).toBe('Switch to the caller’s language')
  expect(pickedMode(render({ main: 'en', mode: 'english', allowed: [] }))).toBe('Stay in English')
})

/** The read-only list under "Switch to the caller's language": each language as listed there. */
const covered = (html: string) =>
  [
    ...(
      html.match(/<ul class="as-languages-picked" aria-label="Languages it switches to">(.*?)<\/ul>/)?.[1] ?? ''
    ).matchAll(/<li class="as-languages-chip">([^<]*)<\/li>/g),
  ].map(m => m[1])

test('"any" with a Flux model names its 9 other languages, lists them read-only once picked, and how to get others', () => {
  const html = render({ main: 'en', mode: 'any', allowed: [] }, FLUX)
  expect(html).toContain('<b>Switch to the caller’s language</b><span>9 languages</span>')
  expect(covered(html)).toEqual([
    'Español · Spanish',
    'Français · French',
    'Deutsch · German',
    'Italiano · Italian',
    'Português · Portuguese',
    'Nederlands · Dutch',
    'Русский · Russian',
    'हिन्दी · Hindi',
    '日本語 · Japanese',
  ])
  expect(html).not.toContain('Polski')
  expect(html).toContain(NOTE)
  // Read-only: nothing to remove or add; that is only for "Switch only to languages I pick".
  expect(html).not.toContain('Add language')
  expect(html).not.toContain('as-languages-chip-x')
})

test('not picked, "any" names the count and the first languages, so it does not read as the whole pick list', () => {
  for (const mode of ['english', 'allowed'] as const) {
    const html = render({ main: 'en', mode, allowed: ['pl'] }, FLUX)
    expect(html).toContain('<span>9 languages: Spanish, French, German, and 6 more</span>')
    expect(covered(html)).toEqual([])
    expect(html).not.toContain(NOTE)
  }
  // Few enough: all of them by name. Unknown (an older API): every language offered.
  expect(render({ main: 'en', mode: 'english', allowed: [] }, ['en', 'es', 'fr'])).toContain(
    '<span>2 languages: Spanish and French</span>',
  )
  expect(render({ main: 'en', mode: 'english', allowed: [] })).toContain(
    '12 languages: Spanish, French, German, and 9 more',
  )
})

test('"any" that covers every offered language lists them all, without the note', () => {
  const html = render({ main: 'en', mode: 'any', allowed: [] }, installed)
  expect(html).toContain('<span>12 languages</span>')
  expect(covered(html)).toHaveLength(12)
  expect(html).not.toContain(NOTE)
})

test('what "any" switches to: what it covers, in the pickers\' order, never the main language', () => {
  const offered = installed as never
  expect(anyModeOthers(FLUX, offered, 'de')).toEqual(['en', 'es', 'fr', 'it', 'pt', 'nl', 'ru', 'hi', 'ja'])
  // A main language outside what it covers: still only the covered ones.
  expect(anyModeOthers(FLUX, offered, 'pl')).toEqual(FLUX)
  expect(anyModeOthers(undefined, ['en', 'pl', 'sv'], 'en')).toEqual(['pl', 'sv'])
})

test('"Switch only to languages I pick": the picked ones as removable chips, then Add language', () => {
  const html = render({ main: 'en', mode: 'allowed', allowed: ['pl', 'sv'] })
  expect(pickedMode(html)).toBe('Switch only to languages I pick')
  expect(html.match(/class="as-languages-chip"/g)).toHaveLength(2)
  expect(html).toMatch(/Polski[^<]*<button[^>]*aria-label="Remove Polski/)
  expect(html).toMatch(/Svenska[^<]*<button[^>]*aria-label="Remove Svenska/)
  expect(html).toContain('Add language')
  expect(html).not.toContain('role="alert"')
})

test('"Switch only to languages I pick" with none picked: Add language and the reason Save is refused', () => {
  const html = render({ main: 'en', mode: 'allowed', allowed: [] })
  expect(html).not.toContain('as-languages-chip"')
  expect(html).toContain('Add language')
  expect(html).toMatch(/role="alert">Add at least one language, or choose “Stay in English”/)
})

test('"Stay in …" shows no languages to pick', () => {
  const html = render({ main: 'en', mode: 'english', allowed: ['pl'] })
  expect(html).not.toContain('Add language')
  expect(html).not.toContain('Polski')
})

test('Add language offers what a connected voice speaks, never the main language or one already picked', () => {
  const draft = { languages: { main: 'en' as const, mode: 'allowed' as const, allowed: ['pl' as const] } }
  const offered = offeredLanguages(installed, draft)
  const addable = addableLanguages(offered, 'en', ['pl'])
  expect([...addable].sort()).toEqual(installed.filter(code => code !== 'en' && code !== 'pl').sort())
  expect(addable).not.toContain('hu')
  // Added in the order the pickers list them, removed without touching the others.
  expect(withLanguage(offered, 'en', ['pl', 'tr'], 'es')).toEqual(['es', 'pl', 'tr'])
  expect(withLanguage(offered, 'en', ['pl'], 'en')).toEqual(['pl'])
  expect(withoutLanguage(['es', 'pl', 'tr'], 'pl')).toEqual(['es', 'tr'])
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
