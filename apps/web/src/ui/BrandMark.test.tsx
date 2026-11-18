import type { Branding } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const brand = vi.hoisted(() => ({ current: {} as Branding }))
vi.mock('../brand.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../brand.ts')>()),
  useBrand: () => brand.current,
}))

const { BrandMark } = await import('./kit.tsx')

const base = { color: null, logoUrl: null, starPrompt: false, starCount: null, poweredBy: false } as const
const partner = { id: 'p1', supportEmail: null, terms: null, privacy: null }

describe('BrandMark', () => {
  beforeEach(() => {
    brand.current = { ...base, name: 'Linedesk', starPrompt: true, poweredBy: true } as Branding
  })

  test('the Linedesk mark for the install', () => {
    expect(renderToStaticMarkup(<BrandMark />)).toContain('k-logo')
  })

  test("a partner's brand without a logo shows its first letter, never the Linedesk mark", () => {
    brand.current = { ...base, name: 'cascade Desk', partner } as Branding
    const html = renderToStaticMarkup(<BrandMark className="auth-mark" label="cascade Desk" />)
    expect(html).not.toContain('k-logo')
    expect(html).toContain('is-initial')
    expect(html).toContain('>C</span>')
  })

  test("a partner's logo wins over the letter", () => {
    brand.current = { ...base, name: 'Cascade Desk', logoUrl: '/v1/branding/logo.png?v=1', partner } as Branding
    const html = renderToStaticMarkup(<BrandMark />)
    expect(html).toContain('is-logo')
    expect(html).not.toContain('is-initial')
  })
})
