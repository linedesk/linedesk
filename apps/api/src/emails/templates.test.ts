import { afterEach, describe, expect, it } from 'vitest'
import { setBrandingInMemory } from '../branding.ts'
import { defuseLinks, escapeHtml, renderEmail } from './layout.ts'
import { previewEmails } from './previews.ts'
import {
  appLink,
  assignedCallEmail,
  bookingConfirmationEmail,
  type CallEmail,
  callEmail,
  emailChangeCodeEmail,
  emailChangeConfirmCurrentEmail,
  emailChangedEmail,
  emailChangeRefusedEmail,
  firstCallEmail,
  invitationEmail,
  passkeyChangedEmail,
  passwordChangedEmail,
  passwordResetCodeEmail,
  readPartnerDirectoryUrl,
  type SetupEmail,
  setupDay0Email,
  setupNudgeEmail,
  signInCodeEmail,
  weekSummaryEmail,
  workspaceDeletedEmail,
} from './templates.ts'

const ORIGIN = 'https://desk.example.com'

const call: CallEmail = {
  workspaceId: 'ws_1',
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

describe('Powered by Linedesk', () => {
  afterEach(() => setBrandingInMemory({}))
  const LINK = 'https://linedesk.ai/?utm_source=powered-by&amp;utm_medium=email'

  it('is not added while the install looks like Linedesk', () => {
    const email = signInCodeEmail('123456', ORIGIN)
    expect(email.html).not.toContain('Powered by')
    expect(email.text).not.toContain('Powered by')
  })

  it('ends the footer of every email when the install has its own name', () => {
    setBrandingInMemory({ name: 'Front Desk Pro' })
    for (const { name, email } of previewEmails(ORIGIN)) {
      expect(email.html, name).toContain(`Powered by <a href="${LINK}"`)
      expect(email.text, name).toContain(
        'Powered by Linedesk: https://linedesk.ai/?utm_source=powered-by&utm_medium=email',
      )
    }
  })

  it('also with only its own logo', () => {
    setBrandingInMemory({ logoVersion: 'abc123' })
    expect(signInCodeEmail('123456', ORIGIN).html).toContain('Powered by')
  })

  it('is left out when the admin hid it', () => {
    setBrandingInMemory({ name: 'Front Desk Pro', poweredBy: false })
    const email = signInCodeEmail('123456', ORIGIN)
    expect(email.html).toContain('Front Desk Pro')
    expect(email.html).not.toContain('Powered by')
    expect(email.text).not.toContain('linedesk.ai')
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
    expect(email.text).toContain('https://desk.example.com/#call/call_1?ws=ws_1')
    expect(email.html).toContain('href="https://desk.example.com/#call/call_1?ws=ws_1"')
    expect(email.html).toContain('href="https://desk.example.com/#account/notifications?ws=ws_1"')
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

describe('links into the app name their workspace', () => {
  it('appLink adds the workspace to the hash, after a query the path already has', () => {
    expect(appLink(ORIGIN, 'ws_1', 'call/call_1')).toBe('https://desk.example.com/#call/call_1?ws=ws_1')
    expect(appLink(ORIGIN, 'ws_1', 'calls?q=leak')).toBe('https://desk.example.com/#calls?q=leak&ws=ws_1')
    expect(appLink(ORIGIN, 'a b&c', 'calls')).toBe('https://desk.example.com/#calls?ws=a%20b%26c')
  })

  const setup: SetupEmail = {
    workspaceId: 'ws_1',
    workspace: 'Brightwater Plumbing & Heating',
    assistantName: 'Maya',
    numberId: 'pn_1',
    number: '+15035550142',
    takesAllCalls: false,
    step: 'forwarding',
  }
  const assigned = assignedCallEmail(
    { ...call, assignedBy: 'Mike Brennan', workspace: 'Brightwater Plumbing & Heating' },
    ORIGIN,
  )
  const week = { ...setup, calls: 3, urgent: 1, booked: 1, messages: 1 }

  it.each([
    ['call', callEmail(call, ORIGIN)],
    ['first call', firstCallEmail(call, ORIGIN)],
    ['assigned call', assigned],
    ['setup day 0', setupDay0Email(setup, ORIGIN)],
    ['setup day 1', setupNudgeEmail(1, setup, ORIGIN)],
    ['setup day 3', setupNudgeEmail(3, setup, ORIGIN, null, 'https://partners.example.com')],
    ['week summary', weekSummaryEmail(week, ORIGIN)],
  ])('%s: every link to the app carries ws=', (_name, email) => {
    const appLinks = [...email.html.matchAll(/href="(https:\/\/desk\.example\.com\/[^"]*)"/g)].map(m => m[1]!)
    expect(appLinks.length).toBeGreaterThan(0)
    for (const link of appLinks) expect(link).toMatch(/#[^"]*[?&]ws=ws_1$/)
  })

  it('setup emails open the next step in their workspace, like the go-live checklist', () => {
    expect(setupDay0Email(setup, ORIGIN).html).toContain('href="https://desk.example.com/#workspace/phone/pn_1?ws=ws_1"')
    const noNumber = { ...setup, numberId: null, number: null, step: 'number' as const }
    expect(setupDay0Email(noNumber, ORIGIN).html).toContain('href="https://desk.example.com/#workspace/phone?ws=ws_1"')
    const firstCall = setupNudgeEmail(1, { ...setup, step: 'first_call' }, ORIGIN)
    expect(firstCall.html).toContain('href="https://desk.example.com/#calls?ws=ws_1"')
    expect(firstCall.text).toContain('Open your inbox')
    // A teammate who takes transferred calls is one of the business's own phones: only a friend's phone is suggested.
    expect(firstCall.text).not.toContain('colleague')
  })
})

describe('partner directory', () => {
  const setup: SetupEmail = {
    workspaceId: 'ws_1',
    workspace: 'Brightwater Plumbing & Heating',
    assistantName: 'Maya',
    numberId: null,
    number: null,
    takesAllCalls: false,
    step: 'number',
  }

  it('day 3 offers a partner only when the install has a directory', () => {
    const withDirectory = setupNudgeEmail(3, setup, ORIGIN, null, 'https://partners.example.com')
    expect(withDirectory.text).toContain('Find a partner')
    expect(withDirectory.html).toContain('href="https://partners.example.com"')
    const without = setupNudgeEmail(3, setup, ORIGIN, null, null)
    expect(without.text).not.toContain('partner')
    expect(setupNudgeEmail(1, setup, ORIGIN, null, 'https://partners.example.com').text).not.toContain('partner')
  })

  it('PARTNER_DIRECTORY_URL: unset is none, an http(s) link is used, anything else fails at start', () => {
    expect(readPartnerDirectoryUrl({})).toBeNull()
    expect(readPartnerDirectoryUrl({ PARTNER_DIRECTORY_URL: '  ' })).toBeNull()
    expect(readPartnerDirectoryUrl({ PARTNER_DIRECTORY_URL: 'https://linedesk.ai/partners' })).toBe(
      'https://linedesk.ai/partners',
    )
    expect(() => readPartnerDirectoryUrl({ PARTNER_DIRECTORY_URL: 'javascript:alert(1)' })).toThrow()
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

describe('password reset', () => {
  it('the code email shows the code, says what it is for and has no link', () => {
    const email = passwordResetCodeEmail('815302', ORIGIN)
    expect(email.subject).toBe('815302 is your Linedesk password reset code')
    expect(email.html).toMatch(/font-size:34px[^>]*>815302</)
    expect(email.text).toContain('choose a new password')
    expect(email.text).toContain('expires in 10 minutes')
    expect(email.text).not.toMatch(/https?:\/\//)
    expect(email.html).not.toMatch(/href=/)
  })

  it('the notice says the password changed, everyone was signed out, and what to do if it was not you', () => {
    const email = passwordChangedEmail(ORIGIN)
    expect(email.subject).toBe('The password of your Linedesk account was changed')
    expect(email.text).toContain('signed out everywhere')
    expect(email.text).toContain('secure your mailbox')
    expect(email.html).toContain('href="https://desk.example.com/#account/security"')
  })
})

describe('email change', () => {
  it('the code email shows the code, says what it is for and has no link', () => {
    const email = emailChangeCodeEmail('604218', ORIGIN)
    expect(email.subject).toBe('604218 is your Linedesk code to change your email')
    expect(email.html).toMatch(/font-size:34px[^>]*>604218</)
    expect(email.text).toContain('Account settings on desk.example.com')
    expect(email.text).toContain('expires in 10 minutes')
    expect(email.text).not.toMatch(/https?:\/\//)
    expect(email.html).not.toMatch(/href=/)
  })

  it('the current address gets a code to confirm it is them, and what to do if it was not', () => {
    const email = emailChangeConfirmCurrentEmail('381940', ORIGIN)
    expect(email.subject).toBe("381940 is your Linedesk code to confirm it's you")
    expect(email.html).toMatch(/font-size:34px[^>]*>381940</)
    expect(email.text).toContain('wants to change its email address')
    expect(email.text).toContain("If it wasn't you, don't enter the code")
    expect(email.html).not.toMatch(/href=/)
  })

  it('a taken address is told it cannot be used, without a code', () => {
    const email = emailChangeRefusedEmail(ORIGIN)
    expect(email.subject).toBe("This address can't be used for another Linedesk account")
    expect(email.text).toContain('nothing was changed')
    expect(email.text).not.toMatch(/\d{6}/)
  })

  it('the old address is told the new one, as plain text, and what to do if it was not them', () => {
    const email = emailChangedEmail('new.owner@evil.example', ORIGIN)
    expect(email.subject).toBe('The email of your Linedesk account was changed')
    expect(email.text).toContain('other sessions were signed out')
    expect(email.text).toContain('If it was not you')
    expect(email.html).not.toContain('href="mailto:')
    expect(email.text).not.toContain('evil.example')
    expect(email.text).toContain(defuseLinks('new.owner@evil.example'))
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

describe('workspace deleted', () => {
  const base = { workspace: 'Brightwater Plumbing', by: 'Mike Brennan', when: 'November 14, 2026 at 9:05 AM PST' }
  it('says who deleted it and when, and that the account went with it', () => {
    const email = workspaceDeletedEmail({ ...base, accountDeleted: true }, ORIGIN)
    expect(email.subject).toBe('Brightwater Plumbing was deleted on Linedesk')
    expect(email.text).toContain(
      'Mike Brennan deleted the workspace Brightwater Plumbing on November 14, 2026 at 9:05 AM PST.',
    )
    expect(email.text).toContain('account at desk.example.com was deleted with it')
    expect(email.text).not.toContain('stay as they are')
  })
  it('tells members of other workspaces that their account stays', () => {
    const email = workspaceDeletedEmail({ ...base, accountDeleted: false }, ORIGIN)
    expect(email.text).toContain('Your account and your other workspaces stay as they are.')
    expect(email.text).not.toContain('was deleted with it')
  })
})
