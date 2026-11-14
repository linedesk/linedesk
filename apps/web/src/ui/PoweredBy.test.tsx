import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { PoweredBy } from './kit.tsx'

const LINK = 'https://linedesk.ai/?utm_source=powered-by&amp;utm_medium=sign-in'

describe('Powered by Linedesk under the sign-in page', () => {
  test('not shown while the install looks like Linedesk', () => {
    expect(renderToStaticMarkup(<PoweredBy brand={{ name: 'Linedesk', logoUrl: null, poweredBy: true }} />)).toBe('')
  })

  test("shown with the install's own name or logo, linking to linedesk.ai without the install in the link", () => {
    for (const brand of [
      { name: 'Front Desk Pro', logoUrl: null, poweredBy: true },
      { name: 'Linedesk', logoUrl: '/v1/branding/logo.png?v=ab12', poweredBy: true },
    ]) {
      const html = renderToStaticMarkup(<PoweredBy brand={brand} />)
      expect(html).toContain(`href="${LINK}"`)
      expect(html).toContain('rel="noopener noreferrer"')
      expect(html).toContain('Powered by <b>Linedesk</b>')
      expect(html).not.toContain('Front Desk')
    }
  })

  test('hidden when the admin switched it off', () => {
    expect(
      renderToStaticMarkup(<PoweredBy brand={{ name: 'Front Desk Pro', logoUrl: '/logo.png', poweredBy: false }} />),
    ).toBe('')
  })
})
