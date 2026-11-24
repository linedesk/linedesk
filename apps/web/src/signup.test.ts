// The sign-up page's helpers (signup.ts): the config from /v1/signup/config, and the terms the details step shows and
// sends back as accepted (A9).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterSignupAddress, loadSignupConfig, type SignUpInput, signUpBusiness } from './signup.ts'

const plan = { monthlyCents: 1100, yearlyCents: 10_800, trialDays: 14 }

afterEach(() => vi.unstubAllGlobals())

const answer = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  )

const TERMS = {
  termsUrl: 'https://desk.example.com/terms',
  termsVersion: '2026-11-17',
  privacyUrl: 'https://desk.example.com/privacy',
  privacyVersion: '2026-11-10',
}

/** The person's name only: the business is named in the onboarding's Business step. */
const INPUT: SignUpInput = {
  name: 'Mike Brennan',
  plan: 'cloud',
  interval: 'year',
  acceptedTerms: { termsVersion: TERMS.termsVersion, privacyVersion: TERMS.privacyVersion },
}

describe('the sign-up config (A9)', () => {
  it('open with the terms to show', async () => {
    answer(200, { ok: true, open: true, turnstileSiteKey: null, plan, partnerPlan: null, terms: TERMS })
    expect(await loadSignupConfig()).toMatchObject({ open: true, turnstileSiteKey: null, terms: TERMS })
  })

  it('open without terms is treated as closed: no sign-up without terms to accept', async () => {
    answer(200, { ok: true, open: true, turnstileSiteKey: null, plan, partnerPlan: null })
    expect(await loadSignupConfig()).toMatchObject({ open: false, terms: null })
  })
})

describe('signUpBusiness', () => {
  it('sends the accepted terms versions', async () => {
    answer(200, { ok: true, data: { workspace: { id: 'ws_1' }, partner: null } })
    expect(await signUpBusiness(INPUT)).toEqual({ ok: true, workspaceId: 'ws_1', partnerId: null })
    const [, init] = vi.mocked(fetch).mock.calls[0]!
    expect(JSON.parse(init!.body as string).acceptedTerms).toEqual(INPUT.acceptedTerms)
  })

  it('a partner sign-up sends them too', async () => {
    answer(200, { ok: true, data: { workspace: null, partner: { id: 'ptn_1' } } })
    expect(await signUpBusiness({ ...INPUT, businessName: 'Cascade IT Partners', plan: 'partner' })).toEqual({
      ok: true,
      workspaceId: null,
      partnerId: 'ptn_1',
    })
    const [, init] = vi.mocked(fetch).mock.calls[0]!
    expect(JSON.parse(init!.body as string)).toMatchObject({
      plan: 'partner',
      businessName: 'Cascade IT Partners',
      acceptedTerms: INPUT.acceptedTerms,
    })
  })

  it('sends no business name or country for a business', async () => {
    answer(200, { ok: true, data: { workspace: { id: 'ws_1' }, partner: null } })
    await signUpBusiness(INPUT)
    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const sent = JSON.parse(init!.body as string)
    expect(sent).not.toHaveProperty('businessName')
    expect(sent).not.toHaveProperty('country')
  })

  it('terms changed meanwhile is its own answer, not "not available in this country"', async () => {
    answer(409, { ok: false, error: 'changed', code: 'terms_changed' })
    expect(await signUpBusiness(INPUT)).toEqual({ ok: false, notYet: false, closed: false, termsChanged: true })
    answer(409, { ok: false, error: 'not yet' })
    expect(await signUpBusiness(INPUT)).toEqual({ ok: false, notYet: true, closed: false, termsChanged: false })
  })

  it('a request from a country not served yet is "not yet"', async () => {
    answer(409, { ok: false, error: 'not here yet', code: 'country_not_served' })
    expect(await signUpBusiness(INPUT)).toEqual({ ok: false, notYet: true, closed: false, termsChanged: false })
  })
})

describe('after the sign-up (afterSignupAddress; setup before payment, 2026-11-18)', () => {
  it('a partner sets up first: its agent setup page, never straight to Checkout', () => {
    expect(afterSignupAddress(true)).toBe('/#partner/agent')
  })

  it('a business goes on to its onboarding, no Checkout', () => {
    expect(afterSignupAddress(false)).toBe('/')
  })
})
