// The sign-up page's helpers (signup.ts): the config from /v1/signup/config, and the terms the details step shows and
// sends back as accepted (A9).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSignupConfig, type SignUpInput, signUpBusiness } from './signup.ts'

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

const INPUT: SignUpInput = {
  name: 'Mike Brennan',
  businessName: 'Brightwater Plumbing & Heating',
  country: 'US',
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
    expect(await signUpBusiness({ ...INPUT, plan: 'partner' })).toEqual({
      ok: true,
      workspaceId: null,
      partnerId: 'ptn_1',
    })
    const [, init] = vi.mocked(fetch).mock.calls[0]!
    expect(JSON.parse(init!.body as string)).toMatchObject({ plan: 'partner', acceptedTerms: INPUT.acceptedTerms })
  })

  it('terms changed meanwhile is its own answer, not "not available in this country"', async () => {
    answer(409, { ok: false, error: 'changed', code: 'terms_changed' })
    expect(await signUpBusiness(INPUT)).toEqual({ ok: false, notYet: false, closed: false, termsChanged: true })
    answer(409, { ok: false, error: 'not yet' })
    expect(await signUpBusiness(INPUT)).toEqual({ ok: false, notYet: true, closed: false, termsChanged: false })
  })
})
