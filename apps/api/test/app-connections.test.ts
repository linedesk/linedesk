// Connected apps (HubSpot, docs/crm-sync.md): connect by OAuth, encrypted tokens and their refresh, disconnect with
// revocation, and the push of every finished phone call; who may do it and in which workspace. Handlers run with a
// fake app inside a transaction that is rolled back; permissions and tenancy go through the API.
import { actions, rolePermissions } from '@linedesk/actions'
import {
  type AppConnector,
  AppError,
  type AppOAuth,
  type FinishedCall,
  type OAuthTokens,
  PushSkipped,
} from '@linedesk/connectors'
import { app_connections, app_credentials, app_oauth_states, app_pushes, calls, crm_links, type Tx } from '@linedesk/db'
import { and, eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { appCallback } from '../src/app-callback.ts'
import { type AppServices, appRedirectUri, appSlot, appTokenSource, lockConnection } from '../src/app-connections.ts'
import {
  APP_PUSH_ATTEMPTS,
  attemptAppPush,
  GIVE_UP_AFTER_MS,
  NEEDS_ATTENTION_AFTER,
  SENDING_TIMEOUT_MS,
  sweepAppPushes,
} from '../src/app-pushes.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { runHandler, type Undo } from '../src/handlers.ts'
import { AUDITED_ACTIONS } from '../src/audit.ts'
import { decryptSecret, encryptSecret } from '../src/secrets.ts'
import { act, addMember, agent, createWorkspace, type User, type Workspace } from './helpers.ts'

class Rollback extends Error {}

async function inRollback(body: (tx: Tx) => Promise<void>) {
  await db
    .transaction(async tx => {
      await body(tx)
      throw new Rollback()
    })
    .catch(e => {
      if (!(e instanceof Rollback)) throw e
    })
}

const SCOPE = 'oauth crm.objects.contacts.read crm.objects.contacts.write'

/** A HubSpot portal in memory: OAuth that hands out numbered tokens, and a connector that records what it got. */
function fakeHubSpot({ scope = SCOPE, portal = '42', refreshFails = false } = {}) {
  let issued = 0
  const issue = (refreshToken: string | null): OAuthTokens => ({
    accessToken: `access-${++issued}`,
    refreshToken,
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
    scope,
  })
  const oauth = {
    id: 'hubspot' as const,
    scopes: [],
    authorizeUrl: vi.fn(
      ({ redirectUri, state }: { redirectUri: string; state: string }) =>
        `https://app.hubspot.test/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    ),
    exchangeCode: vi.fn(async ({ code }: { code: string; redirectUri: string }) => {
      if (code !== 'good-code') throw new AppError('hubspot', 'auth', 'connect failed: BAD_AUTH_CODE')
      return issue('refresh-1')
    }),
    refresh: vi.fn(async () => {
      if (refreshFails) throw new AppError('hubspot', 'auth', 'refresh access failed: BAD_REFRESH_TOKEN')
      return issue('refresh-2')
    }),
    revoke: vi.fn(async () => true),
    account: vi.fn(async () => ({ id: portal, name: `portal-${portal}.example` })),
  } satisfies AppOAuth
  const pushed: { call: FinishedCall; token: string }[] = []
  const pushCall = vi.fn<AppConnector['pushCall']>(async (token, call) => {
    pushed.push({ call, token: await token() })
    return { recordId: call.linkedRecordId ?? 'hs-contact-1', activityId: `hs-call-${pushed.length}` }
  })
  const services: AppServices = { oauth: async () => oauth, connector: () => ({ id: 'hubspot', crm: true, pushCall }) }
  return { oauth, services, pushCall, pushed }
}

let ws: Workspace
let other: Workspace
let member: User
let owner: Actor

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  member = await addMember(ws.id, 'member')
  owner = { actorId: ws.owner.userId, role: 'owner', workspaceId: ws.id, permissions: rolePermissions.owner }
})

const run = (
  tx: Tx,
  actor: Actor,
  services: AppServices,
  name: string,
  input: unknown,
  undos: Undo[] = [],
  commits: (() => Promise<void>)[] = [],
) =>
  runHandler(
    {
      tx,
      actor,
      now: new Date().toISOString(),
      apps: services,
      onRollback: u => undos.push(u),
      onCommit: w => commits.push(w),
    },
    actions.get(name)!,
    actions.get(name)!.input.parse(input),
  )

/** connectStart and connectFinish as the member's browser would run them; returns the connection id. */
async function connect(tx: Tx, services: AppServices, actor = owner, commits: (() => Promise<void>)[] = []) {
  const started = await run(tx, actor, services, 'app.connectStart', { app: 'hubspot' })
  const state = new URL(started.data!.url as string).searchParams.get('state')!
  const finished = await run(
    tx,
    actor,
    services,
    'app.connectFinish',
    { app: 'hubspot', state, code: 'good-code' },
    [],
    commits,
  )
  return finished.data!.connectionId as string
}

describe('connecting HubSpot', () => {
  test('the consent URL carries a state bound to the member and workspace', async () => {
    const { services } = fakeHubSpot()
    await inRollback(async tx => {
      const { data } = await run(tx, owner, services, 'app.connectStart', { app: 'hubspot' })
      const url = new URL(data!.url as string)
      const state = url.searchParams.get('state')!
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(url.searchParams.get('redirect_uri')).toBe(appRedirectUri('hubspot'))
      const [row] = await tx.select().from(app_oauth_states).where(eq(app_oauth_states.id, state))
      expect(row).toMatchObject({ workspace_id: ws.id, user_id: ws.owner.userId, provider: 'hubspot' })
      expect(Date.parse(row!.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60_000)
    })
  })

  test('finishing stores the portal with its tokens encrypted, and uses the state once', async () => {
    const { services } = fakeHubSpot()
    await inRollback(async tx => {
      const started = await run(tx, owner, services, 'app.connectStart', { app: 'hubspot' })
      const state = new URL(started.data!.url as string).searchParams.get('state')!
      const { rows, data } = await run(tx, owner, services, 'app.connectFinish', {
        app: 'hubspot',
        state,
        code: 'good-code',
      })
      expect(rows.app_connections).toMatchObject([
        {
          workspace_id: ws.id,
          provider: 'hubspot',
          account_id: '42',
          account_name: 'portal-42.example',
          status: 'connected',
          connected_by: ws.owner.userId,
        },
      ])
      const connectionId = data!.connectionId as string
      const [credentials] = await tx
        .select()
        .from(app_credentials)
        .where(eq(app_credentials.connection_id, connectionId))
      expect(credentials!.access_token_encrypted).not.toContain('access-1')
      expect(credentials!.refresh_token_encrypted).not.toContain('refresh-1')
      expect(decryptSecret(credentials!.refresh_token_encrypted, `app.${connectionId}.hubspot.refresh`)).toBe(
        'refresh-1',
      )
      // Bound to its connection and kind: the access token does not decrypt as the refresh token.
      expect(() => decryptSecret(credentials!.access_token_encrypted, `app.${connectionId}.hubspot.refresh`)).toThrow()
      await expect(
        run(tx, owner, services, 'app.connectFinish', { app: 'hubspot', state, code: 'good-code' }),
      ).rejects.toThrow(/expired or is not yours/)
    })
  })

  test("another member's state, or a state from another workspace, is refused", async () => {
    const { services } = fakeHubSpot()
    await inRollback(async tx => {
      const started = await run(tx, owner, services, 'app.connectStart', { app: 'hubspot' })
      const state = new URL(started.data!.url as string).searchParams.get('state')!
      const otherOwner: Actor = {
        actorId: other.owner.userId,
        role: 'owner',
        workspaceId: other.id,
        permissions: rolePermissions.owner,
      }
      await expect(
        run(tx, otherOwner, services, 'app.connectFinish', { app: 'hubspot', state, code: 'good-code' }),
      ).rejects.toThrow(/not yours/)
      const sameUserElsewhere: Actor = { ...owner, workspaceId: other.id }
      const again = await run(tx, owner, services, 'app.connectStart', { app: 'hubspot' })
      const state2 = new URL(again.data!.url as string).searchParams.get('state')!
      await expect(
        run(tx, sameUserElsewhere, services, 'app.connectFinish', { app: 'hubspot', state: state2, code: 'good-code' }),
      ).rejects.toThrow(/switched workspace/)
      expect(await tx.select().from(app_connections).where(eq(app_connections.workspace_id, other.id))).toEqual([])
    })
  })

  test('without the contact scopes the connect is refused and the new grant revoked', async () => {
    const { services, oauth } = fakeHubSpot({ scope: 'oauth' })
    await inRollback(async tx => {
      const undos: Undo[] = []
      const started = await run(tx, owner, services, 'app.connectStart', { app: 'hubspot' })
      const state = new URL(started.data!.url as string).searchParams.get('state')!
      await expect(
        run(tx, owner, services, 'app.connectFinish', { app: 'hubspot', state, code: 'good-code' }, undos),
      ).rejects.toThrow(/access to contacts/)
      expect(await Promise.all(undos.map(u => u()))).toEqual(['the new access was revoked'])
      expect(oauth.revoke).toHaveBeenCalledWith('refresh-1')
    })
  })

  test('a refused code is a clear rejection', async () => {
    const { services } = fakeHubSpot()
    await inRollback(async tx => {
      const started = await run(tx, owner, services, 'app.connectStart', { app: 'hubspot' })
      const state = new URL(started.data!.url as string).searchParams.get('state')!
      await expect(
        run(tx, owner, services, 'app.connectFinish', { app: 'hubspot', state, code: 'bad-code' }),
      ).rejects.toThrow(/HubSpot: connect failed/)
    })
  })

  test('connecting again updates the one connection; another portal drops the links and revokes the old grant', async () => {
    const first = fakeHubSpot()
    await inRollback(async tx => {
      const id = await connect(tx, first.services)
      expect(await connect(tx, first.services)).toBe(id)
      await tx
        .insert(crm_links)
        .values({
          id: 'crml_test',
          workspace_id: ws.id,
          connection_id: id,
          contact_id: ws.contact.id,
          external_id: 'hs-1',
        })
      const second = fakeHubSpot({ portal: '77' })
      const commits: (() => Promise<void>)[] = []
      expect(await connect(tx, second.services, owner, commits)).toBe(id)
      expect(await tx.select().from(crm_links).where(eq(crm_links.connection_id, id))).toEqual([])
      await Promise.all(commits.map(w => w()))
      expect(second.oauth.revoke).toHaveBeenCalledWith('refresh-1')
      const [row] = await tx.select().from(app_connections).where(eq(app_connections.id, id))
      expect(row).toMatchObject({ account_id: '77' })
    })
  })

  test('not while an instance admin is signed in as the member', async () => {
    const { services } = fakeHubSpot()
    await inRollback(async tx => {
      const impersonated = {
        ...owner,
        impersonation: { by: 'admin', sessionId: 's', expiresAt: new Date(Date.now() + 60_000) },
      }
      await expect(run(tx, impersonated, services, 'app.connectStart', { app: 'hubspot' })).rejects.toThrow(
        /another user/,
      )
      await expect(run(tx, impersonated, services, 'app.disconnect', { app: 'hubspot' })).rejects.toThrow(
        /another user/,
      )
    })
  })

  test('without the HubSpot app set up by an instance admin the connect is refused, with a code the page words', async () => {
    const { status, body } = await act(ws.owner, 'app.connectStart', { app: 'hubspot' })
    expect(status).toBe(409)
    expect(body).toMatchObject({ ok: false, code: 'not_set_up' })
    expect(body.error).toMatch(/Server admin › Providers/)
  })
})

describe('tokens', () => {
  test('an access token about to run out is refreshed and stored again, with the new refresh token', async () => {
    const { services, oauth } = fakeHubSpot()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      await tx
        .update(app_credentials)
        .set({ expires_at: new Date(Date.now() + 10_000).toISOString() })
        .where(eq(app_credentials.connection_id, id))
      const [connection] = await tx.select().from(app_connections).where(eq(app_connections.id, id))
      const token = appTokenSource(tx, services, connection!)
      expect(await token()).toBe('access-2')
      expect(oauth.refresh).toHaveBeenCalledWith('refresh-1')
      const [credentials] = await tx.select().from(app_credentials).where(eq(app_credentials.connection_id, id))
      expect(decryptSecret(credentials!.refresh_token_encrypted, appSlot(connection!, 'refresh'))).toBe('refresh-2')
      // Good now: no second refresh, unless the app refused it (forceRefresh after a 401).
      expect(await token()).toBe('access-2')
      expect(await token(true)).toBe('access-3')
    })
  })
})

describe('disconnecting', () => {
  test('deletes the connection with its tokens and links, and withdraws the grant once that has committed', async () => {
    const { services, oauth } = fakeHubSpot()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      await tx
        .insert(crm_links)
        .values({
          id: 'crml_test2',
          workspace_id: ws.id,
          connection_id: id,
          contact_id: ws.contact.id,
          external_id: 'hs-1',
        })
      const commits: (() => Promise<void>)[] = []
      const { data, deleted } = await run(tx, owner, services, 'app.disconnect', { app: 'hubspot' }, [], commits)
      // Not before the commit: a rollback would leave a connection whose grant is gone.
      expect(oauth.revoke).not.toHaveBeenCalled()
      await Promise.all(commits.map(w => w()))
      expect(data).toEqual({ revoked: true })
      expect(deleted).toEqual({ app_connections: [id] })
      expect(oauth.revoke).toHaveBeenCalledWith('refresh-1')
      expect(await tx.select().from(app_credentials).where(eq(app_credentials.connection_id, id))).toEqual([])
      expect(await tx.select().from(crm_links).where(eq(crm_links.connection_id, id))).toEqual([])
    })
  })

  test('an app that cannot be reached does not keep the connection', async () => {
    const { services, oauth } = fakeHubSpot()
    oauth.revoke.mockRejectedValueOnce(new Error('network down'))
    await inRollback(async tx => {
      const id = await connect(tx, services)
      const commits: (() => Promise<void>)[] = []
      const { data } = await run(tx, owner, services, 'app.disconnect', { app: 'hubspot' }, [], commits)
      await Promise.all(commits.map(w => w()))
      expect(data).toEqual({ revoked: false })
      expect(await tx.select().from(app_connections).where(eq(app_connections.id, id))).toEqual([])
    })
  })

  test('nothing connected is a rejection', async () => {
    const { services } = fakeHubSpot()
    await inRollback(async tx => {
      await expect(run(tx, owner, services, 'app.disconnect', { app: 'hubspot' })).rejects.toThrow(/not connected/)
    })
  })
})

/** A committed HubSpot connection of the workspace, so call.finish (its own transaction) queues a push for it. */
async function committedConnection(workspace: Workspace, settings: Record<string, boolean> = {}) {
  const id = `appc_${crypto.randomUUID().slice(0, 12)}`
  const [connection] = await db
    .insert(app_connections)
    .values({
      id,
      workspace_id: workspace.id,
      provider: 'hubspot',
      account_id: '42',
      account_name: 'portal-42.example',
      connected_by: workspace.owner.userId,
      settings,
    })
    .returning()
  await db.insert(app_credentials).values({
    connection_id: id,
    workspace_id: workspace.id,
    access_token_encrypted: encryptSecret('access-stored', appSlot(connection!, 'access')),
    refresh_token_encrypted: encryptSecret('refresh-stored', appSlot(connection!, 'refresh')),
    expires_at: new Date(Date.now() + 1800_000).toISOString(),
    scope: SCOPE,
  })
  return connection!
}

/** A phone call from the workspace's contact, finished with a summary and a next step, through the API. */
async function finishedCall(workspace: Workspace, asTest = false) {
  const started = await act(agent(), 'call.start', {
    from: workspace.contact.phone,
    to: workspace.number,
    attestation: 'A',
  })
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const { callId } = started.body.data as { callId: string }
  if (asTest) await db.update(calls).set({ source: 'test' }).where(eq(calls.id, callId))
  const finished = await act(agent(workspace.id), 'call.finish', {
    callId,
    outcome: 'message',
    summary: 'Water heater leaking.',
    actionItems: [{ text: 'Call Sam back' }],
  })
  expect(finished.status, JSON.stringify(finished.body)).toBe(200)
  return callId
}

const pushOf = async (connectionId: string, callId: string) =>
  (await db.select().from(app_pushes).where(eq(app_pushes.connection_id, connectionId))).find(p => p.call_id === callId)

describe('pushing finished calls', () => {
  let push: Workspace
  let connectionId: string

  beforeAll(async () => {
    push = await createWorkspace('Brightwater Pushes')
    connectionId = (await committedConnection(push)).id
  })

  test('a finished phone call is queued once per connected app; a test call is not', async () => {
    const callId = await finishedCall(push)
    expect(await pushOf(connectionId, callId)).toMatchObject({ workspace_id: push.id, status: 'pending', attempts: 0 })
    const testCallId = await finishedCall(push, true)
    expect(await pushOf(connectionId, testCallId)).toBeUndefined()
  })

  test('the push sends the call with its summary and next steps, stores the link, and the next call uses it', async () => {
    const { services, pushed } = fakeHubSpot()
    const first = await finishedCall(push)
    const second = await finishedCall(push)
    await inRollback(async tx => {
      expect(await attemptAppPush((await pushOf(connectionId, first))!.id, services, tx)).toBe('done')
      expect(pushed[0]!.token).toBe('access-stored')
      expect(pushed[0]!.call).toMatchObject({
        callId: first,
        direction: 'in',
        callerNumber: push.contact.phone,
        summary: 'Water heater leaking.',
        nextSteps: ['Call Sam back'],
        linkedRecordId: null,
      })
      expect(pushed[0]!.call.callUrl).toContain(`#call/${first}`)
      const [link] = await tx.select().from(crm_links).where(eq(crm_links.connection_id, connectionId))
      expect(link).toMatchObject({ contact_id: push.contact.id, external_id: 'hs-contact-1' })
      const [done] = await tx.select().from(app_pushes).where(eq(app_pushes.call_id, first))
      expect(done).toMatchObject({
        status: 'done',
        attempts: 1,
        external_id: 'hs-call-1',
        record_id: 'hs-contact-1',
        error_code: null,
      })
      // Done is done: a second run of the job sends nothing.
      expect(await attemptAppPush(done!.id, services, tx)).toBe('skipped')
      expect(await attemptAppPush((await pushOf(connectionId, second))!.id, services, tx)).toBe('done')
      expect(pushed[1]!.call.linkedRecordId).toBe('hs-contact-1')
    })
  })

  test('a failure that may pass is retried; one that will not, or the last try, fails and counts against the connection', async () => {
    const { services, pushCall } = fakeHubSpot()
    const callId = await finishedCall(push)
    await inRollback(async tx => {
      const id = (await pushOf(connectionId, callId))!.id
      pushCall.mockRejectedValueOnce(new AppError('hubspot', 'rate_limited', 'logging the call failed', 429))
      expect(await attemptAppPush(id, services, tx)).toBe('retry')
      expect((await tx.select().from(app_pushes).where(eq(app_pushes.id, id)))[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        error_code: 'rate_limited',
      })
      await tx
        .update(app_pushes)
        .set({ attempts: APP_PUSH_ATTEMPTS - 1 })
        .where(eq(app_pushes.id, id))
      pushCall.mockRejectedValueOnce(new AppError('hubspot', 'unavailable', 'could not reach HubSpot'))
      expect(await attemptAppPush(id, services, tx)).toBe('failed')
      const [connection] = await tx.select().from(app_connections).where(eq(app_connections.id, connectionId))
      expect(connection).toMatchObject({ failures: 1, status: 'connected', error_code: 'unavailable' })
    })
  })

  test('a refused grant asks for attention at once; several failures in a row do too', async () => {
    const { services, pushCall } = fakeHubSpot()
    const callIds = [await finishedCall(push), await finishedCall(push)]
    await inRollback(async tx => {
      pushCall.mockRejectedValueOnce(new AppError('hubspot', 'auth', 'refresh access failed'))
      expect(await attemptAppPush((await pushOf(connectionId, callIds[0]!))!.id, services, tx)).toBe('failed')
      expect((await tx.select().from(app_connections).where(eq(app_connections.id, connectionId)))[0]).toMatchObject({
        status: 'needs_attention',
        error_code: 'auth',
      })
      // A push that goes through again clears it.
      expect(await attemptAppPush((await pushOf(connectionId, callIds[1]!))!.id, services, tx)).toBe('done')
      expect((await tx.select().from(app_connections).where(eq(app_connections.id, connectionId)))[0]).toMatchObject({
        status: 'connected',
        failures: 0,
      })
    })
    await inRollback(async tx => {
      await tx
        .update(app_connections)
        .set({ failures: NEEDS_ATTENTION_AFTER - 1 })
        .where(eq(app_connections.id, connectionId))
      pushCall.mockRejectedValueOnce(new AppError('hubspot', 'invalid', 'creating the contact failed'))
      expect(await attemptAppPush((await pushOf(connectionId, callIds[0]!))!.id, services, tx)).toBe('failed')
      expect((await tx.select().from(app_connections).where(eq(app_connections.id, connectionId)))[0]).toMatchObject({
        status: 'needs_attention',
      })
    })
  })

  test('app.pushes lists the last pushes of the workspace only', async () => {
    const { body } = await act(push.owner, 'app.pushes', { app: 'hubspot' })
    const pushes = (body.data as { pushes: { callId: string; status: string }[] }).pushes
    expect(pushes.length).toBeGreaterThan(0)
    expect(pushes.every(p => p.status === 'pending')).toBe(true)
    expect((await act(ws.owner, 'app.pushes', { app: 'hubspot' })).body.data).toEqual({ pushes: [] })
  })
})

