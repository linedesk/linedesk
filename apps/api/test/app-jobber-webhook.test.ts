// Jobber's APP_DISCONNECT webhook (jobber-webhook.ts, LIN-447): a delivery signed with the Jobber app's client secret
// deletes every connection to that Jobber account with its tokens, in every workspace, without asking Jobber again; a
// missing or wrong signature is 401 and changes nothing; another topic is 200 and changes nothing; a repeat is 200;
// the account lock (the one connect and disconnect take) is waited for.
// Instance-wide (vitest.config.ts): stores the Jobber client secret in provider_settings.
import { createHmac } from 'node:crypto'
import { app_connections, app_credentials, provider_settings } from '@linedesk/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { appSlot } from '../src/app-connections.ts'
import { db } from '../src/db.ts'
import { JOBBER_WEBHOOK_PATH, jobberAccountIds, resetJobberWebhookLimits } from '../src/jobber-webhook.ts'
import { setProviderKeys } from '../src/provider-settings.ts'
import { encryptSecret } from '../src/secrets.ts'
import { appRequest, createWorkspace, type Workspace } from './helpers.ts'

/** Made-up secrets, put together at run time so the secret scan never sees a key-shaped string. */
const SECRET = ['jobber', 'made', 'up', 'client', 'secret', '0123456789'].join('-')
const STRANGER = ['someone', 'elses', 'secret', '0123456789'].join('-')

const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('base64')

const eventBody = (topic: string, accountId: string, occurredAt: string | undefined = new Date().toISOString()) =>
  JSON.stringify({
    data: {
      webHookEvent: {
        topic,
        appId: 'a1b2c3d4-0000-4000-8000-000000000000',
        accountId,
        itemId: accountId,
        occurredAt,
      },
    },
  })

const deliver = (body: string, signature: string | null = sign(body)) =>
  appRequest(JOBBER_WEBHOOK_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'x-jobber-hmac-sha256': signature }),
    },
    body,
  })

/** An encoded Jobber account id, as `account { id }` answers it. */
const encodedAccount = () =>
  Buffer.from(`gid://Jobber/Account/${Math.floor(Math.random() * 1e9)}`, 'utf8').toString('base64')

let ws: Workspace
let other: Workspace

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Brightwater Annex')
  await setProviderKeys(
    db,
    'jobber',
    { client_id: 'jobber-client-id', client_secret: SECRET },
    ws.owner.userId,
    new Date().toISOString(),
  )
})

afterAll(async () => {
  await db.delete(provider_settings).where(eq(provider_settings.provider, 'jobber'))
})

beforeEach(() => resetJobberWebhookLimits())

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

