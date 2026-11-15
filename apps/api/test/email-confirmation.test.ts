import { account, api_keys, assistants, auth_events, calendar_connections, member, passkey, phone_numbers, session, user, webhook_endpoints } from '@linedesk/db'
import { DEFAULT_TRANSFERS } from '@linedesk/db/types'
import { APIError } from 'better-auth/api'
import { and, eq } from 'drizzle-orm'
import { afterEach, expect, test, vi } from 'vitest'
import {
  dropUnprovenAccessOf,
  endSessionsAfterEmailLink,
  refuseSessionWithoutItsSignIn,
} from '../src/account-linking.ts'
import { mustConfirmEmail } from '../src/auth-methods.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { NEEDS_CONFIRMED_EMAIL } from '../src/run-action.ts'
import { auth, confirmationCodeEmail } from '../src/auth.ts'
import { addressBucket, CLIENT_IP_HEADER } from '../src/client-ip.ts'
import { codeFailures, countSignInFailures, limitSignIns } from '../src/sign-in-limits.ts'
import { act, anonymous, createWorkspace, FROM, randomIp, request, signUp } from './helpers.ts'

afterEach(() => vi.restoreAllMocks())

/** A transfer contact with a number and the number forwarding every call, as someone could have set them up before confirmation was required. */
const PLANTED_CONTACT = {
  id: 'oncall', name: 'On-call', number: '+15035550142', condition: 'Urgent', hours_only: false,
  ring_seconds: 25, if_no_answer: 'message' as const, enabled: true,
}
const plantCallRouting = async (ws: { assistant: { id: string }; number: string }) => {
  await db.update(assistants).set({ transfers: [PLANTED_CONTACT] }).where(eq(assistants.id, ws.assistant.id))
  await db.update(phone_numbers).set({ mode: 'forward_all' }).where(eq(phone_numbers.e164, ws.number))
}
const callRoutingOf = async (ws: { assistant: { id: string }; number: string }) => {
  const [a] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  const [n] = await db.select().from(phone_numbers).where(eq(phone_numbers.e164, ws.number))
  return { transfers: a!.transfers, mode: n!.mode }
}
const PLANTED = { transfers: [PLANTED_CONTACT], mode: 'forward_all' }

const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } })

test('unconfirmed members cannot perform sensitive actions, and their own confirmation preserves access', async () => {
  const ws = await createWorkspace('Confirmation')
  expect((await act(ws.owner, 'apiKey.create', { name: 'Existing', role: 'admin' })).status).toBe(200)
  await db.update(user).set({ emailVerified: false }).where(eq(user.id, ws.owner.userId))
  const [owner] = await db.select().from(user).where(eq(user.id, ws.owner.userId))
  expect((await request(ws.owner, 'GET', '/v1/me')).body.emailUnconfirmed).toBe(true)
  for (const action of NEEDS_CONFIRMED_EMAIL) {
    expect(await act(ws.owner, action, {})).toMatchObject({ status: 403, body: { code: 'EMAIL_NOT_VERIFIED' } })
  }
  // Calendar connections, forwarding and the call export are in the list; the assistant's warm transfer is refused only when it is set.
  for (const action of ['calendar.connectStart', 'calendar.connectFinish', 'phoneNumber.update', 'call.export'])
    expect(NEEDS_CONFIRMED_EMAIL).toContain(action)
  const assistantId = ws.assistant.id
  const contact = { ...PLANTED_CONTACT, number: '+15035550199' }
  for (const transfer of [{ transfers: [contact] }, { transfers: [{ ...contact, hours_only: true }, { ...contact, id: 'b', name: 'B', enabled: false }] }])
    expect(await act(ws.owner, 'assistant.update', { assistantId, ...transfer })).toMatchObject({
      status: 403,
      body: { code: 'EMAIL_NOT_VERIFIED' },
    })
  // Contacts switched off or without a number put nobody through.
  for (const allowed of [{ greeting: 'Hi, Brightwater Plumbing.' }, { transfers: [{ ...contact, enabled: false }] }, { transfers: [{ ...contact, number: null }] }, { transfers: [] }])
    expect((await act(ws.owner, 'assistant.update', { assistantId, ...allowed })).status).toBe(200)
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  await plantCallRouting(ws)
  const sendCode = () =>
    request(
      ws.owner,
      'POST',
      '/api/auth/email-otp/send-verification-otp',
      { email: owner!.email, type: 'email-verification' },
      { [FROM]: randomIp() },
    )
  expect((await sendCode()).status).toBe(200)
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  const otp = send.mock.calls.at(-1)![0].subject.slice(0, 6)
  const before = await db.select().from(account).where(eq(account.userId, ws.owner.userId))
  expect(
    (
      await request(
        ws.owner,
        'POST',
        '/api/auth/email-otp/verify-email',
        { email: owner!.email, otp },
        { [FROM]: randomIp() },
      )
    ).status,
  ).toBe(200)
  expect((await request(ws.owner, 'GET', '/v1/me')).body.emailUnconfirmed).toBe(false)
  // Confirmed in their own session: warm transfer and forwarding stay as they are.
  expect(await callRoutingOf(ws)).toEqual(PLANTED)
  expect(await db.select().from(account).where(eq(account.userId, ws.owner.userId))).toEqual(before)
  expect(await db.select().from(webhook_endpoints).where(eq(webhook_endpoints.id, ws.webhookEndpoint.id))).toHaveLength(
    1,
  )
  const key = await act(ws.owner, 'apiKey.create', { name: 'Confirmed', role: 'admin' })
  expect(key.status).toBe(200)
  expect(await db.select().from(api_keys).where(eq(api_keys.created_by, ws.owner.userId))).toHaveLength(2)
  expect(
    (await db.select().from(api_keys).where(eq(api_keys.created_by, ws.owner.userId))).every(
      key => key.revoked_at === null,
    ),
  ).toBe(true)
  // An already-confirmed account cannot run confirmation again to trigger cleanup.
  expect((await sendCode()).status).toBe(403)
  expect(await db.select().from(api_keys).where(eq(api_keys.created_by, ws.owner.userId))).toHaveLength(2)
})

