// White-label S5 PR 5.2 (host-sessions.ts, docs/white-label.md "Own address"): sessions bound to the address they were
// made on, a partner's address reaching only that partner's client workspaces, the account's own settings and a
// workspace owner's done on the install's own address, and Better Auth answering only what a client needs there. Writes
// partner addresses, which turn the host check on for the whole install: an instance-wide file (vitest.config.ts).
import { actions } from '@linedesk/actions'
import { session } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace, request, type User } from './helpers.ts'
import { addDomain, makeClient, makePartner, onHost, signInOn } from './partner-hosts.ts'

const HOST = 'app.bound-agency.test'
const ORIGIN = `https://${HOST}`
const OTHER_HOST = 'app.other-bound-agency.test'
const MAIN_HOST = 'localhost:5173'
const MAIN = 'http://localhost:5173'

let partnerId: string
let client: Awaited<ReturnType<typeof createWorkspace>>
let otherClient: Awaited<ReturnType<typeof createWorkspace>>
let own: Awaited<ReturnType<typeof createWorkspace>>
/** The client's owner, signed in on the partner's address; also a member of a workspace of no partner and of another
 * partner's client. */
let here: User
let onOther: User

const sessionRow = async (who: User) => {
  const token = decodeURIComponent(who.headers.cookie!.split('session_token=')[1]!.split(';')[0]!).split('.')[0]!
  return (await db.select().from(session).where(eq(session.token, token)))[0]
}

beforeAll(async () => {
  partnerId = await makePartner()
  const otherPartner = await makePartner()
  await addDomain(partnerId, HOST, 'active')
  await addDomain(otherPartner, OTHER_HOST, 'active')
  client = await createWorkspace('Bound Client')
  await makeClient(client.id, partnerId)
  otherClient = await createWorkspace('Other Partner Client')
  await makeClient(otherClient.id, otherPartner)
  own = await createWorkspace('No Partner')
  for (const workspace of [otherClient, own])
    await auth.api.addMember({ body: { userId: client.owner.userId, organizationId: workspace.id, role: 'admin' } })
  here = await signInOn(HOST, client.owner)
  onOther = await signInOn(OTHER_HOST, client.owner)
})

describe('a session works only on the address it was made on', () => {
  test('the session row holds the address; one made on the install’s own holds none', async () => {
    expect((await sessionRow(here))?.host).toBe(HOST)
    expect((await sessionRow(onOther))?.host).toBe(OTHER_HOST)
    expect((await sessionRow(client.owner))?.host).toBeNull()
  })

  test('a cookie made on the partner’s address is refused on the install’s own and on another partner’s', async () => {
    expect((await onHost(HOST, '/v1/me', { who: here })).status).toBe(200)
    for (const host of [MAIN_HOST, OTHER_HOST]) {
      const res = await onHost(host, '/v1/me', { who: here, origin: host === MAIN_HOST ? MAIN : `https://${host}` })
      expect(res.status, host).toBe(401)
      expect(await res.json(), host).toMatchObject({ code: 'signed_out' })
    }
    // And the install's own cookie on the partner's address.
    expect((await onHost(HOST, '/v1/me', { who: client.owner })).status).toBe(401)
  })

  test('replayed on the install’s own address, it changes nothing about the account', async () => {
    const replay = { ...here, headers: { ...here.headers, origin: MAIN } }
    // Better Auth's endpoints: the session, a passkey, the email, the other sessions, deleting the account.
    for (const [method, path, body] of [
      ['GET', '/api/auth/get-session', undefined],
      ['GET', '/api/auth/passkey/generate-register-options', undefined],
      ['POST', '/api/auth/change-email', { newEmail: 'taken-over@linedesk.test' }],
      ['POST', '/api/auth/revoke-other-sessions', {}],
      ['POST', '/api/auth/delete-user', {}],
    ] as const) {
      const res = await request(replay, method, path, body)
      expect(res.status, path).toBe(401)
    }
    // The routes that read the session themselves: a first password, a workspace of one's own.
    expect((await request(replay, 'POST', '/v1/account/password', { newPassword: 'taken-over-1234' })).status).toBe(401)
    expect((await request(replay, 'POST', '/v1/signup', {})).status).toBe(401)
    // The owner's own session is untouched.
    expect((await request(client.owner, 'GET', '/v1/me')).status).toBe(200)
  })
})

