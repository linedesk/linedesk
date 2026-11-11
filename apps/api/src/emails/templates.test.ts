import { describe, expect, it } from 'vitest'
import { defuseLinks, escapeHtml, renderEmail } from './layout.ts'
import { previewEmails } from './previews.ts'
import {
  bookingConfirmationEmail,
  type CallEmail,
  callEmail,
  invitationEmail,
  passkeyChangedEmail,
  signInCodeEmail,
} from './templates.ts'

const ORIGIN = 'https://desk.example.com'

const call: CallEmail = {
  callId: 'call_1',
  title: 'Water heater',
  summary: 'No hot water since this morning.',
  urgent: false,
  fromNumber: '+15035550191',
  callerName: 'Priya Shah',
  assistantName: 'Maya',
  startedAt: '2026-11-10T17:00:00Z',
  durationSec: 184,
  timeZone: 'America/Los_Angeles',
  nextSteps: ['Call back before noon'],
  booking: null,
  workspace: 'Brightwater Plumbing & Heating',
}

describe('every email', () => {
  for (const { name, email } of previewEmails(ORIGIN)) {
    it(`${name}: one-line subject, the same heading in both parts, a footer with the site`, () => {
      expect(email.subject).not.toMatch(/\n/)
      expect(email.html).toMatch(/^<!doctype html>/)
      expect(email.html).toContain('<meta name="color-scheme" content="light dark">')
      expect(email.html).not.toMatch(/<img|<link|url\(|@import/i)
      expect(email.text).toContain('desk.example.com')
      expect(email.html).toContain('desk.example.com')
      const heading = email.html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1]
      expect(heading).toBeTruthy()
      expect(email.text).toContain(heading!.replaceAll('&amp;', '&').replaceAll('&#39;', "'"))
    })
  }
})

