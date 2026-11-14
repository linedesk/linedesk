import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { ColumnHeads } from './list.tsx'

test('column headings: one muted cell per label, in order, hidden from screen readers', () => {
  const html = renderToStaticMarkup(createElement(ColumnHeads, { labels: ['Name', 'Company', 'Calls'] }))
  expect(html).toBe(
    '<div class="ib-cols" role="presentation">' +
      '<span aria-hidden="true">Name</span>' +
      '<span aria-hidden="true">Company</span>' +
      '<span aria-hidden="true">Calls</span>' +
      '</div>',
  )
})

test('column headings: the list’s own class, and the lead (a select-all box) before the labels', () => {
  const lead = createElement('span', { className: 'ib-cols-check' }, 'box')
  const html = renderToStaticMarkup(createElement(ColumnHeads, { labels: ['Time'], lead, className: 'ct-cols' }))
  expect(html).toBe(
    '<div class="ib-cols ct-cols" role="presentation">' +
      '<span class="ib-cols-check">box</span>' +
      '<span aria-hidden="true">Time</span>' +
      '</div>',
  )
})