test('confirmation codes require a session of that address, including when redeeming a valid code', async () => {
  const ws = await createWorkspace('Confirmation isolation')
  await db.update(user).set({ emailVerified: false }).where(eq(user.id, ws.owner.userId))
  const other = await createWorkspace('Other confirmation')
  const [owner] = await db.select().from(user).where(eq(user.id, ws.owner.userId))
  const payload = { email: owner!.email, type: 'email-verification' }
  const extra = () => ({ origin: 'http://localhost:5173', [FROM]: randomIp() })
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  for (const caller of [anonymous, other.owner])
    expect((await request(caller, 'POST', '/api/auth/email-otp/send-verification-otp', payload, extra())).status).toBe(
      403,
    )
  expect(send).not.toHaveBeenCalled()
  expect((await request(ws.owner, 'POST', '/api/auth/email-otp/send-verification-otp', payload, extra())).status).toBe(
    200,
  )
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  const otp = send.mock.calls.at(-1)![0].subject.slice(0, 6)
  for (const caller of [anonymous, other.owner])
    expect(
      (await request(caller, 'POST', '/api/auth/email-otp/verify-email', { email: owner!.email, otp }, extra())).status,
    ).toBe(403)
  expect(
    (await request(ws.owner, 'POST', '/api/auth/email-otp/verify-email', { email: owner!.email, otp }, extra())).status,
  ).toBe(200)
})

