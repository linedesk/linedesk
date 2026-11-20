// Settings › Phone numbers › Add number, step 1: a new number for the assistant with its monthly price (the bill's
// extra-number price, or the carrier's list price without a bill), and the quiet link to a number already in the
// carrier account only where the server allows it (canAttach: instance admins, any carrier). Step 2's answers map to the number's mode.
import type { PhoneNumber } from '@linedesk/db/types'
import { BASE_BUY_OFFERS, type BuyOffer } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  numbers: [] as unknown[],
  place: { country: 'US', known: true, source: 'explicit' } as { country: string; known: boolean; source: string },
}))

vi.mock('../workspaceLocale.ts', () => ({ useWorkspaceCountry: () => state.place }))
vi.mock('../phoneCountry.ts', () => ({ useDefaultPhoneCountry: () => 'US' }))
vi.mock('./settings-api.ts', () => ({
  useWorkspaceSettings: () => ({ data: null }),
  useWriteAction: () => vi.fn(),
  readAction: vi.fn(),
}))
vi.mock('../store.tsx', () => ({
  useRows: () => state.numbers,
  useRun: () => vi.fn(),
  useAssistantName: () => 'Maya',
  useAssistants: () => [{ id: 'as_1', name: 'Maya', business_profile: { phone: '+15035550100' } }],
  useClaimedRejection: () => ({ rejection: null, clearRejection: () => {} }),
}))

const { ConnectNumber, answerForMode, modeForAnswer } = await import('./PhoneNumbers.tsx')

const boughtNumber = { id: 'pn_1', e164: '+15035550111', purchased: true, carrier_account: 'install' }

const render = ({
  extraNumberCents = null,
  canAttach = true,
  provider = 'telnyx',
  buy = [...BASE_BUY_OFFERS],
}: {
  extraNumberCents?: number | null
  canAttach?: boolean
  provider?: string
  buy?: BuyOffer[]
}) =>
  renderToStaticMarkup(
    <ConnectNumber
      status={{ provider, available: true, detail: null, canAttach, buy }}
      extraNumberCents={extraNumberCents}
      onDone={() => {}}
    />,
  )

const GERMANY: BuyOffer = { country: 'DE', numberType: 'local', areaCodes: ['6221'], ready: true }

describe('step 1: a new number', () => {
  beforeEach(() => {
    state.numbers = [boughtNumber]
    state.place = { country: 'US', known: true, source: 'explicit' }
  })

  test('asks for a new number for the assistant, with the area code', () => {
    const html = render({})
    expect(html).toContain('Get a new number for Maya?')
    expect(html).toContain('id="st-pn-area"')
    expect(html).toContain('Get a number')
    // No cards to pick between first: forwarding is step 2.
    expect(html).not.toContain('Keep my number')
  })

  test('on a bill: the extra number price from the billing data, large, per month', () => {
    const html = render({ extraNumberCents: 300 })
    expect(html).toMatch(/class="pn-price-amount">\$3</)
    expect(html).toContain('a month')
    expect(html).toContain('Paid from your balance')
    expect(html).not.toContain('billed by Telnyx')
    // Whatever the install charges: never a fixed $3.
    expect(render({ extraNumberCents: 450 })).toMatch(/class="pn-price-amount">\$4\.50</)
  })

  test("on a bill, the workspace's first number is the included one", () => {
    state.numbers = []
    const html = render({ extraNumberCents: 300 })
    expect(html).toContain('Your first number is included in your plan.')
    expect(html).not.toContain('pn-price-amount')
  })

  test('without a bill: the hint that the carrier bills the number', () => {
    const html = render({ extraNumberCents: null })
    expect(html).toContain('About $1 a month plus call minutes, billed by Telnyx.')
    expect(html).not.toContain('pn-price-amount')
  })

  test('the link to a number already in the carrier account only where the server allows it (canAttach)', () => {
    expect(render({ canAttach: true })).toContain('Already have a number in Telnyx? Use it')
    expect(render({ canAttach: false })).not.toContain('Already have a number in Telnyx? Use it')
    expect(render({ canAttach: false, extraNumberCents: 300 })).not.toContain('Use it')
    // Any install carrier: the link names it, and is hidden the same way for whoever is not an instance admin.
    expect(render({ provider: 'twilio', canAttach: true })).toContain('Already have a number in Twilio? Use it')
    expect(render({ provider: 'twilio', canAttach: false })).not.toContain('Use it')
  })
})

describe('a German workspace whose country is only hinted (LIN-645)', () => {
  beforeEach(() => {
    state.numbers = []
    state.place = { country: 'DE', known: false, source: 'sign_up_location' }
  })

  test('German numbers on: the 06221 offer, no US area codes', () => {
    const html = render({ buy: [...BASE_BUY_OFFERS, GERMANY] })
    expect(html).toContain('id="st-pn-area"')
    expect(html).toMatch(/value="06221 · Heidelberg"/)
    expect(html).not.toContain('Portland')
  })

  test('German numbers off, for a member who cannot attach: only the being-set-up note and Cancel', () => {
    const html = renderToStaticMarkup(
      <ConnectNumber
        status={{
          provider: 'telnyx',
          available: true,
          detail: null,
          canAttach: false,
          buy: [...BASE_BUY_OFFERS, { ...GERMANY, ready: false }],
        }}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(html).toContain('Numbers in your country are being set up. Continue for now and connect your number later.')
    expect(html).not.toContain('id="st-pn-area"')
    expect(html).not.toContain('Telnyx')
    expect(html).not.toContain('Connect number')
    expect(html).not.toMatch(/<button[^>]*disabled/)
    expect(html).toContain('Cancel')
  })

  test('the German offer missing (own carrier account): every buyable area code, as with nothing known', () => {
    const html = render({})
    expect(html).toContain('id="st-pn-area"')
    expect(html).toMatch(/value="503 · Portland, OR"/)
  })
})

describe("step 2: forward the current number here, saved as the number's mode", () => {
  test('forwarding takes the pick-up choice’s mode; no forwarding makes it a number of its own', () => {
    expect(modeForAnswer('forward', 'forward_conditional')).toBe('forward_conditional')
    expect(modeForAnswer('forward', 'forward_all')).toBe('forward_all')
    expect(modeForAnswer('none', 'forward_all')).toBe('new')
  })

  test('the answer shown follows the saved mode', () => {
    const modes: PhoneNumber['mode'][] = ['forward_conditional', 'forward_all', 'new', 'ported']
    expect(modes.map(answerForMode)).toEqual(['forward', 'forward', 'none', 'none'])
  })
})
