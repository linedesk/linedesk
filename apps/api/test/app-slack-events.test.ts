// Slack's Events API URL (slack-events.ts, LIN-447): a request signed with the Slack app's signing secret that says
// the app was uninstalled (`app_uninstalled`, or `tokens_revoked` with a bot token) deletes every connection to that
// Slack workspace with its tokens and webhook, in every Linedesk workspace; a missing, wrong or stale signature is 401
// and changes nothing; Slack's URL check gets its challenge back; other events are 200 and change nothing; a grant
// stored after the event stays; without a signing secret the route is 404.
// Instance-wide (vitest.config.ts): stores the Slack signing secret in provider_settings.
import { createHmac } from 'node:crypto'
import { app_connections, app_credentials, provider_settings } from '@linedesk/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { appSlot } from '../src/app-connections.ts'
import { db } from '../src/db.ts'
import { setProviderKeys } from '../src/provider-settings.ts'
import { encryptSecret } from '../src/secrets.ts'
import { resetSlackEventsLimits, SLACK_EVENTS_PATH, slackRequest } from '../src/slack-events.ts'
import { appRequest, createWorkspace, type Workspace } from './helpers.ts'

/** Made-up secrets, put together at run time so the secret scan never sees a key-shaped string. */
const SECRET = ['slack', 'made', 'up', 'signing', 'secret', '0123456789'].join('-')
const STRANGER = ['someone', 'elses', 'secret', '0123456789'].join('-')

