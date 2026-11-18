import { expect, test } from 'vitest'
import { mailConnectionOf, mailServiceFromEnv, resendApiKeyOf } from './email-services.ts'

test('Resend sends through its HTTPS API (port 443, not blocked like SMTP), the key encoded', () => {
  const url = mailConnectionOf('resend', { api_key: 're_1/2' })!.url
  expect(url).toBe('https://resend:re_1%2F2@api.resend.com')
  expect(resendApiKeyOf(url)).toBe('re_1/2')
})

test("only a Resend API connection sends over HTTPS: every SMTP URL, the SMTP provider's included, stays SMTP", () => {
  expect(resendApiKeyOf('smtp://resend:re_1@smtp.resend.com:587?requireTLS=true')).toBeNull()
  expect(resendApiKeyOf('smtps://u:p@mail.example.com:465')).toBeNull()
  expect(resendApiKeyOf('https://resend:re_1@api.example.com')).toBeNull()
  expect(resendApiKeyOf('https://api.resend.com')).toBeNull()
  expect(resendApiKeyOf('not a url')).toBeNull()
})

test('each other mail service becomes an SMTP URL on port 587 with STARTTLS required, values encoded', () => {
  expect(mailConnectionOf('postmark', { server_token: 'tok' })?.url).toBe(
    'smtp://tok:tok@smtp.postmarkapp.com:587?requireTLS=true',
  )
  expect(mailConnectionOf('sendgrid', { api_key: 'SG.x' })?.url).toBe(
    'smtp://apikey:SG.x@smtp.sendgrid.net:587?requireTLS=true',
  )
  expect(mailConnectionOf('brevo', { login: 'a@smtp-brevo.com', smtp_key: 'k' })?.url).toBe(
    'smtp://a%40smtp-brevo.com:k@smtp-relay.brevo.com:587?requireTLS=true',
  )
  expect(mailConnectionOf('mailgun', { smtp_user: 'u', smtp_password: 'p', region: 'EU' })?.url).toBe(
    'smtp://u:p@smtp.eu.mailgun.org:587?requireTLS=true',
  )
  expect(mailConnectionOf('mailgun', { smtp_user: 'u', smtp_password: 'p' })?.url).toBe(
    'smtp://u:p@smtp.mailgun.org:587?requireTLS=true',
  )
})

test('every SMTP preset: smtp:// on 587 (never 465, blocked on some hosts) and STARTTLS required', () => {
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
  for (const provider of ['postmark', 'sendgrid', 'brevo', 'mailgun', 'gmail'] as const) {
    const url = new URL(mailConnectionOf(provider, values)!.url)
    expect([provider, url.protocol, url.port, url.searchParams.get('requireTLS')]).toEqual([
      provider,
      'smtp:',
      '587',
      'true',
    ])
  }
})

test('Gmail: the app password without its spaces, sent from the address unless From is set', () => {
  expect(mailConnectionOf('gmail', { address: 'desk@gmail.com', app_password: 'abcd efgh ijkl mnop' })).toEqual({
    url: 'smtp://desk%40gmail.com:abcdefghijklmnop@smtp.gmail.com:587?requireTLS=true',
    from: 'desk@gmail.com',
  })
  expect(
    mailConnectionOf('gmail', { address: 'desk@gmail.com', app_password: 'x', from: 'Desk <desk@gmail.com>' })?.from,
  ).toBe('Desk <desk@gmail.com>')
})

test('a missing needed field or a provider that is no mail service gives nothing', () => {
  expect(mailConnectionOf('resend', {})).toBeNull()
  expect(mailConnectionOf('gmail', { address: 'desk@gmail.com' })).toBeNull()
  expect(mailConnectionOf('smtp', { url: 'smtps://x' })).toBeNull()
})

test('at start: plain SMTP_URL stays; else the first service set up; a pick wins and is never replaced', () => {
  const env = {
    SMTP_URL: 'smtps://u:p@mail.example.com:465',
    RESEND_API_KEY: 're_1',
    GMAIL_ADDRESS: 'a@gmail.com',
    GMAIL_APP_PASSWORD: 'p',
  }
  expect(mailServiceFromEnv(null, env)).toBeNull()
  expect(mailServiceFromEnv(null, { ...env, SMTP_URL: undefined })?.url).toContain('api.resend.com')
  expect(mailServiceFromEnv('gmail', env)?.url).toContain('smtp.gmail.com')
  expect(mailServiceFromEnv('postmark', env)).toBeNull()
  expect(mailServiceFromEnv(null, {})).toBeNull()
})