describe('on a partner’s address only that partner’s client workspaces', () => {
  test('the app opens the client; the workspace list shows only the partner’s', async () => {
    const me = await (await onHost(HOST, '/v1/me', { who: here })).json()
    expect(me.workspace?.id ?? me.workspaceId).toBe(client.id)
    const ids = (me.workspaces as { id: string }[]).map(w => w.id)
    expect(ids).toEqual([client.id])
    const listed = (await (await onHost(HOST, '/v1/me/workspaces', { who: here })).json()) as { id: string }[]
    expect(listed.map(w => w.id)).toEqual([client.id])
  })

  test('another workspace of the same person is not there, by header, switch or icon', async () => {
    for (const workspace of [own, otherClient]) {
      const res = await onHost(HOST, '/v1/actions/call.markRead', {
        who: here,
        origin: ORIGIN,
        body: { callId: workspace.call.id },
        headers: { 'x-workspace-id': workspace.id },
      })
      expect(res.status, workspace.id).toBe(403)
      expect(await res.json()).toMatchObject({ code: 'workspace_access_lost' })
      const switched = await onHost(HOST, '/api/auth/organization/set-active', {
        who: here,
        origin: ORIGIN,
        body: { organizationId: workspace.id },
      })
      expect(switched.status, workspace.id).toBe(403)
      expect(await switched.json()).toMatchObject({ code: 'other_partner' })
      expect((await onHost(HOST, `/v1/workspace-icons/${workspace.id}.png`, { who: here })).status).toBe(404)
    }
    // Switching to the partner's own client is fine.
    expect(
      (
        await onHost(HOST, '/api/auth/organization/set-active', {
          who: here,
          origin: ORIGIN,
          body: { organizationId: client.id },
        })
      ).status,
    ).toBe(200)
  })

  test('someone with no client workspace of this partner gets nothing there', async () => {
    const outsider = await signInOn(HOST, own.owner)
    const res = await onHost(HOST, '/v1/me', { who: outsider })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'no_workspace' })
  })

  test('no API key, personal key or agent token works there', async () => {
    const made = await act(client.owner, 'apiKey.create', { name: 'Bound', role: 'admin' })
    expect(made.status).toBe(200)
    const key = made.body.data.key as string
    const keyed = await onHost(HOST, '/v1/me', { headers: { authorization: `Bearer ${key}` } })
    expect(keyed.status).toBe(401)
    expect((await request({ headers: { authorization: `Bearer ${key}` } }, 'GET', '/v1/me')).status).toBe(200)
    const token = agent().headers.authorization!
    expect((await onHost(HOST, '/v1/me', { headers: { authorization: token } })).status).toBe(401)
  })
})

describe('the account’s own settings and a workspace owner’s are the install’s own address’s', () => {
  test('every account:own, secondFactor:own and workspace:own action is refused with main_host_only', async () => {
    const refused = [...actions.values()].filter(def =>
      ['account:own', 'secondFactor:own', 'workspace:own'].includes(def.permission),
    )
    expect(refused.map(def => def.name)).toEqual(
      expect.arrayContaining([
        'personalKey.create',
        'account.authenticatorStart',
        'team.transferOwnership',
        'workspace.removePartner',
        'workspace.deleteOwn',
      ]),
    )
    // The authenticator's confirm and check run only through their own route (refused below), never as actions.
    for (const def of refused.filter(
      d => !['account.authenticatorConfirm', 'account.authenticatorCheck'].includes(d.name),
    )) {
      const res = await onHost(HOST, `/v1/actions/${def.name}`, { who: here, origin: ORIGIN, body: {} })
      expect(res.status, def.name).toBe(404)
      expect(await res.json(), def.name).toMatchObject({ code: 'main_host_only' })
    }
    // On the install's own address the owner still reaches them (here: the delete preview).
    expect((await act(client.owner, 'workspace.deletePreview', {})).status).toBe(200)
  })

  test('the password and authenticator routes are refused before they run', async () => {
    for (const path of [
      '/v1/account/password',
      '/v1/account/authenticator/confirm',
      '/v1/account/authenticator/check',
    ]) {
      const res = await onHost(HOST, path, { who: here, origin: ORIGIN, body: {} })
      expect(res.status, path).toBe(404)
      expect(await res.json(), path).toMatchObject({ code: 'main_host_only' })
    }
  })

  test('Better Auth answers only signing in by code, the session, invitations, switching and the name there', async () => {
    const refused: [string, string, unknown][] = [
      ['POST', '/api/auth/sign-in/email', { email: 'x@linedesk.test', password: 'whatever-1234' }],
      ['POST', '/api/auth/sign-in/social', { provider: 'google' }],
      ['GET', '/api/auth/passkey/generate-authenticate-options', undefined],
      ['GET', '/api/auth/passkey/generate-register-options', undefined],
      ['POST', '/api/auth/change-email', { newEmail: 'new@linedesk.test' }],
      ['POST', '/api/auth/change-password', { currentPassword: 'a', newPassword: 'b' }],
      ['POST', '/api/auth/delete-user', {}],
      ['POST', '/api/auth/revoke-other-sessions', {}],
      ['GET', '/api/auth/list-sessions', undefined],
      ['POST', '/api/auth/email-otp/send-verification-otp', { email: 'x@linedesk.test', type: 'forget-password' }],
      ['POST', '/api/auth/update-user', { name: 'Fine', image: 'https://evil.test/a.png' }],
      ['POST', '/api/auth/organization/set-active', {}],
    ]
    for (const [method, path, body] of refused) {
      const res = await onHost(HOST, path, { method, who: here, origin: ORIGIN, body })
      expect(res.status, path).toBe(404)
      expect(await res.json(), path).toMatchObject({ code: 'main_host_only' })
    }
    // What a client needs works.
    expect((await onHost(HOST, '/api/auth/get-session', { who: here })).status).toBe(200)
    expect(
      (await onHost(HOST, '/api/auth/update-user', { who: here, origin: ORIGIN, body: { name: 'Bound Owner' } }))
        .status,
    ).toBe(200)
  })

  test('the sign-in page there offers email codes only, and names the install’s own address', async () => {
    const methods = await (await onHost(HOST, '/v1/auth-methods')).json()
    expect(methods).toMatchObject({
      password: false,
      passkey: false,
      sso: [],
      selfServeSignup: false,
      setupNeeded: false,
      mainOrigin: MAIN,
    })
    expect((await request({ headers: {} }, 'GET', '/v1/auth-methods')).body.mainOrigin).toBeUndefined()
  })

  test('signing out there ends that session only', async () => {
    const second = await signInOn(HOST, client.owner)
    expect((await onHost(HOST, '/api/auth/sign-out', { who: second, origin: ORIGIN, body: {} })).status).toBe(200)
    expect((await onHost(HOST, '/v1/me', { who: second })).status).toBe(401)
    expect((await onHost(HOST, '/v1/me', { who: here })).status).toBe(200)
  })
})