test('code sign-in removes legacy access only while the address is unconfirmed', async () => {
  const ws = await createWorkspace('Code recovery')
  expect((await act(ws.owner, 'apiKey.create', { name: 'Legacy', role: 'admin' })).status).toBe(200)
  const [owner] = await db.select().from(user).where(eq(user.id, ws.owner.userId))
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  const signIn = async () => {
    send.mockClear()
    const extra = () => ({ origin: 'http://localhost:5173', [FROM]: randomIp() })
    expect(
      (
        await request(
          anonymous,
          'POST',
          '/api/auth/email-otp/send-verification-otp',
          { email: owner!.email, type: 'sign-in' },
          extra(),
        )
      ).status,
    ).toBe(200)
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    const otp = send.mock.calls.at(-1)![0].subject.slice(0, 6)
    expect(
      (await request(anonymous, 'POST', '/api/auth/sign-in/email-otp', { email: owner!.email, otp }, extra())).status,
    ).toBe(200)
  }
  // Another workspace the account is only a member of keeps its routing.
  const other = await createWorkspace('Not theirs')
  await auth.api.addMember({ body: { userId: ws.owner.userId, organizationId: other.id, role: 'member' } })
  await plantCallRouting(ws)
  await plantCallRouting(other)
  const resets = () => db.select().from(auth_events).where(and(eq(auth_events.user_id, ws.owner.userId), eq(auth_events.event, 'call_routing_reset')))
  const calendarsOf = () =>
    db.select().from(calendar_connections).where(eq(calendar_connections.connected_by, ws.owner.userId))
  await signIn()
  expect(await calendarsOf()).toHaveLength(1)
  // Confirmed already: nothing is reset.
  expect(await callRoutingOf(ws)).toEqual(PLANTED)
  expect(await resets()).toHaveLength(0)
  expect((await db.select().from(api_keys).where(eq(api_keys.created_by, ws.owner.userId)))[0]!.revoked_at).toBeNull()
  expect(
    await db.select().from(webhook_endpoints).where(eq(webhook_endpoints.created_by, ws.owner.userId)),
  ).toHaveLength(1)
  await db.update(user).set({ emailVerified: false }).where(eq(user.id, ws.owner.userId))
  await signIn()
  expect(
    (await db.select().from(api_keys).where(eq(api_keys.created_by, ws.owner.userId)))[0]!.revoked_at,
  ).not.toBeNull()
  expect(
    await db.select().from(webhook_endpoints).where(eq(webhook_endpoints.created_by, ws.owner.userId)),
  ).toHaveLength(0)
  expect(await db.select().from(account).where(eq(account.userId, ws.owner.userId))).toHaveLength(0)
  // A calendar connected before the address was proven would receive bookings with callers' details.
  expect(await calendarsOf()).toHaveLength(0)
  // Warm transfer and forwarding go back to the defaults in the workspace it owns, logged per workspace.
  expect(await callRoutingOf(ws)).toEqual({ transfers: DEFAULT_TRANSFERS, mode: 'forward_conditional' })
  expect((await resets()).map(e => e.workspace_id)).toEqual([ws.id])
  expect(await callRoutingOf(other)).toEqual(PLANTED)
  expect((await request(ws.owner, 'GET', '/v1/me')).status).toBe(401)
})

test("an unconfirmed owner added to someone else's workspace: their first confirmation leaves its call routing alone", async () => {
  // Defense in depth: membership.add invites unconfirmed accounts and a transfer refuses them owner, but an older add
  // could have made one owner. Only the workspaces the account created (it was their first member) are reset. One
  // owner per workspace: the creator is an admin by then.
  const ws = await createWorkspace('Owner Added Later Plumbing')
  const added = await signUp()
  await db.update(member).set({ role: 'admin' }).where(eq(member.organizationId, ws.id))
  await db.insert(member).values({
    id: `m_${crypto.randomUUID().slice(0, 12)}`,
    organizationId: ws.id,
    userId: added.userId,
    role: 'owner',
    createdAt: new Date(Date.now() + 1000),
  })
  const own = await createWorkspace('Own Business', false)
  await plantCallRouting(ws)
  await plantCallRouting(own)
  await dropUnprovenAccessOf(added.userId)
  expect(await callRoutingOf(ws)).toEqual(PLANTED)
  // The creator's own unproven workspace is still reset.
  await dropUnprovenAccessOf(own.owner.userId)
  expect(await callRoutingOf(own)).toEqual({ transfers: DEFAULT_TRANSFERS, mode: 'forward_conditional' })
})

test('an API key whose creator is unconfirmed cannot run sensitive actions; public actions still work', async () => {
  const ws = await createWorkspace('Key of unconfirmed')
  const made = await act(ws.owner, 'apiKey.create', { name: 'Before', role: 'admin' })
  expect(made.status).toBe(200)
  await db.update(user).set({ emailVerified: false }).where(eq(user.id, ws.owner.userId))
  const key = bearer(made.body.data.key)
  // None of them is open to API keys at all (public API only); the email rule stands behind that.
  for (const action of NEEDS_CONFIRMED_EMAIL) expect((await act(key, action, {})).status).toBe(403)
  expect((await act(key, 'call.markNotSpam', { callId: ws.call.id })).status).toBe(200)
})

test('without email delivery nobody is asked to confirm (no code could arrive)', () => {
  expect(mustConfirmEmail(false, { EMAIL_TO_LOG: 'true' })).toBe(true)
  expect(mustConfirmEmail(false, {})).toBe(false)
  expect(mustConfirmEmail(true, { EMAIL_TO_LOG: 'true' })).toBe(false)
})

