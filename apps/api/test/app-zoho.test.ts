// Zoho CRM as a connected app (docs/crm-sync.md, "Zoho CRM"): connecting exchanges the code at the data centre the
// callback names (only one Zoho lists), stores the org with the tokens encrypted and marked with that data centre,
// disconnecting revokes the refresh token there, and every finished call finds or adds the contact and logs the call
// at that data centre's API. The real OAuth and connector against a fake Zoho (fake fetch), no real Zoho calls.
import { actions, rolePermissions } from '@linedesk/actions'
import { createZohoConnector, createZohoOAuth } from '@linedesk/connectors'
import { app_connections, app_credentials, app_pushes, crm_links, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { appCallback } from '../src/app-callback.ts'
import { type AppServices, appSlot } from '../src/app-connections.ts'
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

type Seen = { method: string; url: URL; authorization: string | undefined; body: any }

/** A Zoho in memory: accounts servers hand out numbered tokens, the CRM API knows no contacts until one is made. */
function fakeZoho() {
  let issued = 0
  const seen: Seen[] = []
  const doFetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const headers = (init.headers ?? {}) as Record<string, string>
    const raw = typeof init.body === 'string' ? init.body : ''
    const body = headers['content-type']?.includes('json')
      ? JSON.parse(raw)
      : Object.fromEntries(new URLSearchParams(raw))
    seen.push({ method, url, authorization: headers.authorization, body })
    const reply = (status: number, value?: unknown) =>
      new Response(value === undefined ? null : JSON.stringify(value), { status })
    const route = `${method} ${url.pathname}`
    if (route === 'POST /oauth/v2/token') {
      issued++
      return reply(200, {
        access_token: `access-${issued}`,
        ...(body.grant_type === 'authorization_code' ? { refresh_token: `refresh-${issued}` } : {}),
        api_domain: 'https://www.zohoapis.eu',
        expires_in: 3600,
      })
    }
    if (route === 'POST /oauth/v2/revoke/token') return reply(200, {})
    if (route === 'GET /crm/v8/org') return reply(200, { org: [{ id: 'org-1', company_name: 'Brightwater Plumbing' }] })
    if (route === 'GET /crm/v8/Contacts/search') return reply(204)
    const ok = (id: string) => reply(201, { data: [{ code: 'SUCCESS', details: { id }, status: 'success' }] })
    if (route === 'POST /crm/v8/Contacts') return ok('z-new')
    if (route === 'POST /crm/v8/Calls') return ok(`zc-${seen.length}`)
    return reply(404, { code: 'INVALID_URL_PATTERN' })
  }) as typeof fetch
  const oauth = createZohoOAuth({ clientId: '1000.CLIENT', clientSecret: 'secret' }, { fetch: doFetch })
  const services: AppServices = {
    oauth: async () => oauth,
    connector: () => createZohoConnector({ fetch: doFetch }),
  }
  return { services, seen }
}

let ws: Workspace
let owner: Actor

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  owner = { actorId: ws.owner.userId, role: 'owner', workspaceId: ws.id, permissions: rolePermissions.owner }
})

const run = (
  tx: Tx,
  services: AppServices,
  name: string,
  input: unknown,
  undos: Undo[] = [],
  commits: (() => Promise<void>)[] = [],
) =>
  runHandler(
    {
      tx,
      actor: owner,
      now: new Date().toISOString(),
      apps: services,
      onRollback: u => undos.push(u),
      onCommit: w => commits.push(w),
    },
    actions.get(name)!,
    actions.get(name)!.input.parse(input),
  )

async function connect(tx: Tx, services: AppServices, accountsServer: string) {
  const started = await run(tx, services, 'app.connectStart', { app: 'zoho' })
  const consent = new URL(started.data!.url as string)
  expect(consent.origin).toBe('https://accounts.zoho.com')
  const state = consent.searchParams.get('state')!
  const finished = await run(tx, services, 'app.connectFinish', {
    app: 'zoho',
    state,
    code: 'c',
    params: { 'accounts-server': accountsServer },
  })
  return finished.data!.connectionId as string
}

