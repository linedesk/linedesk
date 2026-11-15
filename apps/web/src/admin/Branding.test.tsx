import { enMessages, PSEUDO_LOCALE } from '@linedesk/i18n'
import { pseudoMessages } from '@linedesk/i18n/pseudo'
import { createI18n, I18nProvider } from '@linedesk/i18n/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { SupportCard } from './Branding.tsx'

const noop = () => {}

describe('Support Linedesk on Server admin › Branding', () => {
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

describe('Support Linedesk in another language', () => {
  test('every text comes from the catalog (the pseudo-locale marks each one)', () => {
    const value = createI18n(PSEUDO_LOCALE, pseudoMessages(enMessages))
    const html = renderToStaticMarkup(
      <I18nProvider value={value}>
        <SupportCard starPrompt poweredBy onStarPrompt={noop} onPoweredBy={noop} />
      </I18nProvider>,
    )
    expect(html).not.toContain('Ask members for a GitHub star')
    expect(html).not.toContain('Optional. Both help')
    expect(html.match(/⟦/g)?.length).toBeGreaterThanOrEqual(4)
  })
})