test('a password sign-in gets no session once a confirmation removed the password (sign-in race)', async () => {
  const ws = await createWorkspace('Race', false)
  const created = { userId: ws.owner.userId }
  const passwordSignIn = { path: '/sign-in/email' }
  await expect(refuseSessionWithoutItsSignIn(created, passwordSignIn)).resolves.toBeUndefined()
  // The code sign-in or the email link removed the password between Better Auth's password check and the session.
  await db.delete(account).where(eq(account.userId, ws.owner.userId))
  await expect(refuseSessionWithoutItsSignIn(created, passwordSignIn)).rejects.toMatchObject({ statusCode: 401 })
  // Other sign-ins (the code itself, a provider) are not affected.
  await expect(refuseSessionWithoutItsSignIn(created, { path: '/sign-in/email-otp' })).resolves.toBeUndefined()
})

test('email link opened elsewhere: a session made during the cleanup goes too; the own session stays', async () => {
  const ws = await createWorkspace('Link race', false)
  const target = { id: ws.owner.userId }
  await endSessionsAfterEmailLink(target, ws.owner.userId)
  expect(await db.select().from(session).where(eq(session.userId, ws.owner.userId))).not.toHaveLength(0)
  await endSessionsAfterEmailLink(target, null)
  expect(await db.select().from(session).where(eq(session.userId, ws.owner.userId))).toHaveLength(0)
  expect((await request(ws.owner, 'GET', '/v1/me')).status).toBe(401)
})

test('wrong confirmation codes count like wrong sign-in codes (per address and network), and block confirming', async () => {
  const ws = await createWorkspace('Wrong confirmation codes', false)
  const [owner] = await db.select().from(user).where(eq(user.id, ws.owner.userId))
  const email = owner!.email.toLowerCase()
  // Addresses rotate inside one IPv6 /64: our limit is per /64 (Better Auth's own allows 3 tries a minute there).
  const net = `2001:db8:${Math.floor(Math.random() * 65536).toString(16)}:7`
  let n = 0
  const post = (path: string, body: object) =>
    request(ws.owner, 'POST', path, { email: owner!.email, ...body }, { [FROM]: `${net}::${++n}` })
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  expect((await post('/api/auth/email-otp/send-verification-otp', { type: 'email-verification' })).status).toBe(200)
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  const otp = send.mock.calls.at(-1)![0].subject.slice(0, 6) as string
  const wrong = otp === '000000' ? '111111' : '000000'
  // Three wrong codes over HTTP count...
  for (let i = 0; i < 3; i++) expect((await post('/api/auth/email-otp/verify-email', { otp: wrong })).status).toBe(400)
  const at = (ip: string, returned?: unknown) =>
    ({ path: '/email-otp/verify-email', body: { email, otp: wrong }, headers: new Headers({ [CLIENT_IP_HEADER]: ip }), context: { returned } }) as never
  // ...so seven more make ten: confirming from that network is refused, from another one it is not.
  for (let i = 0; i < 7; i++) await countSignInFailures(at(`${net}::${100 + i}`, new APIError('BAD_REQUEST', { code: 'INVALID_OTP' })))
  expect(codeFailures.blocked(`${email}|${addressBucket(`${net}::1`)}`)).toBe(true)
  await expect(limitSignIns(at(`${net}::200`))).rejects.toMatchObject({ statusCode: 429 })
  // From another network the same address passes the limit (and meets the session check: this call has no session).
  await expect(limitSignIns(at('198.51.100.77'))).rejects.toMatchObject({ statusCode: 403 })
})

test('a passkey sign-in gets no session once a confirmation removed every passkey (sign-in race)', async () => {
  const ws = await createWorkspace('Passkey race', false)
  const created = { userId: ws.owner.userId }
  const passkeySignIn = { path: '/passkey/verify-authentication' }
  await db
    .insert(passkey)
    .values({
      id: `pk_${crypto.randomUUID().slice(0, 12)}`,
      userId: ws.owner.userId,
      publicKey: 'cHVibGlj',
      credentialID: `cred-${crypto.randomUUID()}`,
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
    })
  await expect(refuseSessionWithoutItsSignIn(created, passkeySignIn)).resolves.toBeUndefined()
  await db.delete(passkey).where(eq(passkey.userId, ws.owner.userId))
  await expect(refuseSessionWithoutItsSignIn(created, passkeySignIn)).rejects.toMatchObject({ statusCode: 401 })
})

test('the confirmation email names the site and warns not to share the code', () => {
  const mail = confirmationCodeEmail('123456', { PUBLIC_URL: 'https://desk.brightwater.test' })
  expect(mail.subject).toBe('123456 is your Linedesk confirmation code')
  expect(mail.text).toContain('https://desk.brightwater.test')
  expect(mail.text).toContain("Don't share this code with anyone; Linedesk staff will never ask for it.")
})