async function connected(workspace: Workspace, accountId: string, grantedAt = minutesAgo(10)) {
  const id = `appc_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  const [connection] = await db
    .insert(app_connections)
    .values({
      id,
      workspace_id: workspace.id,
      provider: 'jobber',
      account_id: accountId,
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
    // Granted (or last refreshed) before the events the tests send, unless a test says otherwise.
    updated_at: grantedAt,
  })
  return id
}

const connectionsLeft = async (ids: string[]) =>
  (await db.select({ id: app_connections.id }).from(app_connections).where(inArray(app_connections.id, ids))).length
const credentialsLeft = async (ids: string[]) =>
  (
    await db
      .select({ id: app_credentials.connection_id })
      .from(app_credentials)
      .where(inArray(app_credentials.connection_id, ids))
  ).length

async function clean(...workspaces: Workspace[]) {
  for (const w of workspaces)
    await db
      .delete(app_connections)
      .where(and(eq(app_connections.workspace_id, w.id), eq(app_connections.provider, 'jobber')))
}

describe('Jobber APP_DISCONNECT webhook', () => {
  test('a signed APP_DISCONNECT deletes every connection to that account with its tokens, and only those', async () => {
    await clean(ws, other)
    const account = encodedAccount()
    const ids = [await connected(ws, account), await connected(other, account)]
    // A workspace has one Jobber connection at most: another account's connection is in a third workspace.
    const third = await createWorkspace('Brightwater North')
    const kept = await connected(third, encodedAccount())
    const res = await deliver(eventBody('APP_DISCONNECT', account))
    expect(res.status).toBe(200)
    expect(await connectionsLeft(ids)).toBe(0)
    expect(await credentialsLeft(ids)).toBe(0)
    expect(await connectionsLeft([kept])).toBe(1)
    await clean(ws, other, third)
  })

  test('a repeated delivery is 200 and changes nothing more', async () => {
    await clean(ws)
    const account = encodedAccount()
    const id = await connected(ws, account)
    const body = eventBody('APP_DISCONNECT', account)
    expect((await deliver(body)).status).toBe(200)
    expect((await deliver(body)).status).toBe(200)
    expect(await connectionsLeft([id])).toBe(0)
  })

  test('a missing, malformed or wrong signature is 401 and changes nothing', async () => {
    await clean(ws)
    const account = encodedAccount()
    const id = await connected(ws, account)
    const body = eventBody('APP_DISCONNECT', account)
    expect((await deliver(body, null)).status).toBe(401)
    expect((await deliver(body, 'not-base64!')).status).toBe(401)
    expect((await deliver(body, sign(body, STRANGER))).status).toBe(401)
    // Signed for another body.
    expect((await deliver(body, sign(eventBody('APP_DISCONNECT', encodedAccount())))).status).toBe(401)
    expect(await connectionsLeft([id])).toBe(1)
    expect(await credentialsLeft([id])).toBe(1)
    await clean(ws)
  })

  test('another topic, or a body of another shape, is 200 and changes nothing', async () => {
    await clean(ws)
    const account = encodedAccount()
    const id = await connected(ws, account)
    const client = await deliver(eventBody('CLIENT_CREATE', account))
    expect(client.status).toBe(200)
    expect(await client.json()).toMatchObject({ ok: true, ignored: true })
    expect((await deliver('{"data":{}}')).status).toBe(200)
    expect((await deliver('not json')).status).toBe(200)
    expect(await connectionsLeft([id])).toBe(1)
    await clean(ws)
  })

  test('an account named in its plain form matches the stored encoded id', async () => {
    await clean(ws)
    const plain = String(Math.floor(Math.random() * 1e9))
    const id = await connected(ws, Buffer.from(`gid://Jobber/Account/${plain}`).toString('base64'))
    expect((await deliver(eventBody('APP_DISCONNECT', plain))).status).toBe(200)
    expect(await connectionsLeft([id])).toBe(0)
    expect(jobberAccountIds('MQ==')).toEqual(['MQ=='])
  })

  test('waits for the account lock that connect and disconnect take', async () => {
    await clean(ws)
    const account = encodedAccount()
    const id = await connected(ws, account)
    let release!: () => void
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    let locked!: () => void
    const isLocked = new Promise<void>(resolve => {
      locked = resolve
    })
    const holder = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app-account:jobber:${account}`}))`)
      locked()
      await released
    })
    await isLocked
    const delivery = deliver(eventBody('APP_DISCONNECT', account))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await connectionsLeft([id])).toBe(1)
    release()
    await holder
    expect((await delivery).status).toBe(200)
    expect(await connectionsLeft([id])).toBe(0)
  })

  test('a grant stored after the event stays; one stored before it goes; no event time deletes', async () => {
    await clean(ws, other)
    const account = encodedAccount()
    // Connected again a minute after a disconnect whose delivery comes late (or is replayed).
    const fresh = await connected(ws, account, minutesAgo(9))
    const old = await connected(other, account, minutesAgo(120))
    expect((await deliver(eventBody('APP_DISCONNECT', account, minutesAgo(10)))).status).toBe(200)
    expect(await connectionsLeft([fresh])).toBe(1)
    expect(await connectionsLeft([old])).toBe(0)
    // Within the clock-skew margin counts as newer: a connect right after the event is not wiped.
    const quick = await connected(other, account, minutesAgo(9.5))
    expect((await deliver(eventBody('APP_DISCONNECT', account, minutesAgo(9)))).status).toBe(200)
    expect(await connectionsLeft([quick])).toBe(1)
    // Without a usable event time, every connection to the account goes (as before).
    expect((await deliver(eventBody('APP_DISCONNECT', account, 'not a time'))).status).toBe(200)
    expect((await deliver(eventBody('APP_DISCONNECT', account, undefined))).status).toBe(200)
    expect(await connectionsLeft([fresh, quick])).toBe(0)
  })

  test('a connection that moved to another account while the delivery waited for it stays', async () => {
    await clean(ws)
    const account = encodedAccount()
    const moved = encodedAccount()
    const id = await connected(ws, account)
    let release!: () => void
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    let locked!: () => void
    const isLocked = new Promise<void>(resolve => {
      locked = resolve
    })
    // A connect again to another Jobber account: it holds the connection lock (and only the new account's lock).
    const reconnect = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app:${id}`}))`)
      locked()
      await released
      await tx.update(app_connections).set({ account_id: moved }).where(eq(app_connections.id, id))
    })
    await isLocked
    const delivery = deliver(eventBody('APP_DISCONNECT', account))
    await new Promise(resolve => setTimeout(resolve, 300))
    release()
    await reconnect
    expect((await delivery).status).toBe(200)
    expect(await connectionsLeft([id])).toBe(1)
    await clean(ws)
  })

  test('without a Jobber app on the install it is 404', async () => {
    await db.delete(provider_settings).where(eq(provider_settings.provider, 'jobber'))
    const body = eventBody('APP_DISCONNECT', encodedAccount())
    expect((await deliver(body)).status).toBe(404)
    await setProviderKeys(
      db,
      'jobber',
      { client_id: 'jobber-client-id', client_secret: SECRET },
      ws.owner.userId,
      new Date().toISOString(),
    )
  })
})
