import { describe, expect, it } from 'vitest'
import { DEFAULT_PROTECTED_NAMES, partnerBrandInput, protectedNameIn } from './partner-brand.ts'

const input = {
  partnerId: 'p_1',
  name: 'Cascade Desk',
  color: '#0f766e',
  supportEmail: 'help@cascade.example',
  termsUrl: 'https://cascade.example/terms',
  privacyUrl: null,
}

describe('protectedNameIn', () => {
  const list = DEFAULT_PROTECTED_NAMES

  it.each([
    ['Linedesk', 'Linedesk'],
    ['linedesk support', 'Linedesk'],
    ['Line-Desk', 'Linedesk'],
    ['L1nedesk Pro', 'Linedesk'],
    ['MyPayPalDesk', 'PayPal'],
    ['Paypa1 Calls', 'PayPal'],
    ['G00gle Voice', 'Google'],
    ['Chase Support', 'Chase'],
    ['bank of america desk', 'Bank of America'],
    ['Bánk of Américà', 'Bank of America'],
    ['Wells-Fargo Line', 'Wells Fargo'],
    ['IRS Helpline', 'IRS'],
    // Security review of #1111, M-1: punctuation inside short names, Cyrillic and Greek look-alikes.
    ['I.R.S.', 'IRS'],
    ['I.R.S. Refunds', 'IRS'],
    ['U.S.P.S. Tracking', 'USPS'],
    ['Vi-sa Support', 'Visa'],
    ['Visa', 'Visa'],
    ['V I S A', 'Visa'],
    ["Chase's Desk", 'Chase'],
    ['\u0421hase', 'Chase'],
    ['\u0421HASE Bank', 'Chase'],
    ['L\u0456nedesk', 'Linedesk'],
    ['\u0410pple Care', 'Apple'],
    ['\u0392\u0391\u039D\u039A of America', 'Bank of America'],
    ['\uFF27\uFF4F\uFF4F\uFF47\uFF4C\uFF45', 'Google'],
    // Security review of #1111, N-3: short names joined by punctuation, stroke letters, letter pairs.
    ['Chase.com', 'Chase'],
    ['Chase-Support', 'Chase'],
    ['IRS-Help', 'IRS'],
    ['Visa-Card', 'Visa'],
    ['Apple.Support', 'Apple'],
    ['Cash-App Desk', 'Cash App'],
    ['G\u00F8\u00F8gle', 'Google'],
    ['Payp\u0430\u0142', 'PayPal'],
    ['Arnazon Calls', 'Amazon'],
    ['G\u0585\u0585gle', 'Google'],
    ['\u13DFhase', 'Chase'],
    ['\u0110ocu\u0024ign', 'DocuSign'],
  ])('%s -> %s', (name, found) => {
    expect(protectedNameIn(name, list)).toBe(found)
  })

  it.each([
    'Cascade Desk',
    'Brightwater Phones',
    // Short names count only as a whole word: "Chasewood" is not Chase, "Visalia" is not Visa.
    'Chasewood Answering',
    'Visalia Front Desk',
    'Firstline Reception',
  ])('%s is allowed', name => {
    expect(protectedNameIn(name, list)).toBeNull()
  })

  it('refuses invisible characters in the name itself (brandingInput), so they cannot split a protected name', () => {
    for (const name of ['Cha\u00ADse', 'Cha\u200Bse', 'Vi\u200Dsa', 'I\u2060RS', 'Pay\uFEFFPal', 'Cha\u034Fse']) {
      expect(partnerBrandInput.safeParse({ ...input, name }).success, JSON.stringify(name)).toBe(false)
    }
    expect(partnerBrandInput.safeParse({ ...input, name: 'Café Desk' }).success).toBe(true)
  })

  it("uses the install's own list", () => {
    expect(protectedNameIn('Acme Calls', ['Acme'])).toBe('Acme')
    expect(protectedNameIn('Linedesk', ['Acme'])).toBeNull()
    expect(protectedNameIn('Anything', [])).toBeNull()
  })
})

describe('partnerBrandInput', () => {
  const base = {
    partnerId: 'p_1',
    name: 'Cascade Desk',
    color: '#0f766e',
    supportEmail: 'Help@Cascade.example',
    termsUrl: 'https://cascade.example/terms',
    privacyUrl: null,
  }

  it('accepts a brand and lower-cases the support email', () => {
    const parsed = partnerBrandInput.parse(base)
    expect(parsed.supportEmail).toBe('help@cascade.example')
  })

  it.each([
    'http://cascade.example/terms',
    'javascript:alert(1)',
    'https://user:pw@cascade.example/terms',
    'cascade.example/terms',
    `https://cascade.example/${'a'.repeat(500)}`,
  ])('refuses the link %s', termsUrl => {
    expect(partnerBrandInput.safeParse({ ...base, termsUrl }).success).toBe(false)
  })

  it('refuses a support email that is not one', () => {
    expect(partnerBrandInput.safeParse({ ...base, supportEmail: 'help' }).success).toBe(false)
  })
})