describe('the layout', () => {
  it('escapes everything a template passes', () => {
    const email = renderEmail({
      subject: 'x',
      preheader: '<p>',
      heading: '<script>alert(1)</script>',
      blocks: [
        { kind: 'text', text: 'a "quote" & <b>' },
        { kind: 'facts', title: '<t>', rows: [['<l>', '<v>']] },
        { kind: 'list', title: '<t>', items: ['<i>'] },
      ],
      reason: '<r>',
      origin: ORIGIN,
    })
    expect(email.html).not.toMatch(/<script|<b>|<t>|<l>|<v>|<i>|<r>|<p>/)
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(email.text).toContain('<script>alert(1)</script>')
  })

  it('refuses links that are not http(s)', () => {
    expect(() =>
      renderEmail({
        subject: 'x',
        preheader: '',
        heading: 'x',
        blocks: [{ kind: 'button', label: 'Go', url: 'javascript:alert(1)' }],
        reason: '',
        origin: ORIGIN,
      }),
    ).toThrow(/http/)
  })

  it('keeps caller text from becoming a link, but leaves numbers alone', () => {
    expect(defuseLinks('pay at evil.example now')).toBe('pay at evil.​example now')
    expect(defuseLinks('https://x')).not.toContain('://')
    expect(defuseLinks('$3.50 for 2.5 hours')).toBe('$3.50 for 2.5 hours')
    expect(escapeHtml(`<a href="x">'`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;')
  })
})

describe('call summary', () => {
  it('has the caller, number, summary, next steps, a link and the settings link', () => {
    const email = callEmail(call, ORIGIN)
    expect(email.subject).toBe('Water heater · Priya Shah')
    expect(email.text).toContain('Maya answered · Tue 9:00 AM · 3 min')
    expect(email.text).toContain('Caller: Priya Shah')
    expect(email.text).toContain('Number: +1 503 555 0191')
    expect(email.text).toContain('- Call back before noon')
    expect(email.text).toContain('https://desk.example.com/#call/call_1')
    expect(email.html).toContain('href="https://desk.example.com/#call/call_1"')
    expect(email.html).toContain('href="https://desk.example.com/#settings/notifications"')
    expect(email.html).not.toContain('class="ld-badge"')
  })

  it('marks urgent calls in the subject and with a badge, and shows the booking', () => {
    const email = callEmail(
      { ...call, urgent: true, booking: { what: 'Repair visit', when: 'Tuesday, November 17 at 9:00 AM PST' } },
      ORIGIN,
    )
    expect(email.subject).toBe('Urgent: Water heater · Priya Shah')
    expect(email.html).toContain('class="ld-badge"')
    expect(email.text).toContain('Booked\nWhat: Repair visit\nWhen: Tuesday, November 17 at 9:00 AM PST')
  })

  it('escapes and defuses what the caller said', () => {
    const email = callEmail(
      {
        ...call,
        callerName: '<img src=x onerror=alert(1)>',
        title: 'Refund',
        summary: 'Wants us to visit pay.evil.example <b>now</b>',
      },
      ORIGIN,
    )
    expect(email.html).not.toMatch(/<img|<b>now/)
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(email.html).not.toContain('pay.evil.example')
    expect(email.text).not.toContain('pay.evil.example')
  })

  it('falls back when the caller is unknown and nothing was summarized', () => {
    const email = callEmail({ ...call, callerName: null, title: null, summary: null, nextSteps: [] }, ORIGIN)
    expect(email.subject).toBe('New call · +1 503 555 0191')
    expect(email.text).toContain('Caller: Unknown caller')
    expect(email.text).not.toContain('Next steps')
  })
})

describe('sign-in code', () => {
  it('shows the code large, says not to share it and when it expires, and has no link', () => {
    const email = signInCodeEmail('482913', ORIGIN)
    expect(email.subject).toBe('482913 is your Linedesk sign-in code')
    expect(email.html).toMatch(/font-size:34px[^>]*>482913</)
    expect(email.text).toContain("Don't share this code")
    expect(email.text).toContain('expires in 10 minutes')
    expect(email.text).not.toMatch(/https?:\/\//)
    expect(email.html).not.toMatch(/href=/)
  })
})

describe('invitation', () => {
  it('names who invited, links to accept and says how long it works', () => {
    const email = invitationEmail(
      {
        inviter: 'Mike Brennan',
        workspace: 'Brightwater Plumbing & Heating',
        email: 'sam@example.com',
        url: `${ORIGIN}/?invite=abc`,
        days: 7,
      },
      ORIGIN,
    )
    expect(email.subject).toBe('Join Brightwater Plumbing & Heating on Linedesk')
    expect(email.html).toContain('Brightwater Plumbing &amp; Heating')
    expect(email.html).toContain('href="https://desk.example.com/?invite=abc"')
    expect(email.text).toContain('The link works for 7 days')
  })
})

describe('passkey notice', () => {
  it('says what changed and what to do if it was not you', () => {
    const email = passkeyChangedEmail('added', ORIGIN)
    expect(email.subject).toBe('A passkey was added to your Linedesk account')
    expect(email.text).toContain('Reset passkeys')
    expect(email.html).toContain('href="https://desk.example.com/#account/security"')
  })
})

describe('booking confirmation', () => {
  const booking = {
    business: 'Brightwater Plumbing & Heating',
    what: 'repair visit',
    when: 'Tuesday, November 17 at 9:00 AM PST',
    minutes: 60,
    address: '12 Oak St, Portland',
    phone: '+15035550100',
  }

  it('carries the business, the time with its zone, the address and how to change it, and no link', () => {
    const email = bookingConfirmationEmail(booking, ORIGIN)
    expect(email.subject).toBe(
      'Confirmed: your repair visit with Brightwater Plumbing & Heating, Tuesday, November 17 at 9:00 AM PST',
    )
    expect(email.text).toContain('When: Tuesday, November 17 at 9:00 AM PST')
    expect(email.text).toContain('Length: 60 minutes')
    expect(email.text).toContain('Where: 12 Oak St, Portland')
    expect(email.text).toContain('call Brightwater Plumbing & Heating at +1 503 555 0100')
    expect(email.html).not.toMatch(/href=/)
    expect(email.text).not.toMatch(/https?:\/\//)
  })

  it('leaves out what it does not know', () => {
    const email = bookingConfirmationEmail({ ...booking, minutes: null, address: null, phone: null }, ORIGIN)
    expect(email.text).not.toMatch(/Length|Where/)
    expect(email.text).toContain('call Brightwater Plumbing & Heating back')
  })
})
