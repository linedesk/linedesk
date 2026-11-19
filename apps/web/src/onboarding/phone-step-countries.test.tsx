// The onboarding phone step by the workspace's country (LIN-300): in the US, Canada and Puerto Rico it offers a new
// number with that country's area codes and the carrier's price there; elsewhere only a number the business has.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const place = vi.hoisted(() => ({
  country: 'US' as string | null,
  known: true,
  businessPhone: undefined as string | undefined,
}))

// A country whose numbers need documents, once the server takes requests there (the request itself: NumberRequestFlow).
const kyc = vi.hoisted(() => ({ country: null as string | null, loading: false }))
vi.mock('../numbers/numberRequestQueries.ts', () => ({ useKycCountry: () => ({ ...kyc }) }))
vi.mock('../numbers/NumberRequestFlow.tsx', () => ({
  NumberRequestFlow: ({ country }: { country: string }) => <p>number request for {country}</p>,
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

const status = { provider: 'telnyx', available: true, detail: null, canAttach: true }
const render = (setupError: string | null = null) =>
  renderToStaticMarkup(
    <PhoneStep
      status={status}
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
    kyc.country = null
    kyc.loading = false
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
    place.country = 'DE'
    const html = render()
    expect(html).not.toContain('id="ob-area"')
    expect(html).toContain(
      'Buying numbers is available in the US, Canada and Puerto Rico for now. Connect a number you already have in Telnyx.',
    )
  })

  test('Germany, open for number requests on the server: the request with documents instead of buying', () => {
    place.country = 'DE'
    kyc.country = 'DE'
    const html = render()
    expect(html).toContain('number request for DE')
    expect(html).not.toContain('id="ob-area"')
    expect(html).not.toContain('Buying numbers is available')
  })

  test('while the server is asked which countries take requests: a placeholder, not the wrong step', () => {
    place.country = 'DE'
    kyc.loading = true
    const html = render()
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('Buying numbers is available')
  })
})
