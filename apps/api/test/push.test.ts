// Web Push: members subscribe their own browsers per workspace, the subscription never comes back
// and is redacted in the command log, pushes carry only who called (plus one line when opted in),
// and subscriptions go when a member leaves, is removed or is disabled, or the push service drops them.
import { pushDeviceId } from '@linedesk/actions'
import { calls, commands, member, push_subscriptions, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import type { PgBoss } from 'pg-boss'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import webpush from 'web-push'
import { db } from '../src/db.ts'
import { CALL_PUSH, setJobQueue } from '../src/jobs.ts'
import {
  MAX_PUSH_DEVICES,
  notifyCallPush,
  type PushPayload,
  type PushSender,
  type PushTarget,
  pushAgent,
  pushPayload,
  pushSenderFromEnv,
  setPushSender,
} from '../src/push.ts'
import { act, addMember, agent, createWorkspace, getCall, randomNumber, type User, type Workspace } from './helpers.ts'

const endpointFor = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}-${crypto.randomUUID()}`
const keys = { p256dh: 'BPublicKeyOfTheBrowser', auth: 'authSecret' }

function fakeSender(gone: (endpoint: string) => boolean = () => false) {
  const sent: { to: string; payload: PushPayload }[] = []
  const sender: PushSender = {
    publicKey: 'test-vapid-public-key',
    send: async (target: PushTarget, payload) => {
      if (gone(target.endpoint)) return 'gone'
      sent.push({ to: target.endpoint, payload })
      return 'sent'
    },
  }
  return { sent, sender }
}

async function subscribe(who: User, name = 'browser') {
  const endpoint = endpointFor(name)
  expect((await act(who, 'push.subscribe', { endpoint, keys })).status).toBe(200)
  return endpoint
}

async function callIn(ws: Workspace, finish: Record<string, unknown> = {}) {
  const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  await act(agent(ws.id), 'call.finish', {
    callId: body.data.callId,
    title: 'Leak under the kitchen sink',
    summary: 'Water on the floor, wants someone today.',
    ...finish,
  })
  return (await getCall(body.data.callId))!
}

const rowsOf = (who: User) => db.select().from(push_subscriptions).where(eq(push_subscriptions.user_id, who.userId))

beforeEach(() => setPushSender(fakeSender().sender))
afterEach(() => {
  setPushSender(null)
  setJobQueue(null)
})

describe('subscriptions', () => {
  test('a member subscribes their browser; notifications.get lists only its id, never the endpoint', async () => {
    const ws = await createWorkspace('Push Plumbing')
    const endpoint = await subscribe(ws.owner)
    const { push } = (await act(ws.owner, 'notifications.get', {})).body.data
    expect(push).toEqual({
      publicKey: 'test-vapid-public-key',
      devices: [await pushDeviceId(endpoint)],
      summary: false,
    })
    expect(JSON.stringify(push)).not.toContain('fcm.googleapis.com')

    // Again (the browser re-subscribed): still one row.
    await act(ws.owner, 'push.subscribe', { endpoint, keys })
    expect(await rowsOf(ws.owner)).toHaveLength(1)
  })

  test('the endpoint and keys are redacted in the command log', async () => {
    const ws = await createWorkspace('Redacted Push Plumbing')
    const endpoint = await subscribe(ws.owner)
    const logged = await db
      .select()
      .from(commands)
      .where(and(eq(commands.actor_id, ws.owner.userId), eq(commands.action, 'push.subscribe')))
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged[0]!.input)).not.toContain(endpoint)
    expect(JSON.stringify(logged[0]!.input)).not.toContain(keys.auth)
  })

  test('only endpoints of the known push services; the agent cannot subscribe; nothing without VAPID keys', async () => {
    const ws = await createWorkspace('Rules Push Plumbing')
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://push.example.com/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilpush.apple.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user@fcm.googleapis.com/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
    ])
      expect((await act(ws.owner, 'push.subscribe', { endpoint, keys })).status, endpoint).toBe(422)
    for (const endpoint of [
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/x',
      'https://wns2-db5p.notify.windows.com/w/?token=x',
    ])
      expect((await act(ws.owner, 'push.subscribe', { endpoint, keys })).status, endpoint).toBe(200)
    expect((await act(agent(ws.id), 'push.subscribe', { endpoint: endpointFor('agent'), keys })).status).toBe(403)
    setPushSender({ publicKey: null, send: async () => 'sent' })
    const off = await act(ws.owner, 'push.subscribe', { endpoint: endpointFor('off'), keys })
    expect(off.status).toBe(409)
    expect((await act(ws.owner, 'notifications.get', {})).body.data.push.publicKey).toBeNull()
  })

  test('a browser that someone else used before belongs to the new person only; other keys touch nothing', async () => {
    const ws = await createWorkspace('Shared Browser Plumbing')
    const colleague = await addMember(ws.id, 'member')
    const endpoint = await subscribe(colleague)
    // Someone who knows the endpoint but not the browser's keys cannot take it over or delete it.
    const forged = await act(ws.owner, 'push.subscribe', { endpoint, keys: { p256dh: 'BOtherKey', auth: 'other' } })
    expect(forged.status).toBe(409)
    expect(await rowsOf(colleague)).toHaveLength(1)
    // The same subscription (same keys): the browser changed hands without a sign-out.
    await act(ws.owner, 'push.subscribe', { endpoint, keys })
    expect(await rowsOf(colleague)).toHaveLength(0)
    expect(await rowsOf(ws.owner)).toHaveLength(1)
  })

  test(`at most ${MAX_PUSH_DEVICES} browsers per member and workspace: the oldest goes; subscribing is rate-limited`, async () => {
    const ws = await createWorkspace('Many Devices Plumbing')
    const endpoints: string[] = []
    for (let i = 0; i < MAX_PUSH_DEVICES + 2; i++) endpoints.push(await subscribe(ws.owner, `device${i}`))
    const kept = (await rowsOf(ws.owner)).map(r => r.endpoint).sort()
    expect(kept).toEqual(endpoints.slice(2).sort())

    // 20 per hour per person; the next is refused.
    for (let i = MAX_PUSH_DEVICES + 2; i < 20; i++) await subscribe(ws.owner, `more${i}`)
    const refused = await act(ws.owner, 'push.subscribe', { endpoint: endpointFor('one-too-many'), keys })
    expect(refused).toMatchObject({ status: 409, body: { error: expect.stringMatching(/too many/) } })
    // Someone else is not affected.
    await subscribe(await addMember(ws.id, 'member'))
  })

  test('API keys cannot subscribe or unsubscribe', async () => {
    const ws = await createWorkspace('Key Push Plumbing')
    const created = await act(ws.owner, 'apiKey.create', { name: 'Zapier', role: 'admin' })
    const bearer = { headers: { authorization: `Bearer ${created.body.data.key}` } }
    const endpoint = await subscribe(ws.owner)
    expect(await act(bearer, 'push.subscribe', { endpoint: endpointFor('key'), keys })).toMatchObject({ status: 403 })
    expect(await act(bearer, 'push.unsubscribe', { endpoint, everywhere: true })).toMatchObject({ status: 403 })
    expect(await rowsOf(ws.owner)).toHaveLength(1)
  })

  test("unsubscribe: this workspace only, or everywhere (sign-out); never someone else's", async () => {
    const ws = await createWorkspace('Unsub Plumbing')
    const second = await createWorkspace('Unsub Second Plumbing')
    const endpoint = await subscribe(ws.owner)
    // The same browser in the owner's second workspace (a tab there subscribes the same way).
    await db.insert(push_subscriptions).values({ workspace_id: second.id, user_id: ws.owner.userId, endpoint, ...keys })
    expect(await rowsOf(ws.owner)).toHaveLength(2)

    const colleague = await addMember(ws.id, 'member')
    await act(colleague, 'push.unsubscribe', { endpoint, everywhere: true })
    expect(await rowsOf(ws.owner)).toHaveLength(2)

    await act(ws.owner, 'push.unsubscribe', { endpoint })
    expect((await rowsOf(ws.owner)).map(r => r.workspace_id)).toEqual([second.id])
    await act(ws.owner, 'push.subscribe', { endpoint, keys })
    await act(ws.owner, 'push.unsubscribe', { endpoint, everywhere: true })
    expect(await rowsOf(ws.owner)).toHaveLength(0)
  })

  test('leaving, removal and a disabled account end the subscriptions', async () => {
    const ws = await createWorkspace('Leave Push Plumbing')
    const leaver = await addMember(ws.id, 'member')
    const removed = await addMember(ws.id, 'member')
    const disabled = await addMember(ws.id, 'member')
    for (const who of [leaver, removed, disabled]) await subscribe(who)

    expect((await act(leaver, 'team.leave', { deleteAccount: false })).status).toBe(200)
    expect(await rowsOf(leaver)).toHaveLength(0)

    const [target] = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, ws.id), eq(member.userId, removed.userId)))
    expect((await act(ws.owner, 'team.removeMember', { memberId: target!.id })).status).toBe(200)
    expect(await rowsOf(removed)).toHaveLength(0)

    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, disabled.userId))
    const { sender, sent } = fakeSender()
    await notifyCallPush(db, sender, (await callIn(ws)).id, 'finished')
    expect(sent).toEqual([])
  })
})

describe('sending', () => {
  test('in parallel, a few at a time; a push service that does not answer times out without holding up the rest', async () => {
    const ws = await createWorkspace('Parallel Push Plumbing')
    const slow = await subscribe(ws.owner, 'slow')
    for (let i = 0; i < 5; i++) await subscribe(ws.owner, `fast${i}`)
    let inFlight = 0
    let most = 0
    const sender: PushSender = {
      publicKey: 'test-vapid-public-key',
      send: async target => {
        inFlight++
        most = Math.max(most, inFlight)
        // Never answers; counts as in flight until the deadline frees its slot.
        if (target.endpoint === slow) return new Promise(() => setTimeout(() => inFlight--, 200))
        await new Promise(resolve => setTimeout(resolve, 20))
        inFlight--
        return 'sent'
      },
    }
    const started = Date.now()
    const result = await notifyCallPush(db, sender, (await callIn(ws)).id, 'finished', {
      timeoutMs: 200,
      concurrency: 2,
    })
    expect(result).toEqual({ sent: 5, gone: 0, failed: 1 })
    expect(most).toBe(2)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('the real sender refuses endpoints off the allow-list, and its connection refuses private addresses', async () => {
    const vapid = webpush.generateVAPIDKeys()
    const real = pushSenderFromEnv({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey })
    const target = { endpoint: 'https://169.254.169.254/latest/meta-data', keys }
    expect(
      await real.send(
        target,
        pushPayload(
          {
            id: 'call_1',
            from_number: '+15035550100',
            urgency: 'normal',
            outcome: null,
            title: null,
            summary: null,
            action_items: [],
          },
          'finished',
          null,
          false,
        ),
      ),
    ).toBe('gone')

    const agent = pushAgent((_host, callback) => callback(null, [{ address: '10.0.0.5', family: 4 }]))
    const lookup = (
      agent as unknown as { options: { lookup: (h: string, o: object, cb: (e: Error | null) => void) => void } }
    ).options.lookup
    const error = await new Promise<Error | null>(resolve => lookup('fcm.googleapis.com', {}, resolve))
    expect(error).toMatchObject({ code: 'EPRIVATEADDRESS' })
  })

  test('who called only, unless the member opted in to one line on what about', async () => {
    const ws = await createWorkspace('Payload Push Plumbing')
    const reader = await addMember(ws.id, 'member')
    const plain = await subscribe(ws.owner)
    const withSummary = await subscribe(reader)
    expect((await act(reader, 'notifications.update', { pushSummary: true })).status).toBe(200)
    expect((await act(reader, 'notifications.get', {})).body.data.push.summary).toBe(true)

    const call = await callIn(ws, { urgency: 'urgent' })
    const { sender, sent } = fakeSender()
    expect(await notifyCallPush(db, sender, call.id, 'finished')).toEqual({ sent: 2, gone: 0, failed: 0 })
    const to = (endpoint: string) => sent.find(s => s.to === endpoint)!.payload
    expect(to(plain)).toEqual({
      callId: call.id,
      kind: 'finished',
      urgent: true,
      title: expect.stringMatching(/^Urgent call from \+1 503/),
      body: '',
    })
    expect(to(withSummary).body).toBe('Leak under the kitchen sink')
    expect(JSON.stringify(sent)).not.toContain('Water on the floor')
  })

  test('test calls and spam send nothing; a gone subscription is deleted; other workspaces never get it', async () => {
    const ws = await createWorkspace('Skip Push Plumbing')
    const other = await createWorkspace('Other Push Plumbing')
    await subscribe(other.owner)
    const gone = await subscribe(ws.owner, 'gone')
    const kept = await subscribe(ws.owner, 'kept')
    const { sender, sent } = fakeSender(endpoint => endpoint === gone)

    const testCall = await callIn(ws)
    await db.update(calls).set({ source: 'test' }).where(eq(calls.id, testCall.id))
    expect((await notifyCallPush(db, sender, testCall.id, 'finished')).skipped).toBe('test')
    const spam = await callIn(ws, { outcome: 'spam' })
    expect((await notifyCallPush(db, sender, spam.id, 'finished')).skipped).toBe('spam')

    expect(await notifyCallPush(db, sender, (await callIn(ws)).id, 'finished')).toEqual({ sent: 1, gone: 1, failed: 0 })
    expect(sent.map(s => s.to)).toEqual([kept])
    expect((await rowsOf(ws.owner)).map(r => r.endpoint)).toEqual([kept])
  })

  test('urgent flag, message taken and the end of a call each queue a push, the urgent one once', async () => {
    const ws = await createWorkspace('Queue Push Plumbing')
    const send = vi.fn(async (_name: string, _data: object, _options: object) => 'job-id')
    setJobQueue({ send } as unknown as PgBoss)
    const pushes = () => send.mock.calls.filter(([name]) => name === CALL_PUSH).map(([, data]) => data)
    const { body } = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
    const callId = body.data.callId
    await act(agent(ws.id), 'call.flagUrgent', { callId })
    await act(agent(ws.id), 'call.flagUrgent', { callId })
    expect((await getCall(callId))!.urgency).toBe('urgent')
    await act(agent(ws.id), 'call.takeMessage', { callId, message: 'Call back about the leak' })
    await act(agent(ws.id), 'call.finish', { callId })
    expect(pushes()).toEqual([
      { callId, kind: 'urgent' },
      { callId, kind: 'message' },
      { callId, kind: 'finished' },
    ])
  })
})

test('the payload: message and new-call titles, one line cut at 120 characters', () => {
  const call = {
    id: 'call_1',
    from_number: '+15035550191',
    urgency: 'normal' as const,
    outcome: null,
    title: null,
    summary: `${'Long summary '.repeat(20)}\nsecond line`,
    action_items: [{ text: 'Please call back about the quote' }],
  }
  expect(pushPayload(call, 'message', 'Priya Shah', true)).toEqual({
    callId: 'call_1',
    kind: 'message',
    urgent: false,
    title: 'Message from Priya Shah',
    body: 'Please call back about the quote',
  })
  // The call ended with a message: the last push still says so.
  expect(pushPayload({ ...call, outcome: 'message' }, 'finished', 'Priya Shah', false).title).toBe(
    'Message from Priya Shah',
  )
  const finished = pushPayload({ ...call, action_items: [] }, 'finished', null, true)
  expect(finished.title).toBe('New call from +1 503 555 0191')
  expect(finished.body.length).toBeLessThanOrEqual(120)
  expect(finished.body).not.toContain('\n')
  expect(pushPayload(call, 'finished', null, false).body).toBe('')
})
