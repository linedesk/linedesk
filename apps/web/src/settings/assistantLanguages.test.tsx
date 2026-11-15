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
const installed = [...FLUX, 'zh', 'ko', 'pl']
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
  expect(render({ main: 'en', mode: 'allowed', allowed: ['ko'] }, FLUX)).not.toContain(NOTE)
})
