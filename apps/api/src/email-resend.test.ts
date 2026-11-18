import { expect, test, vi } from 'vitest'
import { ResendError, resendKeyCheck, resendProblem, resendSend } from './email-resend.ts'

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const problemOf = async (status: number, body: unknown) => {
  const problem = await resendProblem(answer(status, body))
  return [problem.reason, problem.message]
}

test("Resend's refusals: a reason for the mail service (or none: about this one email) and words that name the fix", async () => {
  expect(await problemOf(401, { name: 'missing_api_key' })).toEqual([
    'auth',
    'Resend refused the API key (HTTP 401). Enter a valid key under Server admin › Providers › Resend.',
  ])
  expect((await problemOf(403, { name: 'invalid_api_key' }))[0]).toBe('auth')
  expect((await problemOf(401, { name: 'restricted_api_key' }))[0]).toBe('permission')
  // 403 without a key problem: the From domain is not verified (or only test emails are allowed).
  expect(
    await problemOf(403, { name: 'validation_error', message: 'The example.com domain is not verified.' }),
  ).toEqual([
    'config',
    "Resend refused the sender (HTTP 403). Verify the From address's domain in Resend under Domains, or change From under Server admin › Providers › Resend.",
  ])
  expect((await problemOf(422, { name: 'invalid_from_address' }))[0]).toBe('config')
  expect((await problemOf(422, { name: 'validation_error', message: 'Invalid `from` field.' }))[0]).toBe('config')
  expect(await problemOf(422, { name: 'validation_error', message: 'Invalid `to` field.' })).toEqual([
    null,
    'Resend did not accept this email (HTTP 422).',
  ])
  expect(await problemOf(429, { name: 'rate_limit_exceeded' })).toEqual([
    'network',
    'Resend is rate limiting this key (HTTP 429). Try again in a minute.',
  ])
  expect((await problemOf(429, { name: 'daily_quota_exceeded' }))[0]).toBe('quota')
  expect((await problemOf(429, { name: 'monthly_quota_exceeded' }))[0]).toBe('quota')
  expect(await problemOf(500, { name: 'application_error' })).toEqual([
    'network',
    'Resend failed on its side (HTTP 500). If it stays, check status.resend.com.',
  ])
  expect((await problemOf(502, 'not json'))[0]).toBe('network')
})

test("Resend's own text never comes through: it can quote addresses", async () => {
  const [, message] = await problemOf(403, { name: 'validation_error', message: 'You can only send to mike@x.example' })
  expect(message).not.toContain('mike@x.example')
})

test('no answer (a blocked port, DNS, a timeout) is a network problem that names port 443, never the key', async () => {
  const blocked = vi.fn(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  }) as unknown as typeof fetch
  const sent = resendSend(
    're_secret',
    { from: 'a@b.example', to: 'c@d.example', subject: 's', text: 't' },
    1000,
    blocked,
  )
  await expect(sent).rejects.toBeInstanceOf(ResendError)
  await expect(sent).rejects.toMatchObject({
    reason: 'network',
    message:
      'Could not send email: no answer from api.resend.com (ECONNREFUSED). Check that this server may connect to it over HTTPS (port 443).',
  })
  const slow = vi.fn(async () => {
    throw new DOMException('timed out', 'TimeoutError')
  }) as unknown as typeof fetch
  await expect(resendKeyCheck('re_secret', 20_000, slow)).rejects.toMatchObject({
    reason: 'network',
    message: expect.stringMatching(/did not answer within 20 s/),
  })
})

test('the key check: a full-access key lists the domains, a sending-only key passes without them', async () => {
  const listed = vi.fn(async () => answer(200, { data: [{ name: 'example.com', status: 'verified' }] }))
  expect(await resendKeyCheck('re_full', 1000, listed as unknown as typeof fetch)).toEqual({
    domains: [{ name: 'example.com', status: 'verified' }],
  })
  const restricted = vi.fn(async () => answer(401, { name: 'restricted_api_key' }))
  expect(await resendKeyCheck('re_send', 1000, restricted as unknown as typeof fetch)).toEqual({ domains: null })
  const refused = vi.fn(async () => answer(403, { name: 'invalid_api_key' }))
  await expect(resendKeyCheck('re_bad', 1000, refused as unknown as typeof fetch)).rejects.toMatchObject({
    reason: 'auth',
  })
})
