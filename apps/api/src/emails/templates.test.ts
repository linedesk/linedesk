import { afterEach, describe, expect, it } from 'vitest'
import { setBrandingInMemory } from '../branding.ts'
import { defuseLinks, escapeHtml, renderEmail } from './layout.ts'
import { previewEmails } from './previews.ts'
import {
  addedNoticeEmail,
  addedToWorkspaceEmail,
  appLink,
  assignedCallEmail,
  bookingConfirmationEmail,
  type CallEmail,
  callEmail,
  EMAIL_TRANSCRIPT_MAX_CHARS,
  emailChangeCodeEmail,
  emailChangeConfirmCurrentEmail,
  emailChangedEmail,
  emailChangeRefusedEmail,
  firstCallEmail,
  invitationEmail,
  memberAddedByAdminEmail,
  passkeyChangedEmail,
  personalKeyCreatedEmail,
  passkeyEnrolmentIssuedEmail,
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
  fields: [{ label: 'Address', value: '12 Oak St' }],
  booking: null,
  transcript: [
    { speaker: 'agent', text: 'Brightwater, this is Maya. How can I help?' },
    { speaker: 'caller', text: 'No hot water since this morning.' },
    { speaker: 'human', text: 'Hi Priya, Mike here.' },
  ],
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
      locale: 'en',
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
        locale: 'en',
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
    expect(email.text).toContain('Transcript\nMaya: Brightwater, this is Maya. How can I help?\nCaller: No hot water')
  })

  it('has the transcript with speaker names, in both parts', () => {
    const email = callEmail(call, ORIGIN)
    expect(email.text).toContain(
      'Transcript\nMaya: Brightwater, this is Maya. How can I help?\nPriya Shah: No hot water since this morning.\nTeam: Hi Priya, Mike here.',
    )
    expect(email.text).toContain('The recording is in Linedesk.')
    expect(email.html).toContain('<strong>Priya Shah:</strong> No hot water since this morning.')
  })

  it('escapes and defuses what was said in the transcript', () => {
    const email = callEmail(
      { ...call, transcript: [{ speaker: 'caller', text: 'Go to pay.evil.example <script>x</script>' }] },
      ORIGIN,
    )
    expect(email.html).not.toContain('<script>')
    expect(email.html).not.toContain('pay.evil.example')
    expect(email.text).not.toContain('pay.evil.example')
  })

  it('cuts a very long transcript and says the rest is in the app', () => {
    const line = { speaker: 'caller' as const, text: 'x'.repeat(1000) }
    const email = callEmail({ ...call, transcript: Array.from({ length: 40 }, () => line) }, ORIGIN)
    expect(email.text.match(/Priya Shah: x+/g)).toHaveLength(EMAIL_TRANSCRIPT_MAX_CHARS / 1000)
    expect(email.text).toContain('The rest of the call is in the transcript in the app.')
  })

  it('has the key facts under the summary and a Call back button for the caller ID', () => {
    const email = callEmail(call, ORIGIN)
    expect(email.text).toContain('No hot water since this morning.\n\nKey facts\nAddress: 12 Oak St')
    expect(email.text).toContain('Call back: +15035550191')
    expect(email.html).toContain('href="tel:+15035550191"')
  })

  it('without caller ID or facts: no Call back button, no Key facts', () => {
    const email = callEmail({ ...call, fromNumber: 'anonymous', fields: [{ label: 'Note', value: ' ' }] }, ORIGIN)
    expect(email.html).not.toContain('tel:')
    expect(email.text).not.toContain('Call back:')
    expect(email.text).not.toContain('Key facts')
  })

  it('without a transcript says it is in the app', () => {
    const email = callEmail({ ...call, transcript: [] }, ORIGIN)
    expect(email.text).not.toContain('Transcript\n')
    expect(email.text).toContain('The recording and the transcript are in Linedesk.')
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
    expect(setupDay0Email(setup, ORIGIN).html).toContain(
      'href="https://desk.example.com/#workspace/phone/pn_1?ws=ws_1"',
    )
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
  const LINK = `${ORIGIN}/#sign-in=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ`
  afterEach(() => setBrandingInMemory({}))

  it('without a link: shows the code large, says not to share it and when it expires, and has no link', () => {
    const email = signInCodeEmail('482913', ORIGIN)
    expect(email.subject).toBe('482913 is your Linedesk sign-in code')
    expect(email.html).toMatch(/font-size:34px[^>]*>482913</)
    expect(email.text).toContain("Don't share this code")
    expect(email.text).toContain('expires in 10 minutes')
    expect(email.text).not.toMatch(/https?:\/\//)
    expect(email.html).not.toMatch(/href=/)
  })

  it('with a link: the button first, then "Or enter this code", the smaller code, expiry and the do-not-share line', () => {
    const email = signInCodeEmail('482913', ORIGIN, 'en', LINK)
    expect(email.subject).toBe('482913 is your Linedesk sign-in code')
    // The only link in the card is the button, to the site the email names.
    expect([...email.html.matchAll(/href="([^"]*)"/g)].map(m => m[1])).toEqual([LINK])
    expect(email.html).toContain('>Sign in to Linedesk</a>')
    const button = email.html.indexOf('>Sign in to Linedesk</a>')
    const orCode = email.html.indexOf('Or enter this code on the sign-in page at desk.example.com:')
    // Under a button the code is the fallback: smaller than on its own (34px), in a quiet outline, not a filled box.
    const code = email.html.search(/font-size:22px[^>]*>482913</)
    expect(email.html).not.toMatch(/font-size:34px/)
    expect(email.html).toMatch(/border:1px solid #E7E4DE;[^>]*font-size:22px;[^>]*letter-spacing:4px;[^>]*>482913</)
    const note = email.html.lastIndexOf('expires in 10 minutes')
    expect(button).toBeGreaterThan(0)
    expect(orCode).toBeGreaterThan(button)
    expect(code).toBeGreaterThan(orCode)
    expect(note).toBeGreaterThan(code)
    expect(email.text).toContain(`Sign in to Linedesk:\n${LINK}`)
    expect(email.text).toContain("Don't share this code")
    // The button works in any browser (mail apps often open links elsewhere): no same-browser rule is told.
    expect(email.text).not.toMatch(/browser where you asked/i)
  })

  it("the button names the install's own product name", () => {
    setBrandingInMemory({ name: 'Front Desk Pro' })
    expect(signInCodeEmail('482913', ORIGIN, 'en', LINK).html).toContain('>Sign in to Front Desk Pro</a>')
  })

  it('from the sign-up page: confirm the email to finish signing up, never "Sign in"', () => {
    const email = signInCodeEmail('482913', ORIGIN, 'en', `${ORIGIN}/signup#sign-in=abc`, { signUp: true })
    expect(email.subject).toBe('482913 is your code to finish signing up for Linedesk')
    expect(email.html).toContain('Confirm your email')
    expect(email.html).toContain('>Confirm my email</a>')
    const button = email.html.indexOf('>Confirm my email</a>')
    const code = email.html.search(/font-size:22px[^>]*>482913</)
    expect(code).toBeGreaterThan(button)
    expect(email.html).not.toMatch(/font-size:34px/)
    expect(email.text).toContain('Or enter this code on the sign-up page at desk.example.com:')
    expect(email.text).toContain("Don't share this code")
    expect(email.text).not.toMatch(/sign in/i)
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
    expect(email.text).toContain('User settings on desk.example.com')
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

describe('added to a workspace by an instance admin', () => {
  it('names the workspace, the server and the role, links to join and says how to sign in', () => {
    const email = addedToWorkspaceEmail(
      {
        inviter: 'Mike Brennan',
        workspace: 'Brightwater Plumbing & Heating',
        email: 'sam@example.com',
        url: `${ORIGIN}/?invite=abc`,
        days: 7,
        role: 'owner',
      },
      ORIGIN,
    )
    expect(email.subject).toBe('You were added to Brightwater Plumbing & Heating on desk.example.com')
    expect(email.text).toContain(
      'Mike Brennan added you to Brightwater Plumbing & Heating on desk.example.com as an owner',
    )
    expect(email.html).toContain('href="https://desk.example.com/?invite=abc"')
    expect(email.text).toContain('Enter this email address on the sign-in page')
    expect(email.text).toContain('The link works for 7 days')
  })

  it('tells someone added directly who added them and as what', () => {
    const email = addedNoticeEmail(
      { admin: 'Dana Ops', workspace: 'Brightwater Plumbing', workspaceId: 'ws_1', role: 'admin' },
      ORIGIN,
    )
    expect(email.subject).toBe('You were added to Brightwater Plumbing on desk.example.com')
    expect(email.text).toContain('Dana Ops added you to Brightwater Plumbing on desk.example.com as an admin.')
    expect(email.html).toContain('ws_1')
  })

  it('tells the owners who an instance admin added, and when the person still has to confirm', () => {
    const fields = {
      admin: 'Dana Ops',
      who: 'Sam',
      workspace: 'Brightwater Plumbing',
      workspaceId: 'ws_1',
      role: 'member',
    }
    const added = memberAddedByAdminEmail({ ...fields, pending: false }, ORIGIN)
    expect(added.subject).toBe('Dana Ops added Sam to Brightwater Plumbing')
    expect(added.text).toContain('Dana Ops added Sam to Brightwater Plumbing as a member.')
    expect(added.text).not.toContain('They join once')
    const invited = memberAddedByAdminEmail({ ...fields, pending: true }, ORIGIN)
    expect(invited.text).toContain('They join once they confirm their email address.')
    expect(invited.html).toContain('workspace/team')
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

describe('personal key notice', () => {
  it('names the key, links to the keys and says what to do if it was not you', () => {
    const email = personalKeyCreatedEmail('Laptop <b>CLI</b>', 'ldp_AbCd1234', ORIGIN)
    expect(email.subject).toBe('A personal API key was created for your Linedesk account')
    expect(email.text).toContain('Laptop')
    expect(email.text).toContain('ldp_AbCd1234')
    expect(email.html).not.toContain('<b>CLI</b>')
    expect(email.text).toContain('change your password')
    expect(email.html).toContain('href="https://desk.example.com/#account/apiKeys"')
  })
})

describe('passkey enrolment code issued', () => {
  it('says who issued it, that nothing ended, and to tell the admins if unasked', () => {
    const email = passkeyEnrolmentIssuedEmail('ann@example.com', ORIGIN)
    expect(email.subject).toBe('A passkey enrolment code was issued for your Linedesk account')
    expect(email.text).toContain('ann@example.com issued a one-time code for the first passkey')
    expect(email.text).toContain('Nothing was removed and you are still signed in')
    expect(email.text).toMatch(/If you did not ask for this, tell the other administrators/)
    expect(email.text).not.toMatch(/signed you out|Sign in again/)
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
  it('removed: says who removed them, that the workspace stays and that their account was deleted (LIN-264)', () => {
    const email = workspaceDeletedEmail({ ...base, accountDeleted: true, removed: true }, ORIGIN)
    expect(email.subject).toBe('You were removed from Brightwater Plumbing on Linedesk')
    expect(email.text).toContain(
      'Mike Brennan removed you from the workspace Brightwater Plumbing on November 14, 2026 at 9:05 AM PST.',
    )
    expect(email.text).toContain('account at desk.example.com was deleted too')
    expect(email.text).not.toContain('deleted the workspace')
  })
})

describe('confirming an address', () => {
  it('goes by code only: no email carries the "Confirm your email" link (/verify-email is off)', () => {
    const emails = previewEmails(ORIGIN)
    expect(emails.map(e => e.name)).not.toContain('verify-email')
    for (const { name, email } of emails) {
      expect(email.text, name).not.toMatch(/verify-email/)
      expect(email.html, name).not.toMatch(/verify-email/)
    }
  })
})

describe('in the recipient language', () => {
  // The subject and the plain-text part of every email, in English and in one target language: a changed text or a
  // lost translation shows in the diff. Update with `vitest -u` after a deliberate change.
  for (const locale of ['en', 'es'] as const) {
    it(`${locale}: every email's subject and text`, () => {
      const emails = previewEmails(ORIGIN, locale).map(({ name, email }) => [name, email.subject, email.text])
      expect(emails).toMatchSnapshot()
    })
  }

  it('sets <html lang> and keeps English for an unknown language', () => {
    expect(previewEmails(ORIGIN, 'ja')[0]!.email.html).toContain('<html lang="ja"')
    expect(previewEmails(ORIGIN, 'xx')[0]!.email.html).toContain('<html lang="en"')
  })
})

describe('trial emails', () => {
  const byName = (name: string) => previewEmails(ORIGIN).find(e => e.name === name)!.email
  it('the trial-minutes emails: the first sentence adds to the heading, never repeats it; not labelled Billing', () => {
    for (const name of ['trial-minutes-low', 'trial-minutes-used']) {
      const email = byName(name)
      const [, body] = email.text.split(email.subject)
      expect(body, name).not.toContain(email.subject)
      expect(email.html, name).toContain('Your free trial')
      expect(email.html, name).not.toMatch(/>Billing</)
    }
    expect(byName('trial-minutes-low').text).toContain('10 minutes are left.')
    expect(byName('trial-minutes-low').text).toContain(
      'Your plan stays free until December 1, 2026. Minutes beyond the included ones cost $0.05 each.',
    )
  })
  it('the day-3 nudge is about the setup, not billing', () => {
    expect(byName('trial-setup-nudge').html).toContain('Your setup')
  })
})