describe('what Linedesk does in the app (LIN-367)', () => {
  let shop: Workspace
  let connectionId: string
  let shopOwner: Actor

  beforeAll(async () => {
    shop = await createWorkspace('Brightwater Switches')
    connectionId = (await committedConnection(shop)).id
    shopOwner = { actorId: shop.owner.userId, role: 'owner', workspaceId: shop.id, permissions: rolePermissions.owner }
  })

  const settingsOf = async (tx: Tx, id: string) =>
    (await tx.select().from(app_connections).where(eq(app_connections.id, id)))[0]!.settings
  const failuresOf = async (tx: Tx, id: string) =>
    (await tx.select().from(app_connections).where(eq(app_connections.id, id)))[0]!.failures

  test('app.updateSettings merges the switches into the connection and returns the row', async () => {
    const { services } = fakeHubSpot()
    await inRollback(async tx => {
      const first = await run(tx, shopOwner, services, 'app.updateSettings', {
        id: connectionId,
        settings: { create_contacts: false },
      })
      expect(first.rows.app_connections![0]).toMatchObject({ id: connectionId, settings: { create_contacts: false } })
      // Another member changing another switch keeps the first.
      await run(tx, shopOwner, services, 'app.updateSettings', { id: connectionId, settings: { fill_fields: false } })
      expect(await settingsOf(tx, connectionId)).toEqual({ create_contacts: false, fill_fields: false })
      await run(tx, shopOwner, services, 'app.updateSettings', {
        id: connectionId,
        settings: { create_contacts: true },
      })
      expect(await settingsOf(tx, connectionId)).toEqual({ create_contacts: true, fill_fields: false })
    })
  })

  test("another workspace's connection is not found; not while signed in as the member", async () => {
    const { services } = fakeHubSpot()
    await inRollback(async tx => {
      await expect(
        run(tx, owner, services, 'app.updateSettings', { id: connectionId, settings: { log_calls: false } }),
      ).rejects.toThrow(/not connected/)
      const impersonated = {
        ...shopOwner,
        impersonation: { by: 'admin', sessionId: 's', expiresAt: new Date(Date.now() + 60_000) },
      }
      await expect(
        run(tx, impersonated, services, 'app.updateSettings', { id: connectionId, settings: { log_calls: false } }),
      ).rejects.toThrow(/another user/)
      expect(await settingsOf(tx, connectionId)).toEqual({})
    })
  })

  test('through the API: owners change it and it is audited; members and the agent cannot', async () => {
    expect(AUDITED_ACTIONS['app.updateSettings']).toBe('integrations')
    const input = { id: connectionId, settings: { fill_fields: false } }
    expect((await act(shop.owner, 'app.updateSettings', input)).status).toBe(200)
    expect((await db.select().from(app_connections).where(eq(app_connections.id, connectionId)))[0]!.settings).toEqual({
      fill_fields: false,
    })
    expect((await act(agent(shop.id), 'app.updateSettings', input)).status).toBe(403)
    const shopMember = await addMember(shop.id, 'member')
    expect((await act(shopMember, 'app.updateSettings', input)).status).toBe(403)
    await db.update(app_connections).set({ settings: {} }).where(eq(app_connections.id, connectionId))
  })

  test('logging calls off: a finished call is not queued, and one queued before is skipped when it is sent', async () => {
    const off = await createWorkspace('Brightwater No Logging')
    const offId = (await committedConnection(off, { log_calls: false })).id
    expect(await pushOf(offId, await finishedCall(off))).toBeUndefined()

    const { services, pushCall } = fakeHubSpot()
    const callId = await finishedCall(shop)
    await inRollback(async tx => {
      const id = (await pushOf(connectionId, callId))!.id
      await tx
        .update(app_connections)
        .set({ settings: { log_calls: false } })
        .where(eq(app_connections.id, connectionId))
      expect(await attemptAppPush(id, services, tx)).toBe('skipped')
      expect(pushCall).not.toHaveBeenCalled()
      expect((await tx.select().from(app_pushes).where(eq(app_pushes.id, id)))[0]).toMatchObject({
        status: 'skipped',
        error_code: 'calls_off',
      })
      expect(await failuresOf(tx, connectionId)).toBe(0)
    })
  })

  test('adding contacts off: the push may not create one; a caller with none is skipped, not failed', async () => {
    const { services, pushCall } = fakeHubSpot()
    const callId = await finishedCall(shop)
    await inRollback(async tx => {
      const id = (await pushOf(connectionId, callId))!.id
      await tx
        .update(app_connections)
        .set({ settings: { create_contacts: false } })
        .where(eq(app_connections.id, connectionId))
      pushCall.mockRejectedValueOnce(new PushSkipped('no_contact'))
      expect(await attemptAppPush(id, services, tx)).toBe('skipped')
      expect(pushCall.mock.calls[0]![3]).toEqual({ createContacts: false, fillFields: true })
      expect((await tx.select().from(app_pushes).where(eq(app_pushes.id, id)))[0]).toMatchObject({
        status: 'skipped',
        error_code: 'no_contact',
        external_id: null,
      })
      const [connection] = await tx.select().from(app_connections).where(eq(app_connections.id, connectionId))
      expect(connection).toMatchObject({ status: 'connected', failures: 0, error_code: null })
      const { body } = await act(shop.owner, 'app.pushes', { app: 'hubspot' })
      expect(body.ok).toBe(true)
    })
  })

  test('filling fields off, and the defaults: the push gets the switches as they are when it is sent', async () => {
    const { services, pushCall } = fakeHubSpot()
    const callIds = [await finishedCall(shop), await finishedCall(shop)]
    await inRollback(async tx => {
      expect(await attemptAppPush((await pushOf(connectionId, callIds[0]!))!.id, services, tx)).toBe('done')
      expect(pushCall.mock.calls[0]![3]).toEqual({ createContacts: true, fillFields: true })
      await tx
        .update(app_connections)
        .set({ settings: { fill_fields: false } })
        .where(eq(app_connections.id, connectionId))
      expect(await attemptAppPush((await pushOf(connectionId, callIds[1]!))!.id, services, tx)).toBe('done')
      expect(pushCall.mock.calls[1]![3]).toEqual({ createContacts: true, fillFields: false })
    })
  })
})

