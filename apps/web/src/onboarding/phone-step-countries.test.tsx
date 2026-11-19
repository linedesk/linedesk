// The onboarding phone step by the workspace's country (LIN-300): in a country of the server's buy offers (the US,
// Canada and Puerto Rico; Germany once German numbers are on, LIN-619) it offers a new number with that country's area
// codes and the carrier's price there; elsewhere only a number the business has.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const place = vi.hoisted(() => ({
  country: 'US' as string | null,
  known: true,
  businessPhone: undefined as string | undefined,
}))

vi.mock('../workspaceLocale.ts', () => ({
  useWorkspaceCountry: () => (place.country ? { country: place.country, known: place.known } : null),
}))
vi.mock('../phoneCountry.ts', () => ({ useDefaultPhoneCountry: () => place.country ?? 'US' }))
vi.mock('../settings/settings-api.ts', () => ({
  useWorkspaceSettings: () => ({ data: null }),
  useWriteAction: () => vi.fn(),
  readAction: vi.fn(),
}))
vi.mock('../store.tsx', () => ({
  useRows: () => [],
  useRun: () => vi.fn(),
  useAssistantName: () => 'Maya',
  useAssistant: () => ({ business_profile: { phone: place.businessPhone }, transfers: [] }),
}))

const { PhoneStep } = await import('./PhoneStep.tsx')
const { phoneSetupErrorText } = await import('./flow.ts')

const { BASE_BUY_OFFERS } = await import('@linedesk/actions')
type Offer = (typeof BASE_BUY_OFFERS)[number]
const GERMANY: Offer = { country: 'DE', numberType: 'local', areaCodes: ['6221'], ready: true }
const offers = vi.hoisted(() => ({ extra: [] as unknown[] }))

const render = (setupError: string | null = null) =>
  renderToStaticMarkup(
    <PhoneStep
      status={{
        provider: 'telnyx',
        available: true,
        detail: null,
        canAttach: true,
        buy: [...BASE_BUY_OFFERS, ...(offers.extra as Offer[])],
      }}
      oldForwarding={null}
      setupError={setupError}
      clearError={() => {}}
      admin={false}
      onBack={() => {}}
      onNext={() => {}}
    />,
  )
/** The value of the area code field, as the closed field shows it. */
const areaField = (html: string) =>
  html
    .match(/id="ob-area"[^>]*value="([^"]*)"|value="([^"]*)"[^>]*id="ob-area"/)
    ?.slice(1)
    .find(Boolean) ?? ''

describe('the phone step by country', () => {
  beforeEach(() => {
    place.country = 'US'
    place.known = true
    place.businessPhone = undefined
    offers.extra = []
  })

  test('in Canada: a new number with a Canadian area code from the business phone, at the Canadian price', () => {
    place.country = 'CA'
    place.businessPhone = '+14165550100'
    const html = render()
    expect(html).toContain('id="ob-area"')
    expect(areaField(html)).toBe('416 · Toronto, ON')
    expect(html).toContain('About $1 a month plus call minutes, billed by Telnyx.')
    expect(html).not.toContain('Buying numbers is available')
  })

  test('in Puerto Rico: its own codes and price', () => {
    place.country = 'PR'
    place.businessPhone = '+17875550100'
    const html = render()
    expect(areaField(html)).toBe('787 · San Juan, PR')
    expect(html).toContain('About $3 a month plus call minutes, billed by Telnyx.')
  })

  test('a business phone of another country prefills nothing: a US code is not offered in Canada', () => {
    place.country = 'CA'
    place.businessPhone = '+15035550100'
    const html = render()
    expect(html).toContain('id="ob-area"')
    expect(areaField(html)).toBe('')
  })

  test('no country set yet (the US by default): a Puerto Rico business finds its own code, at its price', () => {
    place.known = false
    place.businessPhone = '+17875550100'
    const html = render()
    expect(areaField(html)).toBe('787 · San Juan, PR')
    expect(html).toContain('About $3 a month plus call minutes, billed by Telnyx.')
  })

  test('no free number in 416: the message offers one click to search the nearby area codes (LIN-313)', () => {
    place.country = 'CA'
    place.businessPhone = '+14165550100'
    const html = render(phoneSetupErrorText('no number available in area code 416'))
    expect(html).toContain('No number is free in that area code right now. Try a nearby one.')
    expect(html).toContain('Search nearby area codes')
    expect(html).toContain('Looks for a free number in 437, 647, 942, 289, 365, 742, 905, and 226. Buys nothing.')
    // Any other refusal: the message alone.
    expect(render(phoneSetupErrorText('telnyx: POST /number_orders: Authentication failed (HTTP 401)'))).not.toContain(
      'Search nearby area codes',
    )
  })

  test('outside the buying countries: no area code field, the line says where buying works', () => {
    place.country = 'AT'
    const html = render()
    expect(html).not.toContain('id="ob-area"')
    expect(html).toContain(
      'Buying numbers is available in the US, Canada and Puerto Rico for now. Connect a number you already have in Telnyx.',
    )
  })

  test('Germany with German numbers on: buys like the US, in the offered area code 06221, no documents', () => {
    place.country = 'DE'
    offers.extra = [GERMANY]
    const html = render()
    expect(html).toContain('id="ob-area"')
    expect(html).toContain('About $1 a month plus call minutes, billed by Telnyx.')
    expect(html).not.toContain('Buying numbers is available')
    expect(html).not.toMatch(/document|Handelsregister|register/i)
  })

  test('Germany while German numbers are off or not set up yet: the calm being-set-up line, no buying', () => {
    place.country = 'DE'
    offers.extra = [{ ...GERMANY, ready: false }]
    const html = render()
    expect(html).not.toContain('id="ob-area"')
    expect(html).toContain('Numbers in your country are being set up. Continue for now and connect your number later.')
    expect(html).not.toContain('Buying numbers is available')
  })

  test('the being-set-up refusal of the API is said calmly too', () => {
    expect(phoneSetupErrorText('Numbers in this country are being set up on this server')).toBe(
      'Numbers in your country are being set up. Continue for now and connect your number later.',
    )
  })
})