describe('connecting Zoho CRM', () => {
  test("exchanges the code at the account's data centre and stores the org, the tokens only encrypted", async () => {
    const { services, seen } = fakeZoho()
    await inRollback(async tx => {
      const id = await connect(tx, services, 'https://accounts.zoho.eu')
      expect(seen.map(r => `${r.method} ${r.url.origin}${r.url.pathname}`)).toEqual([
        'POST https://accounts.zoho.eu/oauth/v2/token',
        'GET https://www.zohoapis.eu/crm/v8/org',
      ])
      const [row] = await tx.select().from(app_connections).where(eq(app_connections.id, id))
      expect(row).toMatchObject({
        provider: 'zoho',
        account_id: 'org-1',
        account_name: 'Brightwater Plumbing',
        status: 'connected',
      })
      const [credentials] = await tx.select().from(app_credentials).where(eq(app_credentials.connection_id, id))
      expect(credentials!.refresh_token_encrypted).not.toContain('refresh-1')
      expect(decryptSecret(credentials!.refresh_token_encrypted, appSlot(row!, 'refresh'))).toBe('eu|refresh-1')
      expect(decryptSecret(credentials!.access_token_encrypted, appSlot(row!, 'access'))).toBe('eu|access-1')
    })
  })

  test('a callback naming an accounts server Zoho does not list is refused before anything is sent', async () => {
    const { services, seen } = fakeZoho()
    await inRollback(async tx => {
      await expect(connect(tx, services, 'https://accounts.zoho.eu.evil.example')).rejects.toThrow()
      expect(seen).toEqual([])
    })
  })

  test('disconnecting revokes the refresh token at its data centre once the delete has committed', async () => {
    const { services, seen } = fakeZoho()
    await inRollback(async tx => {
      await connect(tx, services, 'https://accounts.zoho.eu')
      const commits: (() => Promise<void>)[] = []
      const { data } = await run(tx, services, 'app.disconnect', { app: 'zoho' }, [], commits)
      await Promise.all(commits.map(w => w()))
      expect(data).toEqual({ revoked: true })
      const revoke = seen.find(r => r.url.pathname === '/oauth/v2/revoke/token')!
      expect(revoke.url.origin).toBe('https://accounts.zoho.eu')
      expect(revoke.body).toEqual({ token: 'refresh-1', token_type: 'refresh_token' })
    })
  })
})

/** A committed EU Zoho connection, so call.finish (its own transaction) queues a push for it. */
async function committedZoho(workspace: Workspace) {
  const id = `appc_${crypto.randomUUID().slice(0, 12)}`
  const [connection] = await db
    .insert(app_connections)
    .values({
      id,
      workspace_id: workspace.id,
      provider: 'zoho',
      account_id: `org-${crypto.randomUUID().slice(0, 8)}`,
      account_name: 'Brightwater Plumbing',
      connected_by: workspace.owner.userId,
      settings: {},
    })
    .returning()
  await db.insert(app_credentials).values({
    connection_id: id,
    workspace_id: workspace.id,
    access_token_encrypted: encryptSecret('eu|access-stored', appSlot(connection!, 'access')),
    refresh_token_encrypted: encryptSecret('eu|refresh-stored', appSlot(connection!, 'refresh')),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    scope: null,
  })
  return connection!
}

test('a finished call adds the caller as a Zoho contact at its data centre and logs the call on it', async () => {
  const shop = await createWorkspace('Brightwater Zoho')
  const connection = await committedZoho(shop)
  const { services, seen } = fakeZoho()
  const started = await act(agent(), 'call.start', { from: shop.contact.phone, to: shop.number, attestation: 'A' })
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const { callId } = started.body.data as { callId: string }
  const finished = await act(agent(shop.id), 'call.finish', {
    callId,
    outcome: 'message',
    summary: 'Water heater leaking.',
    actionItems: [{ text: 'Call Sam back' }],
  })
  expect(finished.status, JSON.stringify(finished.body)).toBe(200)
  const push = (await db.select().from(app_pushes).where(eq(app_pushes.connection_id, connection.id))).find(
    p => p.call_id === callId,
  )!
  await inRollback(async tx => {
    expect(await attemptAppPush(push.id, services, tx)).toBe('done')
    expect(seen.every(r => r.url.origin === 'https://www.zohoapis.eu')).toBe(true)
    expect(seen.every(r => r.authorization === 'Zoho-oauthtoken access-stored')).toBe(true)
    const made = seen.find(r => r.method === 'POST' && r.url.pathname === '/crm/v8/Contacts')!
    expect(made.body.data[0].Phone).toBe(shop.contact.phone)
    const logged = seen.find(r => r.url.pathname === '/crm/v8/Calls')!.body.data[0]
    expect(logged).toMatchObject({ Call_Type: 'Inbound', Who_Id: { id: 'z-new' } })
    expect(logged.Description).toContain('Water heater leaking.')
    expect(logged.Description).toContain('- Call Sam back')
    expect(logged.Description).toContain(`#call/${callId}`)
    const [link] = await tx.select().from(crm_links).where(eq(crm_links.connection_id, connection.id))
    expect(link).toMatchObject({ contact_id: shop.contact.id, external_id: 'z-new' })
  })
})

test('the callback hands Zoho only the accounts server, and sends the browser back to the Zoho page', async () => {
  const web = 'https://app.example'
  expect(await appCallback('zoho', new URLSearchParams({ error: 'access_denied' }), new Headers(), web)).toBe(
    'https://app.example/#integrations/zoho?app=error&reason=denied',
  )
})
