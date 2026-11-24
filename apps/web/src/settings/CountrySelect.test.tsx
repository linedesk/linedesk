// The country field where Linedesk Cloud serves only some countries (CountrySelect `served`): those countries, no
// search field for so few, and one quiet line at the end of the list that more come soon. Every country elsewhere.
import { readFileSync } from 'node:fs'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import type { SearchSelect as Real } from '../ui/SearchSelect.tsx'

// What the field hands its dropdown, written out (the open list needs a browser).
vi.mock('../ui/SearchSelect.tsx', () => ({
  SearchSelect: (p: ComponentProps<typeof Real>) => (
    <div data-searchable={String(p.searchable ?? true)}>
      {p.options.map(o => (
        <span key={o.value} data-value={o.value} />
      ))}
      {p.note && <p className="note">{p.note}</p>}
    </div>
  ),
  searchOptions: (options: unknown[]) => options,
}))
const { CountrySelect } = await import('./CountrySelect.tsx')

const values = (html: string) => [...html.matchAll(/data-value="([^"]*)"/g)].map(m => m[1])

test('served: only those countries, no search field, and the hint row at the end', () => {
  const html = renderToStaticMarkup(<CountrySelect id="c" value="US" onChange={() => {}} served={['US', 'CA', 'PR']} />)
  expect(values(html)).toEqual(['US', 'CA', 'PR'])
  expect(html).toContain('data-searchable="false"')
  expect(html).toContain('<p class="note">More countries coming soon.</p>')
})

test('not served anywhere in particular: every country with the search, no hint row', () => {
  const html = renderToStaticMarkup(<CountrySelect id="c" value="DE" onChange={() => {}} />)
  expect(values(html).length).toBeGreaterThan(200)
  expect(html).toContain('data-searchable="true"')
  expect(html).not.toContain('More countries')
})

test('the hint row is quiet: muted, small, a line above it, not an option and not clickable', () => {
  const source = readFileSync(new URL('../ui/SearchSelect.tsx', import.meta.url), 'utf8')
  // Outside the listbox: screen readers never count it as an option.
  expect(source).toMatch(/<\/div>\s*\{note && <p className="k-ssel-note">\{note\}<\/p>\}/)
  const css = readFileSync(new URL('../ui/search-select.css', import.meta.url), 'utf8')
  const rule = /\.k-ssel-note \{([^}]*)\}/.exec(css)?.[1] ?? ''
  expect(rule).toContain('color: var(--ink-muted)')
  expect(rule).toContain('border-top: 1px solid var(--line)')
  expect(rule).toContain('cursor: default')
})
