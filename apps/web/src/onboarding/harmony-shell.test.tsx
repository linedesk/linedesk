// One setup experience (onboarding harmony, 2026-11-18, WP3): which steps a workspace goes through by hand, so the count
// runs on over "Start your free trial" once it is done; where a partner's client draft goes back to; a closing last
// step (Done, no Later); the install walkthrough counting its four parts only; and the Checkout's answer in the shell
// it came from (the partner's setup, in the install's brand, at "Step 3 of 3 · Activate").
import { DEFAULT_BRANDING } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, test, vi } from 'vitest'

vi.mock('../shell/SetupAccountMenu.tsx', () => ({ SetupAccountMenu: () => <span className="menu" /> }))
vi.mock('../checkout.ts', () => ({
  confirmCheckout: () => new Promise(() => {}),
  goToCheckout: async () => {},
  readCheckoutPartner: () => (globalThis as { partnerId?: string | null }).partnerId ?? null,
  readCheckoutSession: () => 'cs_test_1',
}))

const brand = await import('../brand.ts')
const {
  activationSteps,
  draftOpenedFrom,
  onboardingSteps,
  partnerDraftSteps,
  rememberDraftOpenedFrom,
  stepsFor,
  trialSteps,
} = await import('./flow.ts')
const { SetupFoot, StepModeContext } = await import('./SetupFoot.tsx')
const { installTopBar } = await import('./InstallSetup.tsx')
const { CheckoutReturn } = await import('../CheckoutReturn.tsx')

beforeAll(() => {
  brand.setBrand(DEFAULT_BRANDING)
  // A partner's client workspace is open: its white-label brand is the app's.
  brand.setBrand({
    ...DEFAULT_BRANDING,
    name: 'Northwind Voice',
    poweredBy: false,
    partner: { id: 'ptn_1', supportEmail: 'help@northwind.example', terms: null, privacy: null },
  })
})

describe('the steps by hand', () => {
  test('a trial sign-up counts its whole way, also once the trial or plan runs', () => {
    expect(stepsFor({ billingState: 'pending_payment' })).toEqual({
      steps: activationSteps,
      counted: trialSteps,
      draft: false,
      activating: true,
    })
    // Back from the number passes "Start your free trial" as done: 6 of 7, then 5 of 7, never 4 of 7.
    const after = stepsFor({ billingState: 'active' }).steps
    expect(after).toBe(trialSteps)
    expect(after.indexOf('phone') - after.indexOf('activate')).toBe(1)
    expect(stepsFor({ billingState: 'active' }).activating).toBe(false)
  })

  test("a partner's draft goes through the free steps; a client on its partner's bill and an install off billing have no card step", () => {
    expect(stepsFor({ billingState: 'pending_payment', partnerManaged: true })).toEqual({
      steps: partnerDraftSteps,
      counted: partnerDraftSteps,
      draft: true,
      activating: false,
    })
    expect(stepsFor({ billingState: 'active', partnerManaged: true }).steps).toBe(onboardingSteps)
    expect(stepsFor({ billingState: null }).steps).toBe(onboardingSteps)
    expect(stepsFor(null).steps).toBe(onboardingSteps)
  })
})

describe('where a client draft goes back to', () => {
  const memory = () => {
    const items = new Map<string, string>()
    return {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
    } as unknown as Storage
  }

  test('where it was opened, per workspace', () => {
    const storage = memory()
    rememberDraftOpenedFrom('ws_1', '#partner', storage)
    rememberDraftOpenedFrom('ws_2', '#partner/setup/clients', storage)
    expect(draftOpenedFrom('ws_1', storage)).toBe('#partner')
    expect(draftOpenedFrom('ws_2', storage)).toBe('#partner/setup/clients')
    expect(draftOpenedFrom('ws_3', storage)).toBeNull()
  })

  test('only a partner page, and nothing when storage is off', () => {
    const storage = memory()
    rememberDraftOpenedFrom('ws_1', '#calls', storage)
    expect(draftOpenedFrom('ws_1', storage)).toBeNull()
    const off = {
      getItem: () => {
        throw new Error('off')
      },
      setItem: () => {
        throw new Error('off')
      },
    } as unknown as Storage
    expect(() => rememberDraftOpenedFrom('ws_1', '#partner', off)).not.toThrow()
    expect(draftOpenedFrom('ws_1', off)).toBeNull()
  })
})

describe('the footer of a last step', () => {
  const foot = (mode: { edit: boolean; last: boolean; closes?: boolean }) =>
    renderToStaticMarkup(
      <StepModeContext.Provider value={mode}>
        <SetupFoot onBack={() => {}} onContinue={() => {}} onSkipStep={() => {}} />
      </StepModeContext.Provider>,
    )

  test("a client draft's last step ends it: Done, no Later", () => {
    const html = foot({ edit: false, last: true, closes: true })
    expect(html).toContain('>Done<')
    expect(html).not.toContain('>Later<')
  })

  test('a step of the first setup keeps Continue and the quiet Later', () => {
    const html = foot({ edit: false, last: false, closes: true })
    expect(html).toContain('>Continue<')
    expect(html).toContain('>Later<')
  })
})

describe('the install walkthrough top bar', () => {
  test('counts the four parts only; Welcome and Done have no count', () => {
    expect(installTopBar('welcome')).toEqual({ part: null, progress: 0 })
    expect(installTopBar('email')).toEqual({ part: { n: 1, m: 4 }, progress: 20 })
    expect(installTopBar('call-audio')).toEqual({ part: { n: 4, m: 4 }, progress: 80 })
    expect(installTopBar('done')).toEqual({ part: null, progress: 100 })
  })
})

describe("the Checkout's answer", () => {
  const page = (partnerId: string | null, props: Partial<Parameters<typeof CheckoutReturn>[0]> = {}) => {
    ;(globalThis as { partnerId?: string | null }).partnerId = partnerId
    return renderToStaticMarkup(<CheckoutReturn onDone={() => {}} {...props} />)
  }

  test("a partner's: the partner's setup at its last step, in the install's brand", () => {
    const html = page('ptn_1')
    expect(html).toContain('Step 3 of 3 · Activate')
    expect(html).toContain('k-install-brand')
    expect(html).toContain(brand.installBrandName())
    expect(html).not.toContain('Northwind Voice')
    expect(html).not.toContain('auth-card')
  })

  test("an owner's from the steps: their frame, as Start your plan when there is no trial", () => {
    const trial = page(null, { inSetup: true })
    expect(trial).toContain('Step 5 of 7 · Start your free trial')
    expect(page(null, { inSetup: true, planOnly: true })).toContain('Step 5 of 7 · Start your plan')
  })

  test("an owner's from the agent page: the agent page's top bar, no step count", () => {
    const html = page(null, { inSetup: true, shell: 'agent' })
    expect(html).toContain('With an AI agent')
    expect(html).not.toContain('Step 5 of 7')
  })
})