/** The push of a fresh committed call, back to its queued state; runs with the real database, no transaction around. */
async function queuedPush(workspace: Workspace, connectionId: string) {
  const callId = await finishedCall(workspace)
  return (await pushOf(connectionId, callId))!
}
const reload = async (pushId: string) => (await db.select().from(app_pushes).where(eq(app_pushes.id, pushId)))[0]!

describe('a push without a long transaction', () => {
  let space: Workspace
  let connectionId: string

  beforeAll(async () => {
    space = await createWorkspace('Brightwater Retries')
    connectionId = (await committedConnection(space)).id
  })

  test('two workers on one push: the second sees the claim after the lock and sends nothing', async () => {
    const { services, pushCall } = fakeHubSpot()
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    pushCall.mockImplementationOnce(async () => {
      await held
      return { recordId: 'hs-contact-1', activityId: 'hs-call-1' }
    })
    const push = await queuedPush(space, connectionId)
    const first = attemptAppPush(push.id, services)
    await vi.waitFor(() => expect(pushCall).toHaveBeenCalledTimes(1))
    expect(await reload(push.id)).toMatchObject({ status: 'sending', attempts: 1 })
    expect(await attemptAppPush(push.id, services)).toBe('skipped')
    release()
    expect(await first).toBe('done')
    expect(pushCall).toHaveBeenCalledTimes(1)
    expect(await reload(push.id)).toMatchObject({ status: 'done', attempts: 1, external_id: 'hs-call-1' })
  })

  test('one push per connection at a time; a claim that died is taken over after the timeout', async () => {
    const { services, pushCall } = fakeHubSpot()
    const sending = await queuedPush(space, connectionId)
    const other = await queuedPush(space, connectionId)
    await db
      .update(app_pushes)
      .set({ status: 'sending', claimed_at: new Date().toISOString(), attempts: 1 })
      .where(eq(app_pushes.id, sending.id))
    expect(await attemptAppPush(other.id, services)).toBe('busy')
    expect(await reload(other.id)).toMatchObject({ status: 'pending', attempts: 0 })
    // Its worker died: after SENDING_TIMEOUT_MS it is claimed again, with the try counted.
    await db
      .update(app_pushes)
      .set({ claimed_at: new Date(Date.now() - SENDING_TIMEOUT_MS - 1000).toISOString() })
      .where(eq(app_pushes.id, sending.id))
    expect(await attemptAppPush(sending.id, services)).toBe('done')
    expect(await reload(sending.id)).toMatchObject({ status: 'done', attempts: 2 })
    expect(await attemptAppPush(other.id, services)).toBe('done')
    expect(pushCall).toHaveBeenCalledTimes(2)
  })

  test('the record found or created is kept at once: the retry files the call under it', async () => {
    const { services, pushCall, pushed } = fakeHubSpot()
    const push = await queuedPush(space, connectionId)
    pushCall.mockImplementationOnce(async (_token, _call, progress) => {
      await progress?.onRecord?.('hs-contact-new')
      throw new AppError('hubspot', 'unavailable', 'logging the call could not reach HubSpot')
    })
    expect(await attemptAppPush(push.id, services)).toBe('retry')
    expect(await reload(push.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      record_id: 'hs-contact-new',
      error_code: 'unavailable',
    })
    const [link] = await db
      .select()
      .from(crm_links)
      .where(and(eq(crm_links.connection_id, connectionId), eq(crm_links.contact_id, space.contact.id)))
    expect(link).toMatchObject({ external_id: 'hs-contact-new' })
    expect(await attemptAppPush(push.id, services)).toBe('done')
    expect(pushed.at(-1)!.call.linkedRecordId).toBe('hs-contact-new')
  })

  test('a call logged before a failure is not logged again', async () => {
    const { services, pushCall } = fakeHubSpot()
    const push = await queuedPush(space, connectionId)
    pushCall.mockImplementationOnce(async (_token, _call, progress) => {
      await progress?.onRecord?.('hs-contact-new')
      await progress?.onLogged?.('hs-call-77')
      throw new Error('connection reset')
    })
    expect(await attemptAppPush(push.id, services)).toBe('retry')
    expect(await reload(push.id)).toMatchObject({
      status: 'pending',
      external_id: 'hs-call-77',
      error_code: 'internal',
    })
    expect(await attemptAppPush(push.id, services)).toBe('done')
    expect(pushCall).toHaveBeenCalledTimes(1)
    expect(await reload(push.id)).toMatchObject({
      status: 'done',
      attempts: 2,
      external_id: 'hs-call-77',
      record_id: 'hs-contact-new',
    })
  })

  test('a database error during the try is counted in its own transaction, and the last try fails for good', async () => {
    const { services, pushCall } = fakeHubSpot()
    const push = await queuedPush(space, connectionId)
    // Before, this aborted the one transaction: the failure could not be saved and the push stayed pending forever.
    pushCall.mockImplementation(async () => {
      await db.execute(sql`select 1 / 0`)
      return { recordId: null, activityId: 'never' }
    })
    expect(await attemptAppPush(push.id, services)).toBe('retry')
    expect(await reload(push.id)).toMatchObject({ status: 'pending', attempts: 1, error_code: 'internal' })
    await db
      .update(app_pushes)
      .set({ attempts: APP_PUSH_ATTEMPTS - 1 })
      .where(eq(app_pushes.id, push.id))
    expect(await attemptAppPush(push.id, services)).toBe('failed')
    expect(await reload(push.id)).toMatchObject({
      status: 'failed',
      attempts: APP_PUSH_ATTEMPTS,
      error_code: 'internal',
    })
    pushCall.mockReset()
    await db
      .update(app_connections)
      .set({ failures: 0, status: 'connected', error_code: null })
      .where(eq(app_connections.id, connectionId))
  })

  test('a claim that died on its last try is failed, not sent again', async () => {
    const { services, pushCall } = fakeHubSpot()
    const push = await queuedPush(space, connectionId)
    await db
      .update(app_pushes)
      .set({
        status: 'sending',
        attempts: APP_PUSH_ATTEMPTS,
        claimed_at: new Date(Date.now() - SENDING_TIMEOUT_MS - 1000).toISOString(),
      })
      .where(eq(app_pushes.id, push.id))
    expect(await attemptAppPush(push.id, services)).toBe('skipped')
    expect(pushCall).not.toHaveBeenCalled()
    expect(await reload(push.id)).toMatchObject({ status: 'failed', error_code: 'internal' })
  })

  test('the sweep queues stuck pushes again and gives up those open for a day', async () => {
    const stuck = await queuedPush(space, connectionId)
    const old = await queuedPush(space, connectionId)
    await db
      .update(app_pushes)
      .set({
        status: 'sending',
        attempts: 1,
        claimed_at: new Date(Date.now() - SENDING_TIMEOUT_MS - 1000).toISOString(),
      })
      .where(eq(app_pushes.id, stuck.id))
    await db
      .update(app_pushes)
      .set({ created_at: new Date(Date.now() - GIVE_UP_AFTER_MS - 1000).toISOString() })
      .where(eq(app_pushes.id, old.id))
    const requeued: string[] = []
    await sweepAppPushes(async id => void requeued.push(id))
    expect(requeued).toContain(stuck.id)
    expect(requeued).not.toContain(old.id)
    expect(await reload(old.id)).toMatchObject({ status: 'failed', error_code: 'internal' })
  })
})

