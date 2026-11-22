// Support mailboxes (LIN-637): connect Gmail or Microsoft 365 by OAuth, read only, with the tokens encrypted and
// refreshed, disconnect with revocation; who may do it and in which workspace. Handlers run with a fake provider
// inside a transaction that is rolled back; permissions and the callback go through the API.
import { actions, rolePermissions } from '@linedesk/actions'
import { mail_analyses, mail_connections, mail_credentials, mail_oauth_states, type Tx } from '@linedesk/db'
import { MailError, type MailOAuth, type MailProvider, type OAuthTokens } from '@linedesk/mail'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { Forbidden } from '../src/handler-context.ts'
import { runHandler, type Undo } from '../src/handlers.ts'
import { mailCallback } from '../src/mail-callback.ts'
import { type MailServices, mailboxFor, mailRedirectUri, mailSlot } from '../src/mail-connections.ts'
import { decryptSecret } from '../src/secrets.ts'
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

const READ = 'openid email https://www.googleapis.com/auth/gmail.readonly'
const MAILBOX = 'Help@Brightwater.example'

/** A Gmail account in memory: OAuth that hands out numbered tokens, and a mailbox with one message. */
function fakeGmail({ scope = READ, grant = 'refresh-1' as string | null, listFails = null as MailError | null } = {}) {
  let issued = 0
  const issue = (refreshToken: string | null, expiresInMs = 3600_000): OAuthTokens => ({
    accessToken: `access-${++issued}`,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    scope,
  })
  const oauth = {
    name: 'google' as const,
    scopes: [],
    authorizeUrl: vi.fn(
      ({ redirectUri, state }: { redirectUri: string; state: string }) =>
        `https://accounts.google.test/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    ),
    exchangeCode: vi.fn(async ({ code }: { code: string }) => {
      if (code !== 'good-code')
        throw new MailError('google', 'auth', 'connect failed: invalid_grant', 400, 'invalid_grant')
      return issue(grant)
    }),
    refresh: vi.fn(async () => issue(null)),
    revoke: vi.fn(async () => true),
    accountEmail: vi.fn(async () => MAILBOX),
    grantsMailRead: (granted: string | null) => granted === null || granted.includes('gmail.readonly'),
  } satisfies MailOAuth
  const tokens: string[] = []
  const provider = (accessToken: () => Promise<string>): MailProvider => ({
    name: 'google',
    listMessages: vi.fn(async () => {
      tokens.push(await accessToken())
      if (listFails) throw listFails
      return { messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: null }
    }),
    getMessage: vi.fn(async () => null),
  })
  const services: MailServices = { oauth: async () => oauth, provider: (_name, o) => provider(() => o.accessToken()) }
  return { oauth, services, tokens }
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

const run = (tx: Tx, actor: Actor, services: MailServices, name: string, input: unknown, undos: Undo[] = []) =>
  runHandler(
    { tx, actor, now: new Date().toISOString(), mail: services, onRollback: u => undos.push(u) },
    actions.get(name)!,
    actions.get(name)!.input.parse(input),
  )

const stateOf = (url: unknown) => new URL(url as string).searchParams.get('state')!

/** connectStart and connectFinish as the member's browser would run them; returns the connection id. */
async function connect(tx: Tx, services: MailServices, actor = owner) {
  const started = await run(tx, actor, services, 'mail.connectStart', { provider: 'google' })
  const finished = await run(tx, actor, services, 'mail.connectFinish', {
    provider: 'google',
    state: stateOf(started.data!.url),
    code: 'good-code',
  })
  return finished.data!.connectionId as string
}

describe('connecting a mailbox', () => {
  test('the consent URL carries a state bound to the member and workspace', async () => {
    const { services } = fakeGmail()
    await inRollback(async tx => {
      const { data } = await run(tx, owner, services, 'mail.connectStart', { provider: 'google' })
      const url = new URL(data!.url as string)
      const state = url.searchParams.get('state')!
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(url.searchParams.get('redirect_uri')).toBe(mailRedirectUri('google'))
      const [row] = await tx.select().from(mail_oauth_states).where(eq(mail_oauth_states.id, state))
      expect(row).toMatchObject({ workspace_id: ws.id, user_id: ws.owner.userId, provider: 'google' })
      expect(Date.parse(row!.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60_000)
    })
  })

  test('finishing reads one message, stores the mailbox with its tokens encrypted, and uses the state once', async () => {
    const { services, tokens } = fakeGmail()
    await inRollback(async tx => {
      const started = await run(tx, owner, services, 'mail.connectStart', { provider: 'google' })
      const state = stateOf(started.data!.url)
      const { rows, data } = await run(tx, owner, services, 'mail.connectFinish', {
        provider: 'google',
        state,
        code: 'good-code',
      })
      expect(rows.mail_connections).toMatchObject([
        {
          workspace_id: ws.id,
          provider: 'google',
          account_email: 'help@brightwater.example',
          status: 'connected',
          connected_by: ws.owner.userId,
        },
      ])
      expect(tokens).toEqual(['access-1'])
      const id = data!.connectionId as string
      const [credentials] = await tx.select().from(mail_credentials).where(eq(mail_credentials.connection_id, id))
      expect(credentials!.refresh_token_encrypted).not.toContain('refresh-1')
      expect(decryptSecret(credentials!.refresh_token_encrypted, mailSlot(id, 'refresh'))).toBe('refresh-1')
      // Bound to its connection and kind: the access token does not decrypt as the refresh token.
      expect(() => decryptSecret(credentials!.access_token_encrypted, mailSlot(id, 'refresh'))).toThrow()
      await expect(
        run(tx, owner, services, 'mail.connectFinish', { provider: 'google', state, code: 'good-code' }),
      ).rejects.toMatchObject({ code: 'expired' })
    })
  })

  test("another member's state, or one from another workspace, is refused", async () => {
    const { services } = fakeGmail()
    await inRollback(async tx => {
      const otherOwner: Actor = {
        actorId: other.owner.userId,
        role: 'owner',
        workspaceId: other.id,
        permissions: rolePermissions.owner,
      }
      const started = await run(tx, owner, services, 'mail.connectStart', { provider: 'google' })
      await expect(
        run(tx, otherOwner, services, 'mail.connectFinish', {
          provider: 'google',
          state: stateOf(started.data!.url),
          code: 'good-code',
        }),
      ).rejects.toMatchObject({ code: 'expired' })
      const again = await run(tx, owner, services, 'mail.connectStart', { provider: 'google' })
      await expect(
        run(tx, { ...owner, workspaceId: other.id }, services, 'mail.connectFinish', {
          provider: 'google',
          state: stateOf(again.data!.url),
          code: 'good-code',
        }),
      ).rejects.toMatchObject({ code: 'other_workspace' })
      expect(await tx.select().from(mail_connections).where(eq(mail_connections.workspace_id, other.id))).toEqual([])
    })
  })

  test('without the read scope, or without a refresh token, the connect is refused and the new grant revoked', async () => {
    for (const [fake, code] of [
      [fakeGmail({ scope: 'openid email' }), 'scope'],
      [fakeGmail({ grant: null }), 'no_grant'],
    ] as const) {
      await inRollback(async tx => {
        const undos: Undo[] = []
        const started = await run(tx, owner, fake.services, 'mail.connectStart', { provider: 'google' })
        await expect(
          run(
            tx,
            owner,
            fake.services,
            'mail.connectFinish',
            { provider: 'google', state: stateOf(started.data!.url), code: 'good-code' },
            undos,
          ),
        ).rejects.toMatchObject({ code })
        expect(await Promise.all(undos.map(u => u()))).toEqual(['the new access was revoked'])
        expect(fake.oauth.revoke).toHaveBeenCalledTimes(1)
      })
    }
  })

  test('a failed reconnect of a mailbox connected already keeps its grant (Google would withdraw the working one)', async () => {
    const fake = fakeGmail({ scope: 'openid email' })
    const id = 'mail_kept_grant_test'
    await db.insert(mail_connections).values({
      id,
      workspace_id: other.id,
      provider: 'google',
      account_email: MAILBOX.toLowerCase(),
      connected_by: other.owner.userId,
    })
    try {
      await inRollback(async tx => {
        const undos: Undo[] = []
        const started = await run(tx, owner, fake.services, 'mail.connectStart', { provider: 'google' })
        await expect(
          run(
            tx,
            owner,
            fake.services,
            'mail.connectFinish',
            { provider: 'google', state: stateOf(started.data!.url), code: 'good-code' },
            undos,
          ),
        ).rejects.toMatchObject({ code: 'scope' })
        expect(await Promise.all(undos.map(u => u()))).toEqual([
          'the access was kept: the mailbox is connected already',
        ])
        expect(fake.oauth.revoke).not.toHaveBeenCalled()
      })
    } finally {
      await db.delete(mail_connections).where(eq(mail_connections.id, id))
    }
  })

  test("the Gmail API off in the app's project is refused with its own code", async () => {
    const { services } = fakeGmail({
      listFails: new MailError('google', 'invalid', 'list messages failed', 403, 'api_disabled'),
    })
    await inRollback(async tx => {
      const started = await run(tx, owner, services, 'mail.connectStart', { provider: 'google' })
      await expect(
        run(tx, owner, services, 'mail.connectFinish', {
          provider: 'google',
          state: stateOf(started.data!.url),
          code: 'good-code',
        }),
      ).rejects.toMatchObject({ code: 'api_disabled' })
    })
  })

  test('a refused code is a rejection the page words', async () => {
    const { services } = fakeGmail()
    await inRollback(async tx => {
      const started = await run(tx, owner, services, 'mail.connectStart', { provider: 'google' })
      await expect(
        run(tx, owner, services, 'mail.connectFinish', {
          provider: 'google',
          state: stateOf(started.data!.url),
          code: 'bad-code',
        }),
      ).rejects.toMatchObject({ code: 'account_refused' })
    })
  })

  test('connecting the same mailbox again updates the one connection', async () => {
    const { services } = fakeGmail()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      await tx
        .update(mail_connections)
        .set({ status: 'needs_reconnect', last_error: 'x' })
        .where(eq(mail_connections.id, id))
      expect(await connect(tx, services)).toBe(id)
      const [row] = await tx.select().from(mail_connections).where(eq(mail_connections.id, id))
      expect(row).toMatchObject({ status: 'connected', last_error: null })
    })
  })

  test('a new mailbox starts the support mail analysis by itself (12 months); a reconnect starts nothing', async () => {
    const { services } = fakeGmail()
    await inRollback(async tx => {
      const analyses = () => tx.select().from(mail_analyses).where(eq(mail_analyses.workspace_id, ws.id))
      const id = await connect(tx, services)
      expect(await analyses()).toMatchObject([{ status: 'queued', months: 12 }])
      await tx.update(mail_analyses).set({ status: 'done' }).where(eq(mail_analyses.workspace_id, ws.id))
      expect(await connect(tx, services)).toBe(id)
      expect(await analyses()).toHaveLength(1)
    })
  })

  test('not while an instance admin is signed in as the member', async () => {
    const { services } = fakeGmail()
    await inRollback(async tx => {
      const impersonated = {
        ...owner,
        impersonation: { by: 'admin', sessionId: 's', expiresAt: new Date(Date.now() + 60_000) },
      }
      await expect(run(tx, impersonated, services, 'mail.connectStart', { provider: 'google' })).rejects.toBeInstanceOf(
        Forbidden,
      )
    })
  })

  test('without the Gmail app set up by an instance admin the connect is refused, with a code the page words', async () => {
    const { status, body } = await act(ws.owner, 'mail.connectStart', { provider: 'google' })
    expect(status).toBe(409)
    expect(body).toMatchObject({ ok: false, code: 'not_set_up' })
  })
})

describe('tokens', () => {
  test('an access token about to run out is refreshed and stored again, keeping the refresh token', async () => {
    const { services, oauth } = fakeGmail()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      await tx
        .update(mail_credentials)
        .set({ expires_at: new Date(Date.now() + 10_000).toISOString() })
        .where(eq(mail_credentials.connection_id, id))
      const { provider } = await mailboxFor(tx, { mail: services }, ws.id, id)
      await provider.listMessages()
      expect(oauth.refresh).toHaveBeenCalledWith('refresh-1')
      const [credentials] = await tx.select().from(mail_credentials).where(eq(mail_credentials.connection_id, id))
      expect(decryptSecret(credentials!.access_token_encrypted, mailSlot(id, 'access'))).toBe('access-2')
      expect(decryptSecret(credentials!.refresh_token_encrypted, mailSlot(id, 'refresh'))).toBe('refresh-1')
    })
  })

  test("another workspace's mailbox is not found", async () => {
    const { services } = fakeGmail()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      await expect(mailboxFor(tx, { mail: services }, other.id, id)).rejects.toMatchObject({ code: 'not_connected' })
    })
  })
})

describe('disconnecting', () => {
  test('deletes the mailbox with its tokens and withdraws the grant', async () => {
    const { services, oauth } = fakeGmail()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      const { data, deleted } = await run(tx, owner, services, 'mail.disconnect', { connectionId: id })
      expect(data).toEqual({ revoked: true })
      expect(deleted).toEqual({ mail_connections: [id] })
      expect(oauth.revoke).toHaveBeenCalledWith('refresh-1')
      expect(await tx.select().from(mail_credentials).where(eq(mail_credentials.connection_id, id))).toEqual([])
    })
  })

  test('a grant another workspace holds too (same mailbox) is not withdrawn', async () => {
    const { services, oauth } = fakeGmail()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      await connect(tx, services, {
        actorId: other.owner.userId,
        role: 'owner',
        workspaceId: other.id,
        permissions: rolePermissions.owner,
      })
      expect((await run(tx, owner, services, 'mail.disconnect', { connectionId: id })).data).toEqual({ revoked: false })
      expect(oauth.revoke).not.toHaveBeenCalled()
    })
  })

  test("another workspace's mailbox, or none, is a rejection", async () => {
    const { services } = fakeGmail()
    await inRollback(async tx => {
      const id = await connect(tx, services)
      const otherOwner: Actor = { ...owner, actorId: other.owner.userId, workspaceId: other.id }
      await expect(run(tx, otherOwner, services, 'mail.disconnect', { connectionId: id })).rejects.toMatchObject({
        code: 'not_connected',
      })
      expect(await tx.select().from(mail_connections).where(eq(mail_connections.id, id))).toHaveLength(1)
    })
  })
})

describe('through the API', () => {
  test('members, and the agent, cannot connect or disconnect', async () => {
    for (const name of ['mail.connectStart', 'mail.connectFinish', 'mail.disconnect']) {
      expect(actions.get(name)!.permission, name).toBe('settings:write')
      expect((await act(member, name, {})).status, name).toBe(403)
      expect((await act(agent(ws.id), name, {})).status, name).toBe(403)
    }
  })

  test('the code and the state are never stored in the command log', () => {
    expect(actions.get('mail.connectFinish')!.sensitive).toEqual(['code', 'state'])
  })

  test('the callback sends the browser back to the card of its provider (Gmail, Outlook), with a reason code when it fails, never text', async () => {
    const web = 'http://app.test'
    const headers = new Headers(ws.owner.headers)
    const target = (url: string) =>
      Object.fromEntries(new URLSearchParams(url.split(/#integrations\/(?:gmail|outlook-mail)\?/)[1]))
    expect(await mailCallback('google', new URLSearchParams({ error: 'access_denied' }), headers, web)).toMatch(
      /^http:\/\/app\.test\/#integrations\/gmail\?/,
    )
    expect(await mailCallback('microsoft', new URLSearchParams({ error: 'access_denied' }), headers, web)).toMatch(
      /^http:\/\/app\.test\/#integrations\/outlook-mail\?/,
    )
    expect(target(await mailCallback('google', new URLSearchParams({ error: 'access_denied' }), headers, web))).toEqual(
      {
        mail: 'error',
        reason: 'denied',
      },
    )
    expect(target(await mailCallback('yahoo', new URLSearchParams({ code: 'c', state: 's' }), headers, web))).toEqual({
      mail: 'error',
      reason: 'failed',
    })
    expect(
      target(
        await mailCallback('google', new URLSearchParams({ code: 'c', state: 'x'.repeat(20) }), new Headers(), web),
      ),
    ).toEqual({ mail: 'error', reason: 'signed_out' })
    // A state nobody started: expired, as a code.
    expect(
      target(await mailCallback('google', new URLSearchParams({ code: 'c', state: 'x'.repeat(20) }), headers, web)),
    ).toEqual({ mail: 'error', reason: 'expired' })
  })
})
