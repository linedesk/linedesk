// The alerts and notices are translated through and through: rendered in the pseudo-locale en-XA, where every
// translated word is accented and wrapped in ⟦ ⟧, nothing but the data (an address, a browser string, a name) may be
// left outside the brackets. A word of English written into the code shows up here.
import { PSEUDO_LOCALE } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'
import { describe, expect, it } from 'vitest'
import { browserOf } from '../admin-alerts.ts'
import { brandName } from '../branding.ts'
import {
  adminAlertEmail,
  adminGrantedAlert,
  adminSignInAlert,
  cappedCallAlert,
  enrolmentIssuedAlert,
  installTestEmail,
  ledgerCheckAlert,
  passkeysResetAlert,
  providerFailureAlert,
  settingsChangedAlert,
  spendingCapEmail,
} from './alerts.ts'
import type { RenderedEmail } from './layout.ts'
import { setupUnsubscribePage } from './pages.ts'
import { assignedPushText, callPushTitle } from './push-text.ts'
import { signInCodeEmail } from './templates.ts'

const ORIGIN = 'https://desk.example.com'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'
const AT = '2026-11-14T17:05:00Z'

/** What is left of a text once every translated message (⟦…⟧, nested too) and the given data are taken out. */
function untranslated(text: string, data: string[]): string[] {
  let rest = text
  for (let before = ''; before !== rest; ) {
    before = rest
    rest = rest.replace(/⟦[^⟦⟧]*⟧/g, ' ')
  }
  // Links (the button's target) are not words.
  rest = rest.replace(/https?:\/\/\S+/g, ' ')
  const site = new URL(ORIGIN).host
  for (const value of [...data, site].sort((a, b) => b.length - a.length)) rest = rest.replaceAll(value, ' ')
  // The header's wordmark writes the brand in lowercase.
  rest = rest.replace(new RegExp(brandName(), 'gi'), ' ')
  return rest.match(/\p{L}{2,}/gu) ?? []
}

const html2text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')

const expectTranslated = (email: RenderedEmail, data: string[]) => {
  expect(untranslated(email.subject, data), 'subject').toEqual([])
  expect(untranslated(email.text, data), 'text').toEqual([])
  const left = untranslated(html2text(email.html), data)
  expect(left, `html: ${html2text(email.html).replace(/\s+/g, ' ')}`).toEqual([])
}