const now = () => Math.floor(Date.now() / 1000)
const sign = (body: string, timestamp: number, secret = SECRET) =>
  `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`, 'utf8').digest('hex')}`

const keys = () => ({
  client_id: '1234567890.1234567890',
  client_secret: 'slack-client-secret',
  signing_secret: SECRET,
})

const teamId = () => `T${Math.floor(Math.random() * 1e10)}`
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const uninstalled = (team: string, eventTime: number | undefined = now(), extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    token: 'legacy-token',
    team_id: team,
    api_app_id: 'A0000000000',
    event: { type: 'app_uninstalled' },
    type: 'event_callback',
    authorizations: [{ team_id: team, user_id: 'U0000000000', is_bot: false, is_enterprise_install: false }],
    event_id: `Ev${Math.floor(Math.random() * 1e9)}`,
    event_time: eventTime,
    ...extra,
  })

const revoked = (team: string, tokens: Record<string, string[]>) =>
  JSON.stringify({
    team_id: team,
    api_app_id: 'A0000000000',
    event: { type: 'tokens_revoked', tokens },
    type: 'event_callback',
    event_id: `Ev${Math.floor(Math.random() * 1e9)}`,
    event_time: now(),
  })

const deliver = (body: string, opts: { timestamp?: number; signature?: string | null } = {}) => {
  const timestamp = opts.timestamp ?? now()
  const signature = opts.signature === undefined ? sign(body, timestamp) : opts.signature
  return appRequest(SLACK_EVENTS_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': String(timestamp),
      ...(signature === null ? {} : { 'x-slack-signature': signature }),
    },
    body,
  })
}

let ws: Workspace
let other: Workspace

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Brightwater Annex')
  await setProviderKeys(db, 'slack', keys(), ws.owner.userId, new Date().toISOString())
})

afterAll(async () => {
  await db.delete(provider_settings).where(eq(provider_settings.provider, 'slack'))
})

beforeEach(() => resetSlackEventsLimits())

async function connected(workspace: Workspace, accountId: string, grantedAt = minutesAgo(10)) {
  const id = `appc_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  const [connection] = await db
    .insert(app_connections)
    .values({
      id,
      workspace_id: workspace.id,
      provider: 'slack',
      account_id: accountId,
      account_name: 'Brightwater',
      connected_by: workspace.owner.userId,
      settings: {},
    })
    .returning()
  await db.insert(app_credentials).values({
    connection_id: id,
    workspace_id: workspace.id,
    access_token_encrypted: encryptSecret('bot-token-stored', appSlot(connection!, 'access')),
    refresh_token_encrypted: '',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    scope: 'incoming-webhook',
    webhook_url_encrypted: encryptSecret('https://hooks.slack.com/services/x', appSlot(connection!, 'webhook')),
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
      .where(and(eq(app_connections.workspace_id, w.id), eq(app_connections.provider, 'slack')))
}

describe('Slack Events API: uninstall', () => {
  test('a signed app_uninstalled deletes every connection to that Slack workspace with its tokens, and only those', async () => {
    await clean(ws, other)
    const team = teamId()
    const ids = [await connected(ws, team), await connected(other, team)]
    const third = await createWorkspace('Brightwater North')
    const kept = await connected(third, teamId())
    const res = await deliver(uninstalled(team))
    expect(res.status).toBe(200)
    expect(await connectionsLeft(ids)).toBe(0)
    expect(await credentialsLeft(ids)).toBe(0)
    expect(await connectionsLeft([kept])).toBe(1)
    await clean(ws, other, third)
  })

  test('a repeated delivery is 200 and changes nothing more', async () => {
    await clean(ws)
    const team = teamId()
    const id = await connected(ws, team)
    const body = uninstalled(team)
    expect((await deliver(body)).status).toBe(200)
    expect((await deliver(body)).status).toBe(200)
    expect(await connectionsLeft([id])).toBe(0)
  })

  test('a missing, malformed, wrong or stale signature is 401 and changes nothing', async () => {
    await clean(ws)
    const team = teamId()
    const id = await connected(ws, team)
    const body = uninstalled(team)
    const ts = now()
    expect((await deliver(body, { signature: null })).status).toBe(401)
    expect((await deliver(body, { signature: 'v0=nothex' })).status).toBe(401)
    expect((await deliver(body, { signature: sign(body, ts, STRANGER), timestamp: ts })).status).toBe(401)
    // Signed for another timestamp, or another body.
    expect((await deliver(body, { signature: sign(body, ts - 1), timestamp: ts })).status).toBe(401)
    expect((await deliver(body, { signature: sign(uninstalled(teamId()), ts), timestamp: ts })).status).toBe(401)
    // Correctly signed but replayed ten minutes later.
    const old = ts - 600
    expect((await deliver(body, { signature: sign(body, old), timestamp: old })).status).toBe(401)
    expect(await connectionsLeft([id])).toBe(1)
    expect(await credentialsLeft([id])).toBe(1)
    await clean(ws)
  })

  test("Slack's URL check gets its challenge back, only when signed", async () => {
    const body = JSON.stringify({ token: 'legacy', challenge: 'abc123challenge', type: 'url_verification' })
    const res = await deliver(body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ challenge: 'abc123challenge' })
    expect((await deliver(body, { signature: sign(body, now(), STRANGER) })).status).toBe(401)
  })

  test('tokens_revoked removes the connection only when a bot token was revoked; other events change nothing', async () => {
    await clean(ws)
    const team = teamId()
    const id = await connected(ws, team)
    const userOnly = await deliver(revoked(team, { oauth: ['U1'] }))
    expect(userOnly.status).toBe(200)
    expect(await userOnly.json()).toMatchObject({ ok: true, ignored: true })
    const message = JSON.stringify({ type: 'event_callback', team_id: team, event: { type: 'message' } })
    expect((await deliver(message)).status).toBe(200)
    expect((await deliver('not json')).status).toBe(200)
    expect(await connectionsLeft([id])).toBe(1)
    expect((await deliver(revoked(team, { bot: ['U2'] }))).status).toBe(200)
    expect(await connectionsLeft([id])).toBe(0)
  })

  test('an org-wide install goes only when the event says the install is org-wide', async () => {
    await clean(ws)
    const enterprise = `E${Math.floor(Math.random() * 1e10)}`
    const id = await connected(ws, enterprise)
    // One workspace of the organisation removed the app: the organisation's install stays.
    expect((await deliver(uninstalled(teamId(), now(), { enterprise_id: enterprise }))).status).toBe(200)
    expect(await connectionsLeft([id])).toBe(1)
    const orgWide = uninstalled(teamId(), now(), {
      enterprise_id: enterprise,
      is_enterprise_install: true,
      authorizations: [{ enterprise_id: enterprise, is_enterprise_install: true }],
    })
    expect((await deliver(orgWide)).status).toBe(200)
    expect(await connectionsLeft([id])).toBe(0)
  })

  test('a grant stored after the event stays; one stored before it goes', async () => {
    await clean(ws, other)
    const team = teamId()
    const fresh = await connected(ws, team, minutesAgo(9))
    const old = await connected(other, team, minutesAgo(120))
    expect((await deliver(uninstalled(team, now() - 600))).status).toBe(200)
    expect(await connectionsLeft([fresh])).toBe(1)
    expect(await connectionsLeft([old])).toBe(0)
    await clean(ws, other)
  })

  test('without a signing secret on the install it is 404', async () => {
    await setProviderKeys(
      db,
      'slack',
      { client_id: '1234567890.1234567890', client_secret: 'slack-client-secret', signing_secret: '' },
      ws.owner.userId,
      new Date().toISOString(),
    )
    expect((await deliver(uninstalled(teamId()))).status).toBe(404)
    await setProviderKeys(db, 'slack', keys(), ws.owner.userId, new Date().toISOString())
  })

  test('reads the event shape defensively', () => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    expect(slackRequest(bytes(null))).toEqual({ kind: 'other' })
    expect(slackRequest(bytes({ type: 'url_verification' }))).toEqual({ kind: 'other' })
    expect(slackRequest(bytes({ type: 'event_callback', event: { type: 'app_uninstalled' } }))).toEqual({
      kind: 'other',
    })
    expect(slackRequest(bytes({ type: 'event_callback', team_id: 'T1', event: { type: 'app_uninstalled' } }))).toEqual({
      kind: 'removed',
      accountIds: ['T1'],
      eventTime: null,
    })
  })
})
