// Server admin › Partners: "Waiting for approval" (`#admin/partners/waiting`, the link in the new-partner email) with
// the number of partners still to approve.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { PartnerTabs } from './Partners.tsx'

const link = (html: string, href: string) => html.match(new RegExp(`<a[^>]*href="${href}"[^>]*>.*?</a>`))?.[0] ?? ''

test('All and Waiting for approval, each its own address; the number only while partners wait', () => {
  const html = renderToStaticMarkup(<PartnerTabs waiting={false} count={2} />)
  expect(link(html, '#admin/partners')).toContain('aria-current="page"')
  expect(link(html, '#admin/partners/waiting')).toContain('Waiting for approval<span class="n">2</span>')
  const none = renderToStaticMarkup(<PartnerTabs waiting count={0} />)
  expect(link(none, '#admin/partners/waiting')).toContain('aria-current="page"')
  expect(none).not.toContain('class="n"')
})
