// Jobber as a connected app (docs/crm-sync.md, "Jobber"): connecting stores the Jobber account with its rotating
// refresh token encrypted, a refresh stores the new refresh token, disconnecting runs appDisconnect unless another
// workspace uses the same Jobber account, and every finished call finds or adds the client and adds a note. A fake
// Jobber (fake fetch for the real connector), no real Jobber calls.
// Instance-wide (vitest.config.ts): a refused client secret is recorded as the Jobber provider failing.
import { actions, rolePermissions } from '@linedesk/actions'
import { AppError, type AppOAuth, createJobberConnector, type OAuthTokens } from '@linedesk/connectors'
import { app_connections, app_credentials, app_pushes, crm_links, provider_failures, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { appCallback } from '../src/app-callback.ts'
import { type AppServices, appSlot, appTokenSource } from '../src/app-connections.ts'
import { attemptAppPush } from '../src/app-pushes.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { runHandler, type Undo } from '../src/handlers.ts'
import { decryptSecret, encryptSecret } from '../src/secrets.ts'
import { act, agent, createWorkspace, type Workspace } from './helpers.ts'

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

type GraphqlSeen = { op: string; variables: { id?: string; input?: Record<string, unknown> }; authorization: string }

/**
 * A Jobber account in memory: OAuth that hands out numbered, rotating tokens (and no scope, as Jobber's token answer
 * has none), and the real connector against a fake GraphQL endpoint that answers by operation name.
 */
function fakeJobber({ account = 'acc-1', scope = null as string | null, clients = [] as unknown[] } = {}) {
  let issued = 0
  const issue = (): OAuthTokens => ({
    accessToken: `access-${++issued}`,
    refreshToken: `refresh-${issued}`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scope,
  })
  const oauth = {
    id: 'jobber' as const,
    scopes: ['read_clients', 'write_clients'],
    grantPerAccount: true,
    authorizeUrl: vi.fn(
      ({ redirectUri, state }: { redirectUri: string; state: string }) =>
        `https://api.getjobber.test/api/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    ),
    exchangeCode: vi.fn(async () => ({ ...issue(), account: { id: account, name: 'Brightwater Plumbing' } })),
    refresh: vi.fn(async () => issue()),
    revoke: vi.fn(async () => true),
    account: vi.fn(async () => ({ id: account, name: 'Brightwater Plumbing' })),
  } satisfies AppOAuth
  const seen: GraphqlSeen[] = []
  const doFetch = (async (_input: string | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body))
    const op = /^(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? '?'
    const authorization = String((init.headers as Record<string, string>).authorization)
    seen.push({ op, variables: body.variables, authorization })
    const data =
      op === 'LinedeskFindClient'
        ? { clients: { nodes: clients } }
        : op === 'LinedeskCreateClient'
          ? {
              clientCreate: {
                client: {
                  id: 'jc-new',
                  firstName: body.variables.input.firstName ?? null,
                  lastName: body.variables.input.lastName ?? null,
                  companyName: null,
                  phones: body.variables.input.phones ?? [],
                  emails: body.variables.input.emails ?? [],
                },
                userErrors: [],
              },
            }
          : op === 'LinedeskFillClient'
            ? { clientEdit: { client: { id: body.variables.id }, userErrors: [] } }
            : op === 'LinedeskNote'
              ? { clientCreateNote: { clientNote: { id: `jn-${seen.length}` }, userErrors: [] } }
              : null
    return new Response(JSON.stringify(data ? { data } : { errors: [{ message: `no route ${op}` }] }), { status: 200 })
  }) as typeof fetch
  const services: AppServices = {
    oauth: async () => oauth,
    connector: () => createJobberConnector({ fetch: doFetch }),
  }
  return { oauth, services, seen }
}

let ws: Workspace
let other: Workspace
let owner: Actor
let otherOwner: Actor

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Brightwater Annex')
  owner = { actorId: ws.owner.userId, role: 'owner', workspaceId: ws.id, permissions: rolePermissions.owner }
  otherOwner = { actorId: other.owner.userId, role: 'owner', workspaceId: other.id, permissions: rolePermissions.owner }
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

async function connect(tx: Tx, services: AppServices, actor = owner, undos: Undo[] = []) {
  const started = await run(tx, actor, services, 'app.connectStart', { app: 'jobber' })
  const state = new URL(started.data!.url as string).searchParams.get('state')!
  const finished = await run(tx, actor, services, 'app.connectFinish', { app: 'jobber', state, code: 'c' }, undos)
  return finished.data!.connectionId as string
}

describe('connecting Jobber', () => {
  test('stores the Jobber account on the connection, the tokens only encrypted', async () => {
    const { services } = fakeJobber()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      const [row] = await tx.select().from(app_connections).where(eq(app_connections.id, id))
      expect(row).toMatchObject({
        provider: 'jobber',
        account_id: 'acc-1',
        account_name: 'Brightwater Plumbing',
        status: 'connected',
      })
      const [credentials] = await tx.select().from(app_credentials).where(eq(app_credentials.connection_id, id))
      expect(credentials!.access_token_encrypted).not.toContain('access-1')
      expect(credentials!.refresh_token_encrypted).not.toContain('refresh-1')
      expect(decryptSecret(credentials!.refresh_token_encrypted, appSlot(row!, 'refresh'))).toBe('refresh-1')
      expect(decryptSecret(credentials!.access_token_encrypted, appSlot(row!, 'access'))).toBe('access-1')
    })
  })

  test('a token answer that names scopes without write_clients is refused and the grant withdrawn', async () => {
    const { services, oauth } = fakeJobber({ scope: 'read_clients' })
    await inRollback(async tx => {
      const undos: Undo[] = []
      await expect(connect(tx, services, owner, undos)).rejects.toMatchObject({ code: 'scope' })
      expect(await Promise.all(undos.map(u => u()))).toEqual(['the new access was revoked'])
      expect(oauth.revoke).toHaveBeenCalledWith('refresh-1')
    })
  })

  test("a grant whose Jobber account is not known is not withdrawn: it may be another workspace's account too", async () => {
    const { services, oauth } = fakeJobber()
    oauth.exchangeCode.mockResolvedValueOnce({
      accessToken: 'access-x',
      refreshToken: 'refresh-x',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: null,
      // The account read after the code exchange failed (jobber.ts reads it with the grant).
      account: null,
    } as never)
    oauth.account.mockRejectedValueOnce(new AppError('jobber', 'unavailable', 'account read failed', 503))
    await inRollback(async tx => {
      const undos: Undo[] = []
      await expect(connect(tx, services, owner, undos)).rejects.toThrow()
      expect(undos).toEqual([])
      expect(oauth.revoke).not.toHaveBeenCalled()
    })
  })

  test('a client ID or secret Jobber refuses is not_set_up for the member and a Jobber failure for Server admin', async () => {
    const { services, oauth } = fakeJobber()
    oauth.exchangeCode.mockRejectedValueOnce(
      new AppError('jobber', 'client', 'connect failed: The provided client id and secret do not match', 401),
    )
    await inRollback(async tx => {
      await expect(connect(tx, services)).rejects.toMatchObject({ code: 'not_set_up' })
    })
    await vi.waitFor(async () =>
      expect(
        (await db.select().from(provider_failures).where(eq(provider_failures.provider, 'jobber')))[0],
      ).toMatchObject({ reason: 'auth' }),
    )
    await db.delete(provider_failures).where(eq(provider_failures.provider, 'jobber'))
  })
})

describe('Jobber tokens', () => {
  test('a refresh stores the rotated refresh token, so the next refresh uses it', async () => {
    const { services, oauth } = fakeJobber()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      await tx
        .update(app_credentials)
        .set({ expires_at: new Date(Date.now() + 10_000).toISOString() })
        .where(eq(app_credentials.connection_id, id))
      const [connection] = await tx.select().from(app_connections).where(eq(app_connections.id, id))
      const token = appTokenSource(tx, services, connection!)
      expect(await token()).toBe('access-2')
      expect(oauth.refresh).toHaveBeenLastCalledWith('refresh-1')
      expect(await token(true)).toBe('access-3')
      expect(oauth.refresh).toHaveBeenLastCalledWith('refresh-2')
      const [credentials] = await tx.select().from(app_credentials).where(eq(app_credentials.connection_id, id))
      expect(decryptSecret(credentials!.refresh_token_encrypted, appSlot(connection!, 'refresh'))).toBe('refresh-3')
    })
  })
})

describe('disconnecting Jobber', () => {
  test('runs appDisconnect with the stored grant once the delete has committed', async () => {
    const { services, oauth } = fakeJobber()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      const commits: (() => Promise<void>)[] = []
      const { data } = await run(tx, owner, services, 'app.disconnect', { app: 'jobber' }, [], commits)
      expect(oauth.revoke).not.toHaveBeenCalled()
      await Promise.all(commits.map(w => w()))
      expect(data).toEqual({ revoked: true })
      expect(oauth.revoke).toHaveBeenCalledWith('refresh-1')
      expect(await tx.select().from(app_credentials).where(eq(app_credentials.connection_id, id))).toEqual([])
    })
  })

  test('keeps the app connected while another workspace uses the same Jobber account', async () => {
    const { services, oauth } = fakeJobber()
    await inRollback(async tx => {
      await connect(tx, services)
      await connect(tx, services, otherOwner)
      const commits: (() => Promise<void>)[] = []
      const { data } = await run(tx, owner, services, 'app.disconnect', { app: 'jobber' }, [], commits)
      await Promise.all(commits.map(w => w()))
      expect(data).toEqual({ revoked: false })
      expect(oauth.revoke).not.toHaveBeenCalled()
    })
  })
})

/** A committed Jobber connection, so call.finish (its own transaction) queues a push for it. */
async function committedJobber(workspace: Workspace) {
  const id = `appc_${crypto.randomUUID().slice(0, 12)}`
  const [connection] = await db
    .insert(app_connections)
    .values({
      id,
      workspace_id: workspace.id,
      provider: 'jobber',
      account_id: `acc-${crypto.randomUUID().slice(0, 8)}`,
      account_name: 'Brightwater Plumbing',
      connected_by: workspace.owner.userId,
      settings: {},
    })
    .returning()
  await db.insert(app_credentials).values({
    connection_id: id,
    workspace_id: workspace.id,
    access_token_encrypted: encryptSecret('access-stored', appSlot(connection!, 'access')),
    refresh_token_encrypted: encryptSecret('refresh-stored', appSlot(connection!, 'refresh')),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    scope: null,
  })
  return connection!
}

async function finishedCall(workspace: Workspace) {
  const started = await act(agent(), 'call.start', {
    from: workspace.contact.phone,
    to: workspace.number,
    attestation: 'A',
  })
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const { callId } = started.body.data as { callId: string }
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
  (await db.select().from(app_pushes).where(eq(app_pushes.connection_id, connectionId))).find(
    p => p.call_id === callId,
  )!

describe('sending finished calls to Jobber', () => {
  test('adds the caller as a client, adds the call as a note with the summary and link, and keeps the link', async () => {
    const shop = await createWorkspace('Brightwater Jobber')
    const connection = await committedJobber(shop)
    const { services, seen } = fakeJobber()
    const callId = await finishedCall(shop)
    await inRollback(async tx => {
      expect(await attemptAppPush((await pushOf(connection.id, callId)).id, services, tx)).toBe('done')
      expect(seen.every(r => r.authorization === 'Bearer access-stored')).toBe(true)
      const created = seen.find(r => r.op === 'LinedeskCreateClient')!
      expect(created.variables.input?.phones).toEqual([
        { number: shop.contact.phone, primary: true, description: 'MAIN' },
      ])
      const note = seen.find(r => r.op === 'LinedeskNote')!
      expect(note.variables.id).toBe('jc-new')
      expect(note.variables.input?.message).toContain('Water heater leaking.')
      expect(note.variables.input?.message).toContain('- Call Sam back')
      expect(note.variables.input?.message).toContain(`#call/${callId}`)
      const [link] = await tx.select().from(crm_links).where(eq(crm_links.connection_id, connection.id))
      expect(link).toMatchObject({ contact_id: shop.contact.id, external_id: 'jc-new' })
      expect((await tx.select().from(app_pushes).where(eq(app_pushes.call_id, callId)))[0]).toMatchObject({
        status: 'done',
        record_id: 'jc-new',
      })
    })
  })

  test('Jobber throttling is retried after the wait its cost bucket needs', async () => {
    const shop = await createWorkspace('Brightwater Jobber')
    const connection = await committedJobber(shop)
    const throttled = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
            extensions: {
              cost: { requestedQueryCost: 3000, throttleStatus: { currentlyAvailable: 0, restoreRate: 500 } },
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch
    const { oauth } = fakeJobber()
    const services: AppServices = {
      oauth: async () => oauth,
      connector: () => createJobberConnector({ fetch: throttled }),
    }
    const callId = await finishedCall(shop)
    await inRollback(async tx => {
      const waits: number[] = []
      expect(await attemptAppPush((await pushOf(connection.id, callId)).id, services, tx, s => waits.push(s))).toBe(
        'retry',
      )
      expect(waits).toEqual([6])
    })
  })
})

test('the callback sends the browser back to the Jobber page', async () => {
  const web = 'https://app.example'
  expect(await appCallback('jobber', new URLSearchParams({ error: 'access_denied' }), new Headers(), web)).toBe(
    'https://app.example/#integrations/jobber?app=error&reason=denied',
  )
})
