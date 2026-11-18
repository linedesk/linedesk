import { expect, test, vi } from 'vitest'
import { idempotencyKeyOf, ResendError, resendKeyCheck, resendProblem, resendSend } from './email-resend.ts'

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

// Every error Resend documents (https://resend.com/docs/api-reference/errors, 2026-11-18) with what it means here: a
// reason marks the install's email as failing and alerts the admins, so only problems of the service get one.
const DOCUMENTED: [number, string, string, string | null][] = [
  [400, 'invalid_idempotency_key', 'Idempotency keys, if present, must have between 1 and 256 characters.', null],
  [400, 'validation_error', 'An error was found with one or more fields in the request.', null],
  [400, 'validation_error', 'API key is invalid', 'auth'],
  [401, 'missing_api_key', 'Missing API Key', 'auth'],
  [401, 'restricted_api_key', 'This API key is restricted to only send emails.', 'permission'],
  [401, 'validation_error', 'API key is invalid', 'auth'],
  [403, 'email_above_quota', "You can't retrieve this email's content because it was above quota when received.", null],
  [403, 'invalid_permission', 'Access token is missing required scopes.', 'permission'],
  [403, 'restricted_api_key', 'API key is not active', 'auth'],
  [403, 'suspended_api_key', 'This API key is suspended', 'auth'],
  [
    403,
    'validation_error',
    'You can only send testing emails to your own email address (owner@x.example). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.',
    'config',
  ],
  [403, 'validation_error', 'The `example.com` domain is not verified. Please, add and verify your domain.', 'config'],
  [403, 'validation_error', 'The `example.com` domain has been registered already.', null],
  [403, 'validation_error', 'You have reached the inboxes included in your plan.', null],
  [404, 'not_found', 'The requested endpoint does not exist.', null],
  [405, 'method_not_allowed', 'Method is not allowed for the requested path.', null],
  [409, 'concurrent_idempotent_requests', 'There is another request in progress with the same idempotency key.', null],
  [409, 'invalid_idempotent_request', 'This idempotency key has been used with this HTTP method and endpoint.', null],
  [409, 'resource_locked', 'Another request is already updating this resource.', null],
  [409, 'forge_not_enabled', 'Forge is not enabled on this domain.', null],
  [422, 'forge_unavailable', 'Forge is not available for this domain.', null],
  [422, 'invalid_attachment', 'Attachment must have either a `content` or `path`.', null],
  [422, 'invalid_parameter', 'The `parameter` must be a valid UUID.', null],
  [422, 'missing_required_field', 'The request body is missing one or more required fields.', null],
  [422, 'missing_required_parameter', 'The request is missing one or more required parameters.', null],
  [422, 'return_path_unavailable', 'The requested return path cannot be used for Forge.', null],
  [429, 'daily_quota_exceeded', 'You have exceeded your daily email sending quota.', 'quota'],
  [429, 'monthly_quota_exceeded', 'You have exceeded your monthly email sending quota.', 'quota'],
  [429, 'rate_limit_exceeded', 'Too many requests. Please limit the number of requests per second.', 'network'],
  [500, 'application_error', 'An unexpected error occurred.', 'network'],
  [503, 'dns_lookup_failed', 'Could not check DNS for the requested host.', 'network'],
  [503, 'service_unavailable', 'API is temporarily unavailable', 'network'],
]

test.each(DOCUMENTED)('Resend %i %s (%s) → %s', async (status, name, message, reason) => {
  expect((await problemOf(status, { statusCode: status, name, message }))[0]).toBe(reason)
})

test('one bad email is never a problem of the service: a 422 by its name only, a 403 only about the sending setup', async () => {
  // A recipient-domain or From validation error mentions "domain", "from" or "sender": still about this email.
  for (const message of [
    'Invalid `to` field. The email address needs to follow the `email@example.com` format.',
    'Invalid `from` field. The domain part is not a valid domain.',
    'The sender domain of `to` could not be resolved.',
  ])
    expect(await problemOf(422, { name: 'validation_error', message })).toEqual([
      null,
      'Resend did not accept this email (HTTP 422).',
    ])
  // A 403 that names a domain or a sender but is not about verification or test-only sending: this email only.
  expect(
    (await problemOf(403, { name: 'validation_error', message: 'Recipient domain blocked by the sender policy.' }))[0],
  ).toBeNull()
  expect((await problemOf(403, 'not json'))[0]).toBeNull()
  // Key errors stay key errors, whatever the status.
  expect((await problemOf(403, { name: 'invalid_api_key', message: 'The domain is not verified' }))[0]).toBe('auth')
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

test('an error code in the message only when it is a fixed code, never free text', async () => {
  const failing = (code: unknown) =>
    vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code } })
    }) as unknown as typeof fetch
  const messageOf = async (code: unknown) =>
    (await resendKeyCheck('re_secret', 1000, failing(code)).catch((e: ResendError) => e)) as ResendError
  expect((await messageOf('UND_ERR_CONNECT_TIMEOUT')).params).toEqual({ error: 'UND_ERR_CONNECT_TIMEOUT' })
  for (const code of ['mike@x.example', 'ECONN REFUSED', 'econnrefused', 'A'.repeat(41), '', 42, undefined]) {
    const problem = await messageOf(code)
    expect(problem.params).toEqual({ error: 'error' })
    expect(problem.message).toContain('(error)')
  }
})

test('a job retry of the same email carries the same Idempotency-Key, so Resend does not send it twice', async () => {
  const sent: Headers[] = []
  const bodies: string[] = []
  const accept = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(new Headers(init.headers))
    bodies.push(String(init.body))
    return new Response(JSON.stringify({ id: 'e1' }), { status: 200 })
  }) as unknown as typeof fetch
  const email = { from: 'a@b.example', to: 'c@d.example', subject: 's', text: 't' }
  await resendSend('re_secret', { ...email, retryScope: 'job-1' }, 1000, accept)
  await resendSend('re_secret', { ...email, retryScope: 'job-1' }, 1000, accept)
  await resendSend('re_secret', { ...email, to: 'e@f.example', retryScope: 'job-1' }, 1000, accept)
  await resendSend('re_secret', { ...email, retryScope: 'job-2' }, 1000, accept)
  await resendSend('re_secret', email, 1000, accept)
  const keys = sent.map(h => h.get('idempotency-key'))
  // Same job, same email: the same key. Another recipient or another job: another key. No job: no key.
  expect(keys[0]).toBe(keys[1])
  expect(new Set(keys.slice(1, 4)).size).toBe(3)
  expect(keys[4]).toBeNull()
  // Resend takes 1 to 256 characters; the key never shows the job id, the address or the key.
  expect(keys[0]).toMatch(/^linedesk-[0-9a-f]{64}$/)
  expect(keys[0]).toBe(
    idempotencyKeyOf('job-1', JSON.stringify({ from: 'a@b.example', to: ['c@d.example'], subject: 's', text: 't' })),
  )
  // The scope never reaches Resend in the body; the other headers stay.
  expect(bodies[0]).not.toContain('job-1')
  expect(sent[0]!.get('authorization')).toBe('Bearer re_secret')
  expect(sent[0]!.get('content-type')).toBe('application/json')
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
