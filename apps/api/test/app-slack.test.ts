// Slack as a connected app (docs/crm-sync.md, "Slack"): connecting stores the channel's incoming webhook encrypted
// beside the bot token, disconnecting uninstalls the app unless another workspace uses the same Slack workspace, and
// every finished call is one post with the Slack switches ("only urgent calls"). A fake Slack, no real Slack calls.
// Instance-wide (vitest.config.ts): a refused client secret is recorded as the Slack provider failing.
import { actions, rolePermissions } from '@linedesk/actions'
import { type AppConnector, AppError, type AppOAuth, type FinishedCall, type OAuthTokens } from '@linedesk/connectors'
import { app_connections, app_credentials, app_pushes, calls, provider_failures, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test, vi } from 'vitest'
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

const HOOK = 'https://hooks.slack.com/services/T0001/B0001/abc'

/** A Slack workspace in memory: an install that hands out a bot token and a webhook, and a connector that records. */
function fakeSlack({ team = 'T9TK3CUKW', webhook = true as boolean } = {}) {
  let issued = 0
  const oauth = {
    id: 'slack' as const,
    scopes: ['incoming-webhook'],
    grantPerAccount: true,
    authorizeUrl: vi.fn(
      ({ redirectUri, state }: { redirectUri: string; state: string }) =>
        `https://slack.test/oauth/v2/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    ),
    exchangeCode: vi.fn(
      async (): Promise<OAuthTokens> => ({
        accessToken: `xoxb-${++issued}`,
        refreshToken: null,
        expiresAt: null,
        scope: 'incoming-webhook',
        webhook: webhook ? { url: HOOK, channel: '#calls' } : null,
        account: { id: team, name: 'Brightwater Plumbing' },
      }),
    ),
    refresh: vi.fn(async (): Promise<OAuthTokens> => {
      throw new AppError('slack', 'auth', 'no rotation')
    }),
    revoke: vi.fn(async () => true),
    account: vi.fn(async () => ({ id: team, name: 'Brightwater Plumbing' })),
  } satisfies AppOAuth
  const posted: { call: FinishedCall; url: string }[] = []
  const pushCall = vi.fn<AppConnector['pushCall']>(async (access, call, progress) => {
    posted.push({ call, url: await access.webhookUrl!() })
    await progress?.onLogged?.(call.callId)
    return { recordId: null, activityId: call.callId }
  })
  const services: AppServices = { oauth: async () => oauth, connector: () => ({ id: 'slack', crm: false, pushCall }) }
  return { oauth, services, pushCall, posted }
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
  const started = await run(tx, actor, services, 'app.connectStart', { app: 'slack' })
  const state = new URL(started.data!.url as string).searchParams.get('state')!
  const finished = await run(tx, actor, services, 'app.connectFinish', { app: 'slack', state, code: 'c' }, undos)
  return finished.data!.connectionId as string
}

describe('connecting Slack', () => {
  test('stores the workspace and channel on the connection, the token and webhook only encrypted', async () => {
    const { services } = fakeSlack()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      const [row] = await tx.select().from(app_connections).where(eq(app_connections.id, id))
      expect(row).toMatchObject({
        provider: 'slack',
        account_id: 'T9TK3CUKW',
        account_name: 'Brightwater Plumbing',
        channel: '#calls',
        status: 'connected',
      })
      expect(JSON.stringify(row)).not.toContain('hooks.slack.com')
      const [credentials] = await tx.select().from(app_credentials).where(eq(app_credentials.connection_id, id))
      expect(credentials!.webhook_url_encrypted).not.toContain('hooks.slack.com')
      expect(decryptSecret(credentials!.webhook_url_encrypted!, appSlot(row!, 'webhook'))).toBe(HOOK)
      // The bot token is the lasting grant (no refresh token without rotation), and it does not run out.
      expect(decryptSecret(credentials!.refresh_token_encrypted, appSlot(row!, 'refresh'))).toBe('xoxb-1')
      expect(credentials!.expires_at.startsWith('9999')).toBe(true)
    })
  })

  test('without a channel the connect is refused and the install withdrawn', async () => {
    const { services, oauth } = fakeSlack({ webhook: false })
    await inRollback(async tx => {
      const undos: Undo[] = []
      await expect(connect(tx, services, owner, undos)).rejects.toThrow(/channel/)
      expect(await Promise.all(undos.map(u => u()))).toEqual(['the new access was revoked'])
      expect(oauth.revoke).toHaveBeenCalledWith('xoxb-1')
    })
  })

  test('a client ID or secret Slack refuses is not_set_up for the member and a Slack failure for Server admin', async () => {
    const { services, oauth } = fakeSlack()
    oauth.exchangeCode.mockRejectedValueOnce(new AppError('slack', 'client', 'connect failed: bad_client_secret'))
    await inRollback(async tx => {
      await expect(connect(tx, services)).rejects.toMatchObject({ code: 'not_set_up' })
    })
    await vi.waitFor(async () =>
      expect(
        (await db.select().from(provider_failures).where(eq(provider_failures.provider, 'slack')))[0],
      ).toMatchObject({ reason: 'auth' }),
    )
    await db.delete(provider_failures).where(eq(provider_failures.provider, 'slack'))
  })
})

describe('disconnecting Slack', () => {
  test('uninstalls the app with the bot token once the delete has committed', async () => {
    const { services, oauth } = fakeSlack()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      const commits: (() => Promise<void>)[] = []
      const { data } = await run(tx, owner, services, 'app.disconnect', { app: 'slack' }, [], commits)
      await Promise.all(commits.map(w => w()))
      expect(data).toEqual({ revoked: true })
      expect(oauth.revoke).toHaveBeenCalledWith('xoxb-1')
      expect(await tx.select().from(app_credentials).where(eq(app_credentials.connection_id, id))).toEqual([])
    })
  })

  test('keeps the app installed while another workspace posts to the same Slack workspace', async () => {
    const { services, oauth } = fakeSlack()
    await inRollback(async tx => {
      await connect(tx, services)
      await connect(tx, services, otherOwner)
      const commits: (() => Promise<void>)[] = []
      const { data } = await run(tx, owner, services, 'app.disconnect', { app: 'slack' }, [], commits)
      await Promise.all(commits.map(w => w()))
      expect(data).toEqual({ revoked: false })
      expect(oauth.revoke).not.toHaveBeenCalled()
    })
  })
})

/** A committed Slack connection, so call.finish (its own transaction) queues a push for it. */
async function committedSlack(workspace: Workspace, settings: Record<string, boolean> = {}) {
  const id = `appc_${crypto.randomUUID().slice(0, 12)}`
  const [connection] = await db
    .insert(app_connections)
    .values({
      id,
      workspace_id: workspace.id,
      provider: 'slack',
      account_id: `T${crypto.randomUUID().slice(0, 8)}`,
      account_name: 'Brightwater Plumbing',
      channel: '#calls',
      connected_by: workspace.owner.userId,
      settings,
    })
    .returning()
  await db.insert(app_credentials).values({
    connection_id: id,
    workspace_id: workspace.id,
    access_token_encrypted: encryptSecret('xoxb-stored', appSlot(connection!, 'access')),
    refresh_token_encrypted: encryptSecret('xoxb-stored', appSlot(connection!, 'refresh')),
    webhook_url_encrypted: encryptSecret(HOOK, appSlot(connection!, 'webhook')),
    expires_at: '9999-12-31T00:00:00.000Z',
    scope: 'incoming-webhook',
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

describe('posting finished calls to Slack', () => {
  test('posts to the stored webhook with the urgent flag and labels; a withheld number still posts', async () => {
    const shop = await createWorkspace('Brightwater Slack')
    const connection = await committedSlack(shop)
    const { services, posted } = fakeSlack()
    const callId = await finishedCall(shop)
    await db.update(calls).set({ urgency: 'urgent', from_number: 'anonymous' }).where(eq(calls.id, callId))
    await inRollback(async tx => {
      expect(await attemptAppPush((await pushOf(connection.id, callId)).id, services, tx)).toBe('done')
      expect(posted[0]!.url).toBe(HOOK)
      expect(posted[0]!.call).toMatchObject({ urgent: true, summary: 'Water heater leaking.' })
      expect(posted[0]!.call.labels).toMatchObject({ caller: 'Caller', number: 'Number', urgent: 'Urgent' })
      expect(posted[0]!.call.labels.when).toMatch(/UTC$/)
    })
  })

  test('"only urgent calls" skips a call that is not urgent, with its reason, and posts one that is', async () => {
    const shop = await createWorkspace('Brightwater Slack')
    const connection = await committedSlack(shop, { only_urgent: true })
    const { services, pushCall } = fakeSlack()
    const calm = await finishedCall(shop)
    const urgent = await finishedCall(shop)
    await db.update(calls).set({ urgency: 'urgent' }).where(eq(calls.id, urgent))
    await inRollback(async tx => {
      const calmPush = (await pushOf(connection.id, calm)).id
      expect(await attemptAppPush(calmPush, services, tx)).toBe('skipped')
      expect((await tx.select().from(app_pushes).where(eq(app_pushes.id, calmPush)))[0]).toMatchObject({
        status: 'skipped',
        error_code: 'not_urgent',
      })
      expect(pushCall).not.toHaveBeenCalled()
      expect(await attemptAppPush((await pushOf(connection.id, urgent)).id, services, tx)).toBe('done')
    })
  })

  test('a deleted or archived channel asks for attention at once', async () => {
    const shop = await createWorkspace('Brightwater Slack')
    const connection = await committedSlack(shop)
    const { services, pushCall } = fakeSlack()
    const callId = await finishedCall(shop)
    await inRollback(async tx => {
      pushCall.mockRejectedValueOnce(new AppError('slack', 'channel_archived', 'posting the call failed', 410))
      expect(await attemptAppPush((await pushOf(connection.id, callId)).id, services, tx)).toBe('failed')
      expect((await tx.select().from(app_connections).where(eq(app_connections.id, connection.id)))[0]).toMatchObject({
        status: 'needs_attention',
        error_code: 'channel_archived',
      })
    })
  })

  test('a rate limit is retried after the wait Slack asked for', async () => {
    const shop = await createWorkspace('Brightwater Slack')
    const connection = await committedSlack(shop)
    const { services, pushCall } = fakeSlack()
    const callId = await finishedCall(shop)
    await inRollback(async tx => {
      pushCall.mockRejectedValueOnce(new AppError('slack', 'rate_limited', 'posting the call failed', 429, 30))
      const waits: number[] = []
      expect(await attemptAppPush((await pushOf(connection.id, callId)).id, services, tx, s => waits.push(s))).toBe(
        'retry',
      )
      expect(waits).toEqual([30])
    })
  })
})

test('the callback sends the browser back to the Slack page', async () => {
  const web = 'https://app.example'
  expect(await appCallback('slack', new URLSearchParams({ error: 'access_denied' }), new Headers(), web)).toBe(
    'https://app.example/#integrations/slack?app=error&reason=denied',
  )
})
