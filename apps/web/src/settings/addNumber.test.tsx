// Settings › Phone numbers › Add number, step 1: a new number for the assistant with its monthly price (the bill's
// extra-number price, or the carrier's list price without a bill), and the quiet link to a number already in the
// carrier account only where the server allows it (canAttach). Step 2's answers map to the number's mode.
import type { PhoneNumber } from '@linedesk/db/types'
import { BASE_BUY_OFFERS } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ numbers: [] as unknown[] }))

vi.mock('../workspaceLocale.ts', () => ({ useWorkspaceCountry: () => ({ country: 'US', known: true }) }))
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
}: {
  extraNumberCents?: number | null
  canAttach?: boolean
}) =>
  renderToStaticMarkup(
    <ConnectNumber
      status={{ provider: 'telnyx', available: true, detail: null, canAttach, buy: [...BASE_BUY_OFFERS] }}
      extraNumberCents={extraNumberCents}
      onDone={() => {}}
    />,
  )

describe('step 1: a new number', () => {
  beforeEach(() => {
    state.numbers = [boughtNumber]
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
