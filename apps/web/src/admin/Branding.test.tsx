import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { SupportCard } from './Branding.tsx'

const noop = () => {}

describe('Support Linedesk on Admin › Branding', () => {
  const html = renderToStaticMarkup(<SupportCard starPrompt poweredBy={false} onStarPrompt={noop} onPoweredBy={noop} />)

  test('its own section with a heart, a short muted line and both switches', () => {
    expect(html).toContain('Support Linedesk')
    expect(html).toContain('adm-brand-heart')
    expect(html).toContain('Optional. Both help other businesses find Linedesk.')
    expect(html).toContain('Ask members for a GitHub star')
    expect(html).toContain('Show “Powered by Linedesk”')
    expect(html.match(/role="switch"/g)?.length).toBe(2)
  })

  test('the longer explanations stay behind a (?), not on the page', () => {
    expect(html.match(/aria-label="More information"/g)?.length).toBe(2)
    expect(html).not.toContain('two minutes into each session')
    expect(html).not.toContain('bottom of emails')
  })
})