describe('the grant changing while a push uses it', () => {
  let space: Workspace
  let spaceOwner: Actor

  beforeAll(async () => {
    space = await createWorkspace('Brightwater Grants')
    spaceOwner = {
      actorId: space.owner.userId,
      role: 'owner',
      workspaceId: space.id,
      permissions: rolePermissions.owner,
    }
  })

  test('a refreshed token is not saved over a grant that was replaced meanwhile; the new one is used', async () => {
    const connection = await committedConnection(space)
    await db
      .update(app_credentials)
      .set({ expires_at: new Date(Date.now() + 10_000).toISOString() })
      .where(eq(app_credentials.connection_id, connection.id))
    const { services, oauth } = fakeHubSpot()
    oauth.refresh.mockImplementationOnce(async () => {
      // Connected again while the refresh was on its way.
      await db
        .update(app_credentials)
        .set({
          access_token_encrypted: encryptSecret('access-reconnected', appSlot(connection, 'access')),
          refresh_token_encrypted: encryptSecret('refresh-reconnected', appSlot(connection, 'refresh')),
          expires_at: new Date(Date.now() + 1800_000).toISOString(),
        })
        .where(eq(app_credentials.connection_id, connection.id))
      return { accessToken: 'access-old-grant', refreshToken: 'refresh-old', expiresAt: null, scope: SCOPE }
    })
    expect(await appTokenSource(db, services, connection)()).toBe('access-reconnected')
    const [credentials] = await db
      .select()
      .from(app_credentials)
      .where(eq(app_credentials.connection_id, connection.id))
    expect(decryptSecret(credentials!.refresh_token_encrypted, appSlot(connection, 'refresh'))).toBe(
      'refresh-reconnected',
    )
    await db.delete(app_connections).where(eq(app_connections.id, connection.id))
  })

  test('a refresh that ends after a disconnect saves nothing', async () => {
    const connection = await committedConnection(space)
    await db
      .update(app_credentials)
      .set({ expires_at: new Date(Date.now() + 10_000).toISOString() })
      .where(eq(app_credentials.connection_id, connection.id))
    const { services, oauth } = fakeHubSpot()
    oauth.refresh.mockImplementationOnce(async () => {
      await db.delete(app_connections).where(eq(app_connections.id, connection.id))
      return { accessToken: 'access-orphan', refreshToken: 'refresh-orphan', expiresAt: null, scope: SCOPE }
    })
    await expect(appTokenSource(db, services, connection)()).rejects.toMatchObject({ kind: 'auth' })
    expect(await db.select().from(app_credentials).where(eq(app_credentials.connection_id, connection.id))).toEqual([])
  })

  test('disconnecting and connecting again wait for the lock a push holds on the connection', async () => {
    // Postgres' lock_not_available: they waited for the lock and gave up.
    const LOCK_TIMEOUT = { cause: { code: '55P03' } }
    const connection = await committedConnection(space)
    const { services } = fakeHubSpot()
    const waitsForLock = (body: (tx: Tx) => Promise<unknown>) =>
      db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '300ms'`)
        await body(tx)
      })
    await db.transaction(async holder => {
      await lockConnection(holder, connection.id)
      await expect(
        waitsForLock(tx => run(tx, spaceOwner, services, 'app.disconnect', { app: 'hubspot' })),
      ).rejects.toMatchObject(LOCK_TIMEOUT)
      await expect(waitsForLock(tx => connect(tx, services, spaceOwner))).rejects.toMatchObject(LOCK_TIMEOUT)
    })
    expect(await db.select().from(app_connections).where(eq(app_connections.id, connection.id))).toHaveLength(1)
    await db.delete(app_connections).where(eq(app_connections.id, connection.id))
  })
})

describe('through the API', () => {
  test('members, and the agent, cannot connect, disconnect or read pushes', async () => {
    for (const name of ['app.connectStart', 'app.connectFinish', 'app.disconnect', 'app.pushes']) {
      expect(actions.get(name)!.permission, name).toBe('settings:write')
      expect((await act(member, name, {})).status, name).toBe(403)
      expect((await act(agent(ws.id), name, {})).status, name).toBe(403)
    }
  })

  test("an owner cannot disconnect another workspace's app", async () => {
    const connection = await committedConnection(other)
    expect(await act(ws.owner, 'app.disconnect', { app: 'hubspot' })).toMatchObject({
      status: 409,
      body: { ok: false },
    })
    expect(await db.select().from(app_connections).where(eq(app_connections.id, connection.id))).toHaveLength(1)
  })

  test('the code and the state are never stored in the command log', () => {
    expect(actions.get('app.connectFinish')!.sensitive).toEqual(['code', 'state'])
  })

  test('the callback sends the browser back to the HubSpot page, with a reason code when it fails, never text', async () => {
    const web = 'http://app.test'
    const headers = new Headers(ws.owner.headers)
    const target = (url: string) => Object.fromEntries(new URLSearchParams(url.split('#integrations/hubspot?')[1]))
    expect(await appCallback('hubspot', new URLSearchParams({ error: 'access_denied' }), headers, web)).toMatch(
      /^http:\/\/app\.test\/#integrations\/hubspot\?/,
    )
    expect(target(await appCallback('hubspot', new URLSearchParams({ error: 'access_denied' }), headers, web))).toEqual(
      { app: 'error', reason: 'denied' },
    )
    // The app's own error text does not travel: it could be anything.
    expect(
      target(
        await appCallback(
          'hubspot',
          new URLSearchParams({ error: 'Call 555 now', error_description: 'x' }),
          headers,
          web,
        ),
      ).reason,
    ).toBe('failed')
    expect(target(await appCallback('hubspot', new URLSearchParams({}), headers, web)).reason).toBe('failed')
    expect(
      target(
        await appCallback('hubspot', new URLSearchParams({ code: 'c', state: 's'.repeat(20) }), new Headers(), web),
      ).reason,
    ).toBe('signed_out')
    // A state that is not this member's: the rejection's code, not its message.
    expect(
      target(await appCallback('hubspot', new URLSearchParams({ code: 'c', state: 's'.repeat(20) }), headers, web))
        .reason,
    ).toBe('not_yours')
    expect(await appCallback('salesforce', new URLSearchParams({ code: 'c', state: 's' }), headers, web)).toMatch(
      /#integrations\/\?app=error&reason=failed$/,
    )
  })
})