describe('in the pseudo-locale nothing is left in English', () => {
  const pseudo = PSEUDO_LOCALE
  const utc = getT(pseudo).format.dateTime(new Date(AT), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })

  it('the admin sign-in from a new device (Janik, prod, 日本語 admin)', () => {
    for (const method of ['passkey', 'authenticator', 'password', 'email_code', 'google', 'other']) {
      const alert = adminSignInAlert({
        who: 'ann@brightwater.example',
        method,
        browser: browserOf(UA),
        userAgent: UA,
        address: '203.0.113.9',
        at: AT,
      })
      const email = adminAlertEmail(alert(pseudo), ORIGIN, pseudo)
      expectTranslated(email, ['ann@brightwater.example', '203.0.113.9', 'Chrome', 'macOS', 'Google', utc])
      expect(email.html).toContain('<html lang="en-XA"')
    }
    // No browser recognised, no address: the words for "unknown" are translated too.
    const bare = adminSignInAlert({
      who: 'a@b.test',
      method: 'passkey',
      browser: null,
      userAgent: '',
      address: '',
      at: AT,
    })
    expectTranslated(adminAlertEmail(bare(pseudo), ORIGIN, pseudo), ['a@b.test', utc])
  })

  it('a call billed at its limit', () => {
    const alert = cappedCallAlert({ bill: 'bill_1', call: 'call_1', reported: 36_000, billed: 120 })
    expectTranslated(adminAlertEmail(alert(pseudo), ORIGIN, pseudo), ['bill_1', 'call_1', '36000', '120'])
    expect(alert('en').blocks[0]).toMatchObject({ text: expect.stringContaining('reported 36000 seconds') })
  })

  it('the nightly billing check', () => {
    const found = {
      guardsMissing: ['ledger_entries.ledger_entries_append_only'],
      differences: [
        { kind: 'balance', bill: 'bill_1', found: 5, expected: 7 },
        { kind: 'counter_allowance', bill: 'bill_1', period: 'bp_1', workspace: 'ws_1', found: 0, expected: 120 },
        { kind: 'uncredited', bill: 'bill_1', recharge: 'rc_1' },
      ],
    } as const
    const email = adminAlertEmail(
      ledgerCheckAlert({ ...found, guardsMissing: [...found.guardsMissing], differences: [...found.differences] })(
        pseudo,
      ),
      ORIGIN,
      pseudo,
    )
    expectTranslated(email, ['ledger_entries.ledger_entries_append_only', 'bill_1', 'bp_1', 'ws_1', 'rc_1'])
    const english = ledgerCheckAlert({ guardsMissing: [], differences: [...found.differences] })('en')
    expect(english.subject).toBe(`Billing check on ${brandName()}: 3 problems found`)
  })

  it('the English alert says what it said before', () => {
    const alert = adminSignInAlert({
      who: 'ann@brightwater.example',
      method: 'passkey',
      browser: browserOf(UA),
      userAgent: UA,
      address: '203.0.113.9',
      at: AT,
    })
    const { subject, text } = adminAlertEmail(alert('en'), ORIGIN, 'en')
    expect(subject).toBe(`Admin sign-in from a new device on ${brandName()}: ann@brightwater.example`)
    expect(text).toContain(
      'ann@brightwater.example, a server admin, confirmed with their passkey from a device not seen before for them.',
    )
    expect(text).toMatch(/Time: Nov 14, 2026, 5:05\sPM UTC\nBrowser: Chrome on macOS\nAddress: 203\.0\.113\.9/)
    expect(text).toContain('If this was them, nothing to do.')
  })

  it('the sign-in code email with its button, and without one', () => {
    const link = `${ORIGIN}/#sign-in=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ`
    for (const email of [signInCodeEmail('482913', ORIGIN, pseudo, link), signInCodeEmail('482913', ORIGIN, pseudo)]) {
      expectTranslated(email, ['482913'])
      expect(email.html).toContain('<html lang="en-XA"')
    }
    expect(signInCodeEmail('482913', ORIGIN, pseudo, link).html).toContain(`href="${link}"`)
  })

  it('every other admin alert', () => {
    const admin = { email: 'ann@brightwater.example' }
    const alerts = [
      providerFailureAlert('ElevenLabs', 'quota', 'quota_exceeded'),
      adminGrantedAlert(admin, 'sam@brightwater.example'),
      adminGrantedAlert({ operator: true }, 'sam@brightwater.example'),
      settingsChangedAlert({ change: 'changed', provider: 'Resend', actor: admin, agent: null }),
      settingsChangedAlert({
        change: 'cleared',
        provider: '',
        actor: admin,
        agent: { prefix: 'lds_7Qp2', createdAt: AT },
      }),
      passkeysResetAlert(admin, 'sam@brightwater.example', 2, true),
      enrolmentIssuedAlert({ operator: true }, 'sam@brightwater.example'),
    ]
    const data = [
      'ann@brightwater.example',
      'sam@brightwater.example',
      'ElevenLabs',
      'quota_exceeded',
      'Resend',
      'lds_7Qp2',
      utc,
    ]
    for (const alert of alerts) expectTranslated(adminAlertEmail(alert(pseudo), ORIGIN, pseudo), data)
  })

  it('the spending cap emails and the setup test email', () => {
    const money = (value: number) => getT(pseudo).format.currency(value, 'USD')
    for (const level of [80, 100])
      expectTranslated(
        spendingCapEmail({ workspace: 'Brightwater', level, capUsd: 50, spentUsd: 41 }, ORIGIN, pseudo),
        ['Brightwater', money(50), money(41)],
      )
    expectTranslated(spendingCapEmail({ workspace: null, level: 80, capUsd: 50, spentUsd: 41 }, ORIGIN, pseudo), [
      money(50),
      money(41),
    ])
    expectTranslated(installTestEmail('204816', ORIGIN, pseudo), ['204816'])
  })

  it('push notifications and the unsubscribe pages', () => {
    for (const kind of ['urgent', 'message', 'finished'] as const)
      expect(untranslated(callPushTitle(kind, 'Priya Shah', pseudo), ['Priya Shah'])).toEqual([])
    const assigned = assignedPushText('Mike Brennan', 'Priya Shah', 'Leaking water heater', pseudo)
    expect(
      untranslated(`${assigned.title} ${assigned.body}`, ['Mike Brennan', 'Priya Shah', 'Leaking water heater']),
    ).toEqual([])
    for (const kind of ['invalid', 'confirm', 'done'] as const)
      expect(untranslated(html2text(setupUnsubscribePage(kind, pseudo, '/api/unsubscribe/setup?t=x')), [])).toEqual([])
  })
})

describe('in a real language', () => {
  it('the frame and the alert are both German', () => {
    const alert = adminSignInAlert({
      who: 'a@b.test',
      method: 'passkey',
      browser: null,
      userAgent: '',
      address: '',
      at: AT,
    })
    // German has no translation of the new keys until the release pass: English for now, never a mix in one message.
    const { text } = adminAlertEmail(alert('de'), ORIGIN, 'de')
    expect(text).toContain(getT('de').t('email.adminAlert.eyebrow'))
    expect(text).toContain(getT('de').t('email.adminAlert.signIn.ifNot'))
  })
})
