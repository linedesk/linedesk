// What the voice agent may do: only its own actions and the booking tools, only in a workspace
// that is not disabled, and with a call token only for that call (docs/architecture.md, agent token).
import { REDACTED } from '@linedesk/actions'
import { commands, organization } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { CALL_TOKEN_TTL_MS, issueCallToken, verifyCallToken } from '../src/agent-token.ts'
import { db } from '../src/db.ts'
import { act, agent, createWorkspace, randomNumber, request, type Workspace } from './helpers.ts'

let ws: Workspace
let other: Workspace

beforeAll(async () => {
  ws = await createWorkspace('Agent Scope')
  other = await createWorkspace('Agent Scope Other')
})

/** A phone call in `w` opened by the agent: its id and call token. */
async function startCall(w: Workspace) {
  const { status, body } = await act(agent(), 'call.start', { from: randomNumber(), to: w.number })
  expect(status).toBe(200)
  return { callId: body.data.callId as string, token: body.data.callToken as string }
}

const withToken = (token: string, workspaceId?: string) => agent(workspaceId, token)

describe('the agent role', () => {
  test.each([
    ['call.delete', () => ({ callId: ws.call.id })],
    ['call.markRead', () => ({ callId: ws.call.id })],
    ['call.assign', () => ({ callId: ws.call.id, userId: ws.owner.userId })],
    ['contact.create', () => ({ phone: randomNumber(), note: 'from the agent' })],
    ['contact.update', () => ({ contactId: ws.contact.id, note: 'from the agent' })],
    ['contact.delete', () => ({ contactId: ws.contact.id })],
    ['contact.merge', () => ({ keepId: ws.contact.id, mergeId: ws.contact.id })],
    ['contact.import', () => ({ rows: [{ phone: randomNumber() }] })],
  ])('cannot run the member action %s', async (name, input) => {
    expect((await act(agent(ws.id), name, input())).status).toBe(403)
  })

  test('books, cancels and reschedules only for a call it names', async () => {
    const res = await act(agent(ws.id), 'appointment.cancel', { bookingDate: '2026-11-17', bookedName: 'Dana' })
    expect(res).toMatchObject({
      status: 403,
      body: { error: 'the voice agent runs appointment.cancel only with its callId' },
    })
  })

  test('does nothing in a disabled workspace, with either token', async () => {
    const disabled = await createWorkspace('Agent Scope Disabled')
    const { callId, token } = await startCall(disabled)
    await db.update(organization).set({ disabledAt: new Date() }).where(eq(organization.id, disabled.id))
    expect((await act(agent(disabled.id), 'call.flagUrgent', { callId })).status).toBe(403)
    expect((await act(withToken(token), 'call.flagUrgent', { callId })).status).toBe(403)
    expect((await act(withToken(token), 'calendar.findSlots', { appointmentTypeId: 'at_x' })).status).toBe(403)
  })
})

describe('call tokens', () => {
  test('call.start and call.startTest return one; the command log keeps it redacted', async () => {
    const { callId, token } = await startCall(ws)
    expect(verifyCallToken(token)).toMatchObject({ workspaceId: ws.id, callId })
    const test = await act(agent(ws.id), 'call.startTest', { room: `test-${crypto.randomUUID().slice(0, 8)}` })
    expect(verifyCallToken(test.body.data.callToken)).toMatchObject({
      workspaceId: ws.id,
      callId: test.body.data.callId,
    })
    const stored = (await db.select().from(commands).where(eq(commands.action, 'call.start'))).filter(
      c => c.action === 'call.start' && JSON.stringify(c.result).includes(callId),
    )
    expect((stored[0]!.result as { data: { callToken: string } }).data.callToken).toBe(REDACTED)
  })

  test('works for its own call, without naming the workspace', async () => {
    const { callId, token } = await startCall(ws)
    expect(
      (await act(withToken(token), 'call.appendTranscript', { callId, speaker: 'caller', text: 'Hi', atMs: 10 }))
        .status,
    ).toBe(200)
    expect((await act(withToken(token), 'call.flagUrgent', { callId })).status).toBe(200)
    expect((await act(withToken(token, ws.id), 'call.takeMessage', { callId, message: 'Call me back' })).status).toBe(
      200,
    )
  })

  test('never for another call, another workspace, or to open a call', async () => {
    const mine = await startCall(ws)
    const sameWorkspace = await startCall(ws)
    const elsewhere = await startCall(other)
    expect(await act(withToken(mine.token), 'call.flagUrgent', { callId: sameWorkspace.callId })).toMatchObject({
      status: 403,
      body: { error: 'this call token is for another call' },
    })
    expect((await act(withToken(mine.token), 'call.flagUrgent', { callId: elsewhere.callId })).status).toBe(403)
    expect((await act(withToken(mine.token, other.id), 'call.flagUrgent', { callId: mine.callId })).status).toBe(403)
    expect((await act(withToken(mine.token), 'call.start', { from: randomNumber(), to: ws.number })).status).toBe(403)
  })

  test('a forged, tampered or expired token is refused', async () => {
    const { callId, token } = await startCall(ws)
    const [payload, signature] = token.slice('ldcall_'.length).split('.')
    const otherCall = Buffer.from(JSON.stringify({ w: ws.id, c: 'call_x', e: Date.now() + 60_000 })).toString(
      'base64url',
    )
    for (const bad of [
      `ldcall_${otherCall}.${signature}`,
      `ldcall_${payload}.${signature}x`,
      issueCallToken(ws.id, callId, Date.now() - CALL_TOKEN_TTL_MS - 1000),
      issueCallToken(ws.id, callId, Date.now(), { BETTER_AUTH_SECRET: 'another-secret' }),
    ]) {
      expect((await act(withToken(bad), 'call.flagUrgent', { callId })).status).toBe(401)
    }
  })
})

test('a call token cannot read the provider config; the install-wide token can', async () => {
  const { token } = await startCall(ws)
  expect((await request(withToken(token), 'GET', '/v1/agent/provider-config')).status).toBe(403)
  expect((await request(agent(), 'GET', '/v1/agent/provider-config')).status).toBe(200)
})

test('a call token counts for nothing through the public site', async () => {
  const { callId, token } = await startCall(ws)
  const viaPublic = { headers: { ...withToken(token).headers, 'x-linedesk-entry': 'public' } }
  expect((await act(viaPublic, 'call.flagUrgent', { callId })).status).toBe(401)
  expect((await act(withToken(token), 'call.flagUrgent', { callId })).status).toBe(200)
})
