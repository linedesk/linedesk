import { expect, test } from 'vitest'
import { mailServiceFromEnv, smtpOf } from './email-services.ts'

test('each mail service becomes an SMTP URL on port 587 with STARTTLS required, values encoded', () => {
  expect(smtpOf('resend', { api_key: 're_1/2' })?.url).toBe(
    'smtp://resend:re_1%2F2@smtp.resend.com:587?requireTLS=true',
  )
  expect(smtpOf('postmark', { server_token: 'tok' })?.url).toBe(
    'smtp://tok:tok@smtp.postmarkapp.com:587?requireTLS=true',
  )
  expect(smtpOf('sendgrid', { api_key: 'SG.x' })?.url).toBe('smtp://apikey:SG.x@smtp.sendgrid.net:587?requireTLS=true')
  expect(smtpOf('brevo', { login: 'a@smtp-brevo.com', smtp_key: 'k' })?.url).toBe(
    'smtp://a%40smtp-brevo.com:k@smtp-relay.brevo.com:587?requireTLS=true',
  )
  expect(smtpOf('mailgun', { smtp_user: 'u', smtp_password: 'p', region: 'EU' })?.url).toBe(
    'smtp://u:p@smtp.eu.mailgun.org:587?requireTLS=true',
  )
  expect(smtpOf('mailgun', { smtp_user: 'u', smtp_password: 'p' })?.url).toBe(
    'smtp://u:p@smtp.mailgun.org:587?requireTLS=true',
  )
})

test('every preset: smtp:// on 587 (never 465, blocked on some hosts) and STARTTLS required', () => {
  const values = {
    api_key: 'k',
    server_token: 't',
    login: 'l',
    smtp_key: 'k',
    smtp_user: 'u',
    smtp_password: 'p',
    address: 'desk@gmail.com',
    app_password: 'p',
  }
  for (const provider of ['resend', 'postmark', 'sendgrid', 'brevo', 'mailgun', 'gmail'] as const) {
    const url = new URL(smtpOf(provider, values)!.url)
    expect([provider, url.protocol, url.port, url.searchParams.get('requireTLS')]).toEqual([
      provider,
      'smtp:',
      '587',
      'true',
    ])
  }
})

test('Gmail: the app password without its spaces, sent from the address unless From is set', () => {
  expect(smtpOf('gmail', { address: 'desk@gmail.com', app_password: 'abcd efgh ijkl mnop' })).toEqual({
    url: 'smtp://desk%40gmail.com:abcdefghijklmnop@smtp.gmail.com:587?requireTLS=true',
    from: 'desk@gmail.com',
  })
  expect(smtpOf('gmail', { address: 'desk@gmail.com', app_password: 'x', from: 'Desk <desk@gmail.com>' })?.from).toBe(
    'Desk <desk@gmail.com>',
  )
})

test('a missing needed field or a provider that is no mail service gives nothing', () => {
  expect(smtpOf('resend', {})).toBeNull()
  expect(smtpOf('gmail', { address: 'desk@gmail.com' })).toBeNull()
  expect(smtpOf('smtp', { url: 'smtps://x' })).toBeNull()
})

test('at start: plain SMTP_URL stays; else the first service set up; a pick wins and is never replaced', () => {
  const env = {
    SMTP_URL: 'smtps://u:p@mail.example.com:465',
    RESEND_API_KEY: 're_1',
    GMAIL_ADDRESS: 'a@gmail.com',
    GMAIL_APP_PASSWORD: 'p',
  }
  expect(mailServiceFromEnv(null, env)).toBeNull()
  expect(mailServiceFromEnv(null, { ...env, SMTP_URL: undefined })?.url).toContain('smtp.resend.com')
  expect(mailServiceFromEnv('gmail', env)?.url).toContain('smtp.gmail.com')
  expect(mailServiceFromEnv('postmark', env)).toBeNull()
  expect(mailServiceFromEnv(null, {})).toBeNull()
})
