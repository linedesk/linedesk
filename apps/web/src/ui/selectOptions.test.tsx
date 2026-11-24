import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { SelectOptionBody } from './controls.tsx'

const long = { value: 'forward', label: 'Your number forwards calls you miss to Maya, your answering agent' }
const short = { value: 'direct', label: 'This number directly' }

const css = readFileSync(fileURLToPath(new URL('./controls.css', import.meta.url)), 'utf8')
/** The body of the first rule with exactly this selector. */
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

test('a long option shows its whole label, in a label that wraps instead of ending in an ellipsis', () => {
  const out = renderToStaticMarkup(<SelectOptionBody option={long} selected />)
  expect(out).toContain(`<span class="k-select-opt-l">${long.label}</span>`)
  expect(out).not.toMatch(/ellipsis|truncate/)
  const label = rule('.k-select-opt-t > .k-select-opt-l')
  expect(label).toMatch(/white-space:\s*normal/)
  expect(label).toMatch(/overflow:\s*visible/)
  expect(label).not.toMatch(/text-overflow:\s*ellipsis/)
  expect(label).not.toMatch(/max-width:\s*calc/)
  // The list measures its width with every label on one line, so it is as wide as the longest one.
  expect(rule('.k-select-list[data-measuring] .k-select-opt-l')).toMatch(/white-space:\s*nowrap/)
})

test('every option has the check mark column, with the mark only on the picked one', () => {
  const picked = renderToStaticMarkup(<SelectOptionBody option={long} selected />)
  const other = renderToStaticMarkup(<SelectOptionBody option={short} selected={false} />)
  for (const out of [picked, other]) expect(out).toContain('<span class="k-select-opt-check" aria-hidden="true">')
  expect(picked).toMatch(/k-select-opt-check[^>]*><svg/)
  expect(other).toContain('<span class="k-select-opt-check" aria-hidden="true"></span>')
  // The column keeps its width whether or not the mark is in it.
  expect(rule('.k-select-opt-check')).toMatch(/flex:\s*none[\s\S]*width:\s*14px/)
})

test('a description still shows under the label', () => {
  const out = renderToStaticMarkup(
    <SelectOptionBody option={{ ...short, description: 'Customers dial it' }} selected={false} />,
  )
  expect(out).toContain('<small>Customers dial it</small>')
})
