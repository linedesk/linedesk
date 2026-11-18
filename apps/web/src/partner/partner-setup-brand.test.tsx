// A white-label partner's own screens always show the install's brand (Linedesk), never the partner's white-label one
// (decision, Janik, 2026-11-18): the guided setup (#partner/setup), the agent setup (#partner/agent), the partner area
// and its team invitation, even when the tab's open workspace is one of the partner's clients and so carries its brand
// (brand.ts). The white-label brand stays on the client screens.
import { DEFAULT_BRANDING, type MyPartner } from '@linedesk/actions'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, expect, test } from 'vitest'
// Loaded before the address below exists: it would follow the page's focus and visibility, which markup has not.
import '../cachedQuery.ts'

const PARTNER_LOGO = '/v1/branding/partners/ptn_1/logo.png?v=1'
const partner = { id: 'ptn_1', name: 'Northwind Digital', role: 'owner', status: 'pending' } as MyPartner

// The pages read the address once (no DOM here: effects do not run in markup).
const at = (hash: string) => {
  ;(globalThis as { window?: unknown }).window = {
    location: { hash, origin: 'http://localhost', href: `http://localhost/${hash}` },
    addEventListener() {},
    removeEventListener() {},
  }
}
at('#partner/setup')

const brand = await import('../brand.ts')
const { BrandMark, AuthPage } = await import('../ui/kit.tsx')
const { PartnerArea } = await import('./PartnerArea.tsx')
const { PartnerAgentSetup } = await import('./PartnerAgentSetup.tsx')

beforeAll(() => {
  // First the install's, as before sign-in; then a client workspace of the partner opens, with its brand.
  brand.setBrand(DEFAULT_BRANDING)
  brand.setBrand({
    ...DEFAULT_BRANDING,
    name: 'Northwind Voice',
    color: '#0f766e',
    logoUrl: PARTNER_LOGO,
    poweredBy: false,
    partner: { id: 'ptn_1', supportEmail: 'help@northwind.example', terms: null, privacy: null },
  })
})

const html = (hash: string, page: ReactElement) => {
  at(hash)
  return renderToStaticMarkup(page)
}

/** The top bar: the Linedesk mark and name, the install's color, and none of the partner's brand. */
function expectLinedesk(markup: string) {
  expect(markup).toContain('k-install-brand')
  expect(markup).toContain('class="k-logo"')
  expect(markup).not.toContain(PARTNER_LOGO)
  expect(markup).not.toContain('Northwind Voice')
}

test('client screens keep the partner brand; the install brand stays Linedesk', () => {
  expect(brand.brandName()).toBe('Northwind Voice')
  expect(renderToStaticMarkup(<BrandMark />)).toContain(PARTNER_LOGO)
  expect(brand.installBrandName()).toBe('Linedesk')
  expect(renderToStaticMarkup(<BrandMark install />)).not.toContain(PARTNER_LOGO)
})

test('the guided setup shows Linedesk, with the account menu', () => {
  const markup = html('#partner/setup', <PartnerArea partner={partner} />)
  expect(markup).toContain('Step 1 of 3')
  expectLinedesk(markup)
  expect(markup).toContain('<b>Linedesk</b>')
  expect(markup).toContain('ob-me')
})

test('the agent setup for a partner shows Linedesk, with the account menu', () => {
  const markup = html('#partner/agent', <PartnerAgentSetup partner={partner} />)
  expectLinedesk(markup)
  expect(markup).toContain('<b>Linedesk</b>')
  expect(markup).toContain('ob-me')
})

test('the partner area shows Linedesk next to the partner’s name', () => {
  const markup = html('#partner', <PartnerArea partner={partner} onExit={() => {}} />)
  expectLinedesk(markup)
  expect(markup).toContain('Northwind Digital')
})

test('the partner team invitation page shows Linedesk', () => {
  const markup = renderToStaticMarkup(<AuthPage install>x</AuthPage>)
  expectLinedesk(markup)
  expect(markup).toContain('aria-label="Linedesk"')
})
