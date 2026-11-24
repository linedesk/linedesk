// A white-label partner's brand in workspace emails (docs/white-label.md, S4): inside withEmailBrand every workspace
// email shows the partner's name, links to the partner's origin, has no "Powered by" line and never names this product.
import { describe, expect, it } from 'vitest'
import { envelopeOf, senderLine } from '../email.ts'
import {
  type EmailBrand,
  emailBrandName,
  emailOrigin,
  emailReplyTo,
  withEmailBrand,
  withoutEmailBrand,
} from '../email-brand.ts'
import { previewEmails } from './previews.ts'

const ORIGIN = 'https://desk.cascade.example'

const brand: EmailBrand = {
  branding: {
    name: 'Cascade Desk',
    color: '#0f766e',
    logoUrl: '/v1/branding/partners/p_cascade/logo.png?v=1',
    starPrompt: false,
    starCount: null,
    poweredBy: false,
    partner: {
      id: 'p_cascade',
      supportEmail: 'help@cascade.example',
      terms: 'https://cascade.example/terms',
      privacy: 'https://cascade.example/privacy',
    },
  },
  replyTo: 'help@cascade.example',
  origin: ORIGIN,
}

/**
 * Emails that are not a workspace's: they go to this install's admins (admin alerts, the install test) or to the
 * owner of a bill with this install (the trial's emails and the plan's end: a white-label client is on its partner's
 * bill and never gets them), so they keep the install's brand on purpose.
 */
const INSTALL_ONLY = /^(admin-alert|install-test|trial-|plan-ended)/

describe('partner brand in emails', () => {
  const previews = withEmailBrand(brand, () => previewEmails(ORIGIN))
  const workspaceEmails = previews.filter(({ name }) => !INSTALL_ONLY.test(name))

  it('covers the workspace emails', () => {
    expect(workspaceEmails.length).toBeGreaterThan(30)
  })

  for (const { name, email } of workspaceEmails) {
    it(`${name}: no "Linedesk", no "Powered by", the partner's name and origin`, () => {
      for (const part of [email.subject, email.text, email.html]) {
        expect(part).not.toMatch(/linedesk/i)
        expect(part).not.toMatch(/powered by/i)
      }
      expect(`${email.subject}\n${email.text}`).toContain('Cascade Desk')
      expect(email.html).not.toContain('desk.example.com')
    })
  }

  it('the scope ends with the call', () => {
    withEmailBrand(brand, () => {
      expect(emailBrandName()).toBe('Cascade Desk')
      expect(emailOrigin()).toBe(ORIGIN)
    })
    expect(emailBrandName()).not.toBe('Cascade Desk')
    expect(emailOrigin()).not.toBe(ORIGIN)
  })

  it("leaves the partner's brand for the install's own emails, also when started inside its scope (L-1)", async () => {
    await withEmailBrand(brand, async () => {
      for (const run of [
        <T>(work: () => T) => withoutEmailBrand(work),
        <T>(work: () => T) => withEmailBrand(null, work),
      ]) {
        const seen = await run(async () => {
          await new Promise(resolve => setTimeout(resolve, 1))
          return {
            name: emailBrandName(),
            replyTo: emailReplyTo(),
            from: senderLine('Linedesk <no-reply@mail.example>'),
          }
        })
        expect(seen).toEqual({
          name: expect.not.stringMatching('Cascade'),
          replyTo: null,
          from: 'Linedesk <no-reply@mail.example>',
        })
      }
      // Back in the partner's scope afterwards.
      expect(emailBrandName()).toBe('Cascade Desk')
    })
  })

  it('reaches work started without waiting', async () => {
    const name = await withEmailBrand(brand, async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return emailBrandName()
    })
    expect(name).toBe('Cascade Desk')
  })
})

describe('sender line and Reply-To', () => {
  it("shows the partner's name with the install's address", () => {
    withEmailBrand(brand, () => {
      expect(senderLine('Linedesk <no-reply@mail.example>')).toBe('"Cascade Desk" <no-reply@mail.example>')
      expect(senderLine('no-reply@mail.example')).toBe('"Cascade Desk" <no-reply@mail.example>')
      expect(senderLine(undefined)).toBe('"Cascade Desk" <no-reply@localhost>')
    })
  })

  it('strips quotes and angle brackets from the partner name', () => {
    const odd = { ...brand, branding: { ...brand.branding, name: 'Cas"cade <Desk>' } }
    withEmailBrand(odd, () => {
      expect(senderLine('no-reply@mail.example')).toBe('"Cascade Desk" <no-reply@mail.example>')
    })
  })

  it("sets Reply-To to the partner's support email unless the email names its own", () => {
    withEmailBrand(brand, () => {
      expect(envelopeOf({}, 'no-reply@mail.example')).toEqual({
        from: '"Cascade Desk" <no-reply@mail.example>',
        replyTo: 'help@cascade.example',
      })
      expect(envelopeOf({ replyTo: 'mike@brightwater.example' }, 'no-reply@mail.example').replyTo).toBe(
        'mike@brightwater.example',
      )
    })
    withEmailBrand({ ...brand, replyTo: null }, () => {
      expect(envelopeOf({}, 'no-reply@mail.example')).not.toHaveProperty('replyTo')
    })
  })

  it("outside a partner scope: the install's From, no Reply-To", () => {
    expect(senderLine('Linedesk <no-reply@mail.example>')).toBe('Linedesk <no-reply@mail.example>')
    expect(envelopeOf({}, 'Linedesk <no-reply@mail.example>')).toEqual({ from: 'Linedesk <no-reply@mail.example>' })
  })
})
