// Calendar accounts: connect by OAuth, encrypted tokens and their refresh, listing calendars,
// the assistant's calendars, disconnect with revocation; who may do it and in which workspace.
// Handlers run with fake providers inside a transaction that is rolled back; permissions and
// tenancy go through the API.
import { actions, rolePermissions } from '@linedesk/actions'
import type { AccessTokenSource, CalendarLogin, CalendarOAuth, CalendarProvider, OAuthTokens } from '@linedesk/calendar'
import { CalendarError } from '@linedesk/calendar'
import { appointment_types, assistant_calendars, calendar_connections, calendar_credentials, calendar_oauth_states, commands, instance_settings, type Tx } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { calendarCallback } from '../src/calendar-callback.ts'
import {
  type CalendarServices,
  calendarProblemText,
  calendarRedirectUri,
  PASSWORD_CONNECTS_PER_HOUR,
  passwordConnectBudget,
  tokenSource,
} from '../src/calendar-connections.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { Reject, runHandler, type Undo } from '../src/handlers.ts'
import { decryptSecret } from '../src/secrets.ts'
import { act, addMember, agent, createWorkspace, type User, type Workspace } from './helpers.ts'

class Rollback extends Error {}

async function inRollback(body: (tx: Tx) => Promise<void>) {
  await db.transaction(async tx => {
    await body(tx)
    throw new Rollback()
  }).catch(e => {
    if (!(e instanceof Rollback)) throw e
  })
}

const GOOGLE_SCOPE = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly'

/** A Google account in memory: OAuth that hands out numbered tokens, and a calendar API that records the token it was given. */
function fakeGoogle({ scope = GOOGLE_SCOPE, email = 'Mike@Brightwater.example', refreshFails = false } = {}) {
  let issued = 0
  const issue = (refreshToken: string | null): OAuthTokens => ({ accessToken: `access-${++issued}`, refreshToken, expiresAt: new Date(Date.now() + 3600_000).toISOString(), scope })
  const oauth = {
    name: 'google' as const,
    scopes: [],
    authorizeUrl: vi.fn(({ redirectUri, state, codeChallenge }) => `https://accounts.google.test/auth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}`),
    exchangeCode: vi.fn(async ({ code }: { code: string; codeVerifier: string; redirectUri: string }) => {
      if (code !== 'good-code') throw new CalendarError('google', 'invalid', 'connect failed: invalid_grant')
      return issue('refresh-1')
    }),
    refresh: vi.fn(async () => {
      if (refreshFails) throw new CalendarError('google', 'auth', 'refresh access failed: Token has been expired or revoked.')
      return issue(null)
    }),
    revoke: vi.fn(async () => true),
    accountEmail: vi.fn(async () => email),
  } satisfies CalendarOAuth
  const tokensSeen: string[] = []
  const provider = (accessToken: AccessTokenSource): CalendarProvider => ({
    name: 'google',
    listCalendars: async () => {
      tokensSeen.push(await accessToken())
      return [
        { id: 'mike@brightwater.example', name: 'Mike Brennan', primary: true, canWrite: true },
        { id: 'jobs', name: 'Brightwater Jobs', primary: false, canWrite: true },
        { id: 'holidays', name: 'Holidays', primary: false, canWrite: false },
      ]
    },
    busy: async () => [],
    createEvent: async () => ({ id: 'ev1' }),
    updateEvent: async () => {},
    deleteEvent: async () => {},
    getEvent: async () => null,
  })
  const services: CalendarServices = { oauth: name => (name === 'google' ? oauth : null), provider: (_name, access) => provider((access as { accessToken: AccessTokenSource }).accessToken) }
  return { oauth, services, tokensSeen }
}

let ws: Workspace
let other: Workspace
let member: User
let owner: Actor

beforeAll(async () => {
  // The tools members connect with a key are switched on for this file (Server admin › Providers › Calendar).
  await db.insert(instance_settings).values({ key: 'calendar_tools', value: JSON.stringify({ caldav: 'keys', calendly: 'keys', calcom: 'keys' }) })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value: JSON.stringify({ caldav: 'keys', calendly: 'keys', calcom: 'keys' }) } })
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  member = await addMember(ws.id, 'member')
  owner = { actorId: ws.owner.userId, role: 'owner', workspaceId: ws.id, permissions: rolePermissions.owner }
})

// Each test starts with the whole hour's budget of key connects; the limit has its own test.
beforeEach(() => passwordConnectBudget.clear())

const run = (tx: Tx, actor: Actor, services: CalendarServices, name: string, input: unknown, undos: Undo[] = []) =>
  runHandler({ tx, actor, now: new Date().toISOString(), calendars: services, onRollback: u => undos.push(u) }, actions.get(name)!, actions.get(name)!.input.parse(input))

/** connectStart and connectFinish as the member's browser would run them; returns the new connection id. */
async function connect(tx: Tx, services: CalendarServices, actor = owner) {
  const started = await run(tx, actor, services, 'calendar.connectStart', { provider: 'google' })
  const state = new URL(started.data!.url as string).searchParams.get('state')!
  const finished = await run(tx, actor, services, 'calendar.connectFinish', { provider: 'google', state, code: 'good-code' })
  return finished.data!.connectionId as string
}

describe('connecting an account', () => {
  test('the consent URL carries a state bound to the member and workspace, and the PKCE challenge', async () => {
    const { services, oauth } = fakeGoogle()
    await inRollback(async tx => {
      const { data } = await run(tx, owner, services, 'calendar.connectStart', { provider: 'google' })
      const url = new URL(data!.url as string)
      const state = url.searchParams.get('state')!
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(url.searchParams.get('redirect_uri')).toBe(calendarRedirectUri('google'))
      expect(oauth.authorizeUrl.mock.calls[0]![0].codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const [row] = await tx.select().from(calendar_oauth_states).where(eq(calendar_oauth_states.id, state))
      expect(row).toMatchObject({ workspace_id: ws.id, user_id: ws.owner.userId, provider: 'google' })
      expect(Date.parse(row!.expires_at) - Date.now()).toBeLessThanOrEqual(10 * 60_000)
    })
  })

  test('finishing stores the account with its tokens encrypted, and uses the state once', async () => {
    const { services, oauth } = fakeGoogle()
    await inRollback(async tx => {
      const started = await run(tx, owner, services, 'calendar.connectStart', { provider: 'google' })
      const state = new URL(started.data!.url as string).searchParams.get('state')!
      const { rows, data } = await run(tx, owner, services, 'calendar.connectFinish', { provider: 'google', state, code: 'good-code' })
      expect(rows.calendar_connections).toMatchObject([{ workspace_id: ws.id, provider: 'google', account_email: 'mike@brightwater.example', status: 'connected', connected_by: ws.owner.userId }])
      // The verifier from connectStart goes with the code.
      const [verifierUsed] = oauth.exchangeCode.mock.calls[0]!
      expect(verifierUsed.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const [credentials] = await tx.select().from(calendar_credentials).where(eq(calendar_credentials.connection_id, data!.connectionId as string))
      expect(credentials!.access_token_encrypted).not.toContain('access-1')
      expect(credentials!.refresh_token_encrypted).not.toContain('refresh-1')
      expect(decryptSecret(credentials!.refresh_token_encrypted, `calendar.${data!.connectionId}.refresh`)).toBe('refresh-1')
      // Bound to its connection: the access token does not decrypt as another row's.
      expect(() => decryptSecret(credentials!.access_token_encrypted, 'calendar.other.access')).toThrow()
      await expect(run(tx, owner, services, 'calendar.connectFinish', { provider: 'google', state, code: 'good-code' })).rejects.toThrow(/expired or is not yours/)
    })
  })

  test("another member cannot finish someone else's connect, nor in another workspace", async () => {
    const { services } = fakeGoogle()
    const admin = await addMember(ws.id, 'admin')
    const adminActor: Actor = { actorId: admin.userId, role: 'admin', workspaceId: ws.id, permissions: rolePermissions.admin }
    await inRollback(async tx => {
      const started = await run(tx, owner, services, 'calendar.connectStart', { provider: 'google' })
      const state = new URL(started.data!.url as string).searchParams.get('state')!
      await expect(run(tx, adminActor, services, 'calendar.connectFinish', { provider: 'google', state, code: 'good-code' })).rejects.toThrow(Reject)
    })
    await inRollback(async tx => {
      const started = await run(tx, owner, services, 'calendar.connectStart', { provider: 'google' })
      const state = new URL(started.data!.url as string).searchParams.get('state')!
      await expect(run(tx, { ...owner, workspaceId: other.id }, services, 'calendar.connectFinish', { provider: 'google', state, code: 'good-code' })).rejects.toThrow(/switched workspace/)
    })
  })

  test('an expired state is refused', async () => {
    const { services } = fakeGoogle()
    await inRollback(async tx => {
      const state = 'expired-state-0123456789abcdef'
      await tx.insert(calendar_oauth_states).values({ id: state, workspace_id: ws.id, user_id: ws.owner.userId, provider: 'google', code_verifier: 'v', expires_at: new Date(Date.now() - 1000).toISOString() })
      await expect(run(tx, owner, services, 'calendar.connectFinish', { provider: 'google', state, code: 'good-code' })).rejects.toThrow(/expired/)
    })
  })

  test('without the calendar permissions the connect is refused and the new grant revoked', async () => {
    const { services, oauth } = fakeGoogle({ scope: 'openid https://www.googleapis.com/auth/userinfo.email' })
    await inRollback(async tx => {
      const undos: Undo[] = []
      const started = await run(tx, owner, services, 'calendar.connectStart', { provider: 'google' })
      const state = new URL(started.data!.url as string).searchParams.get('state')!
      await expect(run(tx, owner, services, 'calendar.connectFinish', { provider: 'google', state, code: 'good-code' }, undos)).rejects.toThrow(/allow every calendar permission/)
      expect(await Promise.all(undos.map(u => u()))).toEqual(['the new access was revoked'])
      expect(oauth.revoke).toHaveBeenCalledWith('refresh-1')
    })
  })

  test('connecting the same account again updates it instead of adding a second one', async () => {
    const { services } = fakeGoogle()
    await inRollback(async tx => {
      const first = await connect(tx, services)
      const second = await connect(tx, services)
      expect(second).toBe(first)
      expect(await tx.select().from(calendar_connections).where(eq(calendar_connections.account_email, 'mike@brightwater.example'))).toHaveLength(1)
    })
  })

  test('not while an instance admin is signed in as the member', async () => {
    const { services } = fakeGoogle()
    await inRollback(async tx => {
      const impersonated = { ...owner, impersonation: { by: 'admin', sessionId: 's', expiresAt: new Date(Date.now() + 60_000) } }
      await expect(run(tx, impersonated, services, 'calendar.connectStart', { provider: 'google' })).rejects.toThrow(/another user/)
    })
  })

  test('a provider without its OAuth app in env is refused with what to set', async () => {
    const { services } = fakeGoogle()
    await inRollback(async tx => {
      await expect(run(tx, owner, services, 'calendar.connectStart', { provider: 'microsoft' })).rejects.toThrow(/MICROSOFT_CLIENT_ID/)
    })
  })

  test('the command log never holds the code', () => {
    expect(actions.get('calendar.connectFinish')!.sensitive).toEqual(['code'])
  })
})

/** A CalDAV server in memory: it accepts one password, and records the logins it was given. */
function fakeCalDav({ password = 'abcd-efgh-ijkl-mnop', refused = new Set<string>() } = {}) {
  const loginsSeen: CalendarLogin[] = []
  let refuseNow = false
  const provider = (login: CalendarLogin): CalendarProvider => {
    const check = async () => {
      loginsSeen.push(login)
      if (refuseNow || login.password !== password) throw new CalendarError('caldav', 'auth', 'list calendars failed: Unauthorized', 401)
    }
    return {
      name: 'caldav',
      listCalendars: async () => {
        await check()
        return [{ id: 'https://p42-caldav.icloud.com/123/calendars/work/', name: 'Work', primary: true, canWrite: true }]
      },
      busy: async () => {
        await check()
        return []
      },
      createEvent: async () => {
        await check()
        return { id: 'ev1' }
      },
      updateEvent: async () => check(),
      deleteEvent: async () => check(),
      getEvent: async () => {
        await check()
        return null
      },
    }
  }
  const serverUrl = vi.fn(async (typed: string) => (refused.has(typed) ? 'that address is private' : new URL(typed.includes('://') ? typed : `https://${typed}`)))
  const services: CalendarServices = { oauth: () => null, provider: (_name, access) => provider((access as { login: CalendarLogin }).login), serverUrl }
  return { services, loginsSeen, serverUrl, refuse: () => { refuseNow = true } }
}

const icloud = { provider: 'caldav', serverUrl: 'caldav.icloud.com', username: 'Mike@Brightwater.example', password: 'abcd-efgh-ijkl-mnop' } as const

describe('connecting by password (CalDAV)', () => {
  test('the login is checked against the server, then stored encrypted; the account is named by its user name', async () => {
    const { services, loginsSeen } = fakeCalDav()
    await inRollback(async tx => {
      const { rows, data } = await run(tx, owner, services, 'calendar.connectWithPassword', icloud)
      expect(rows.calendar_connections).toMatchObject([{ workspace_id: ws.id, provider: 'caldav', account_email: 'mike@brightwater.example', status: 'connected' }])
      const connectionId = data!.connectionId as string
      expect(loginsSeen).toEqual([{ serverUrl: 'https://caldav.icloud.com/', username: 'Mike@Brightwater.example', password: icloud.password }])
      const [credentials] = await tx.select().from(calendar_credentials).where(eq(calendar_credentials.connection_id, connectionId))
      expect(credentials!.access_token_encrypted).not.toContain(icloud.password)
      expect(JSON.parse(decryptSecret(credentials!.access_token_encrypted, `calendar.${connectionId}.caldav.access`))).toEqual(loginsSeen[0])
      expect(decryptSecret(credentials!.refresh_token_encrypted, `calendar.${connectionId}.caldav.refresh`)).toBe('')
      // An older release reading the row as OAuth finds it expired and refreshes (and fails); it never sends the login.
      expect(Date.parse(credentials!.expires_at)).toBeLessThan(Date.now())
      // The adapter of the connection signs in with the stored login.
      expect((await run(tx, owner, services, 'calendar.listCalendars', { connectionId })).data).toMatchObject({ calendars: [{ name: 'Work', canWrite: true }] })
      expect(loginsSeen).toHaveLength(2)
      expect(loginsSeen[1]).toEqual(loginsSeen[0])
    })
  })

  test('a user name without an address is named with the server', async () => {
    const { services } = fakeCalDav()
    await inRollback(async tx => {
      const { rows } = await run(tx, owner, services, 'calendar.connectWithPassword', { ...icloud, serverUrl: 'https://dav.brightwater.example/radicale/', username: 'mike' })
      expect(rows.calendar_connections).toMatchObject([{ account_email: 'mike@dav.brightwater.example' }])
    })
  })

  test('a wrong password or a refused server stores nothing', async () => {
    const { services, serverUrl, loginsSeen } = fakeCalDav({ refused: new Set(['localhost:5232']) })
    await inRollback(async tx => {
      await expect(run(tx, owner, services, 'calendar.connectWithPassword', { ...icloud, password: 'my-apple-id-password' })).rejects.toThrow(/did not accept that user name and password.*app-specific password/)
      await expect(run(tx, owner, services, 'calendar.connectWithPassword', { ...icloud, serverUrl: 'localhost:5232' })).rejects.toThrow('that address is private')
      expect(serverUrl).toHaveBeenCalledWith('localhost:5232')
      expect(loginsSeen).toHaveLength(1)
      expect(await tx.select().from(calendar_connections).where(and(eq(calendar_connections.workspace_id, ws.id), eq(calendar_connections.provider, 'caldav')))).toEqual([])
    })
  })

  test('connecting again replaces the password; the same account on another server is refused', async () => {
    const { services } = fakeCalDav({ password: 'new-pass' })
    await inRollback(async tx => {
      const first = await run(tx, owner, { ...services, provider: fakeCalDav().services.provider }, 'calendar.connectWithPassword', icloud)
      const connectionId = first.data!.connectionId as string
      await tx.update(calendar_connections).set({ status: 'needs_reconnect', last_error: 'refused' }).where(eq(calendar_connections.id, connectionId))
      const again = await run(tx, owner, services, 'calendar.connectWithPassword', { ...icloud, password: 'new-pass' })
      expect(again.data!.connectionId).toBe(connectionId)
      expect(again.rows.calendar_connections).toMatchObject([{ status: 'connected', last_error: null }])
      const [credentials] = await tx.select().from(calendar_credentials).where(eq(calendar_credentials.connection_id, connectionId))
      expect(JSON.parse(decryptSecret(credentials!.access_token_encrypted, `calendar.${connectionId}.caldav.access`)).password).toBe('new-pass')
      await expect(run(tx, owner, services, 'calendar.connectWithPassword', { ...icloud, serverUrl: 'caldav.fastmail.com', password: 'new-pass' })).rejects.toThrow(/connected on caldav\.icloud\.com already/)
    })
  })

  test('disconnecting deletes the login and says where to delete the app-specific password', async () => {
    const { services } = fakeCalDav()
    await inRollback(async tx => {
      const connectionId = (await run(tx, owner, services, 'calendar.connectWithPassword', icloud)).data!.connectionId as string
      const { data } = await run(tx, owner, services, 'calendar.disconnect', { connectionId })
      expect(data).toMatchObject({ revoked: false, note: expect.stringContaining('App-Specific Passwords') })
      expect(await tx.select().from(calendar_credentials).where(eq(calendar_credentials.connection_id, connectionId))).toEqual([])
    })
  })

  test('not while signed in as someone else', async () => {
    const { services } = fakeCalDav()
    await inRollback(async tx => {
      const impersonated = { ...owner, impersonation: { by: 'admin', sessionId: 's', expiresAt: new Date(Date.now() + 60_000) } }
      await expect(run(tx, impersonated, services, 'calendar.connectWithPassword', icloud)).rejects.toThrow(/another user/)
    })
  })

  test('the command log holds the password redacted, also when the connect is refused', async () => {
    const { status } = await act(ws.owner, 'calendar.connectWithPassword', { ...icloud, serverUrl: 'https://localhost', password: 'pw-must-not-be-logged' })
    expect(status).toBe(409)
    const [logged] = await db.select().from(commands).where(and(eq(commands.actor_id, ws.owner.userId), eq(commands.action, 'calendar.connectWithPassword'))).limit(1)
    expect(logged!.input).toMatchObject({ password: '[redacted]', username: icloud.username })
    expect(JSON.stringify(logged)).not.toContain('pw-must-not-be-logged')
  })

  test('at most 10 connects with a key or password per workspace and hour, refused ones counted too', async () => {
    const { services } = fakeCalDav()
    await inRollback(async tx => {
      for (let i = 0; i < PASSWORD_CONNECTS_PER_HOUR; i++)
        await expect(run(tx, owner, services, 'calendar.connectWithPassword', { ...icloud, password: `guess-${i}` })).rejects.toThrow(/did not accept/)
      await expect(run(tx, owner, services, 'calendar.connectWithPassword', icloud)).rejects.toThrow(/At most 10 connects/)
      // Another workspace has its own budget.
      const otherOwner: Actor = { actorId: other.owner.userId, role: 'owner', workspaceId: other.id, permissions: rolePermissions.owner }
      await expect(run(tx, otherOwner, services, 'calendar.connectWithPassword', icloud)).resolves.toBeTruthy()
    })
  })

  test('a user name with a colon or control characters is refused before anything happens', async () => {
    for (const username of ['mike:admin', 'mike\r\nX-Injected: 1'])
      expect((await act(ws.owner, 'calendar.connectWithPassword', { ...icloud, username })).status, username).toBe(422)
  })

  test("another workspace's owner cannot use, list or disconnect the account by its id", async () => {
    const { services, loginsSeen } = fakeCalDav()
    const connectionId = await db.transaction(async tx => (await run(tx, owner, services, 'calendar.connectWithPassword', { ...icloud, username: 'tenancy@brightwater.example' })).data!.connectionId as string)
    try {
      const outsider = { actorId: other.owner.userId, role: 'owner' as const, workspaceId: other.id, permissions: rolePermissions.owner }
      for (const name of ['calendar.listCalendars', 'calendar.disconnect'])
        await expect(db.transaction(tx => run(tx, outsider, services, name, { connectionId })), name).rejects.toThrow(/account not found/)
      await expect(db.transaction(tx => run(tx, outsider, services, 'assistantCalendar.add', { assistantId: other.assistant.id, connectionId, externalId: 'x' }))).rejects.toThrow(/account not found/)
      expect(loginsSeen).toHaveLength(1)
      expect((await act(other.owner, 'calendar.listCalendars', { connectionId })).status).toBe(409)
      expect(await db.select().from(calendar_connections).where(eq(calendar_connections.id, connectionId))).toHaveLength(1)
    } finally {
      await db.delete(calendar_connections).where(eq(calendar_connections.id, connectionId))
    }
  })

  test('a password the server refuses later marks the account for connecting again', async () => {
    const { services, refuse } = fakeCalDav()
    const connectionId = await db.transaction(async tx => (await run(tx, owner, services, 'calendar.connectWithPassword', { ...icloud, username: 'refused@brightwater.example' })).data!.connectionId as string)
    try {
      refuse()
      await expect(db.transaction(tx => run(tx, owner, services, 'calendar.listCalendars', { connectionId }))).rejects.toThrow(/no longer accepts the password/)
      const [connection] = await db.select().from(calendar_connections).where(eq(calendar_connections.id, connectionId))
      expect(connection).toMatchObject({ status: 'needs_reconnect', last_error: expect.stringContaining('Unauthorized') })
    } finally {
      await db.delete(calendar_connections).where(eq(calendar_connections.id, connectionId))
    }
  })
})

/** Cal.com or Calendly in memory: one good key, its account's address, its event types; records the logins and names. */
function fakeKeyProvider(goodKey: string, types = [{ id: '101', name: 'Repair visit (60 min)', primary: true, canWrite: true }]) {
  const seen: { name: string; login: CalendarLogin }[] = []
  const services: CalendarServices = {
    oauth: () => null,
    serverUrl: async typed => new URL(typed),
    provider: (name, access) => {
      const { login } = access as { login: CalendarLogin }
      const check = async () => {
        seen.push({ name, login })
        if (login.password !== goodKey) throw new CalendarError(name, 'auth', 'read the account failed: Invalid API key', 401)
      }
      return {
        name,
        accountEmail: async () => {
          await check()
          return 'Mike@Brightwater.example'
        },
        listCalendars: async () => {
          await check()
          return types
        },
        busy: async () => [],
        slots: async () => [],
        createEvent: async () => ({ id: 'bk' }),
        updateEvent: async () => {},
        deleteEvent: async () => {},
        getEvent: async () => null,
      }
    },
  }
  return { services, seen }
}

describe('connecting Cal.com and Calendly with a key', () => {
  test("Cal.com: the API key against api.cal.com by default; the account is named by Cal.com's address for it", async () => {
    const { services, seen } = fakeKeyProvider('cal_live_good')
    await inRollback(async tx => {
      const { rows, data } = await run(tx, owner, services, 'calendar.connectWithPassword', { provider: 'calcom', password: 'cal_live_good' })
      expect(rows.calendar_connections).toMatchObject([{ provider: 'calcom', account_email: 'mike@brightwater.example', status: 'connected' }])
      expect(seen[0]).toEqual({ name: 'calcom', login: { serverUrl: 'https://api.cal.com/', username: '', password: 'cal_live_good' } })
      const connectionId = data!.connectionId as string
      const [credentials] = await tx.select().from(calendar_credentials).where(eq(calendar_credentials.connection_id, connectionId))
      expect(credentials!.access_token_encrypted).not.toContain('cal_live_good')
      // The adapter of the connection gets the stored key.
      await run(tx, owner, services, 'calendar.listCalendars', { connectionId })
      expect(seen.at(-1)!.login.password).toBe('cal_live_good')
      const { data: gone } = await run(tx, owner, services, 'calendar.disconnect', { connectionId })
      expect(gone).toMatchObject({ revoked: false, note: expect.stringContaining('API keys') })
    })
  })

  test("Cal.com: cloud only, always Cal.com's own API, whatever address is sent", async () => {
    const { services, seen } = fakeKeyProvider('cal_live_good')
    await inRollback(async tx => {
      await run(tx, owner, services, 'calendar.connectWithPassword', { provider: 'calcom', password: 'cal_live_good', serverUrl: 'https://cal.brightwater.example/api/' })
      expect(seen[0]!.login.serverUrl).toBe('https://api.cal.com/')
    })
  })

  test('Calendly: always its own API, whatever address is sent; a refused token says where to make one', async () => {
    const { services, seen } = fakeKeyProvider('pat-good')
    await inRollback(async tx => {
      await expect(run(tx, owner, services, 'calendar.connectWithPassword', { provider: 'calendly', password: 'pat-wrong' })).rejects.toThrow(/Calendly did not accept that token.*Integrations, API and webhooks/)
      await run(tx, owner, services, 'calendar.connectWithPassword', { provider: 'calendly', password: 'pat-good', serverUrl: 'https://evil.example/' })
      expect(seen.every(s => s.login.serverUrl === 'https://api.calendly.com/')).toBe(true)
      expect(await tx.select().from(calendar_connections).where(and(eq(calendar_connections.workspace_id, ws.id), eq(calendar_connections.provider, 'calendly')))).toHaveLength(1)
    })
  })

  test('an account without event types is refused, with what to do', async () => {
    const { services } = fakeKeyProvider('cal_live_good', [])
    await inRollback(async tx => {
      await expect(run(tx, owner, services, 'calendar.connectWithPassword', { provider: 'calcom', password: 'cal_live_good' })).rejects.toThrow(/no event type in Cal.com yet/)
    })
  })

  test('CalDAV still needs its server and user name', async () => {
    const { services } = fakeKeyProvider('x')
    await inRollback(async tx => {
      await expect(run(tx, owner, services, 'calendar.connectWithPassword', { provider: 'caldav', password: 'x' })).rejects.toThrow(/server address and the user name/)
    })
  })
})

describe('tokens', () => {
  test('a good access token is used as stored; an expiring one is refreshed and stored again', async () => {
    const { services, oauth, tokensSeen } = fakeGoogle()
    await inRollback(async tx => {
      const connectionId = await connect(tx, services)
      await run(tx, owner, services, 'calendar.listCalendars', { connectionId })
      expect(tokensSeen).toEqual(['access-1'])
      expect(oauth.refresh).not.toHaveBeenCalled()
      await tx.update(calendar_credentials).set({ expires_at: new Date(Date.now() + 30_000).toISOString() }).where(eq(calendar_credentials.connection_id, connectionId))
      await run(tx, owner, services, 'calendar.listCalendars', { connectionId })
      expect(oauth.refresh).toHaveBeenCalledWith('refresh-1')
      expect(tokensSeen).toEqual(['access-1', 'access-2'])
      const [credentials] = await tx.select().from(calendar_credentials).where(eq(calendar_credentials.connection_id, connectionId))
      expect(decryptSecret(credentials!.access_token_encrypted, `calendar.${connectionId}.access`)).toBe('access-2')
      // Google kept the refresh token: the old one stays.
      expect(decryptSecret(credentials!.refresh_token_encrypted, `calendar.${connectionId}.refresh`)).toBe('refresh-1')
    })
  })

  test('a refused refresh is an auth error', async () => {
    const { services } = fakeGoogle({ refreshFails: true })
    await inRollback(async tx => {
      const connectionId = await connect(tx, services)
      const [connection] = await tx.select().from(calendar_connections).where(eq(calendar_connections.id, connectionId))
      await expect(tokenSource(tx, { calendars: services }, connection!)(true)).rejects.toMatchObject({ kind: 'auth' })
    })
  })
})

describe("the assistant's calendars", () => {
  test('the first calendar brings a 30-minute "Appointment" when the workspace has no type; never a second one', async () => {
    const { services } = fakeGoogle()
    await inRollback(async tx => {
      const connectionId = await connect(tx, services)
      const assistantId = ws.assistant.id
      await tx.delete(assistant_calendars).where(eq(assistant_calendars.assistant_id, assistantId))
      await tx.delete(appointment_types).where(eq(appointment_types.workspace_id, ws.id))
      const added = await run(tx, owner, services, 'assistantCalendar.add', {
        assistantId,
        connectionId,
        externalId: 'jobs',
      })
      expect(added.rows.appointment_types).toMatchObject([
        {
          name: 'Appointment',
          duration_min: 30,
          instruction: 'no other type fits',
          name_required: true,
          required_fields: [],
          enabled: true,
          workspace_id: ws.id,
        },
      ])
      const second = await run(tx, owner, services, 'assistantCalendar.add', {
        assistantId,
        connectionId,
        externalId: 'mike@brightwater.example',
      })
      expect(second.rows.appointment_types).toBeUndefined()
      expect(await tx.select().from(appointment_types).where(eq(appointment_types.workspace_id, ws.id))).toHaveLength(1)
    })
  })

  test('a workspace with its own types keeps them as they are', async () => {
    const { services } = fakeGoogle()
    await inRollback(async tx => {
      const connectionId = await connect(tx, services)
      await tx.delete(assistant_calendars).where(eq(assistant_calendars.assistant_id, ws.assistant.id))
      await tx.delete(appointment_types).where(eq(appointment_types.workspace_id, ws.id))
      const [own] = await tx
        .insert(appointment_types)
        .values({
          id: `at_${crypto.randomUUID().slice(0, 8)}`,
          workspace_id: ws.id,
          name: 'Estimate',
          duration_min: 45,
        })
        .returning()
      const added = await run(tx, owner, services, 'assistantCalendar.add', {
        assistantId: ws.assistant.id,
        connectionId,
        externalId: 'jobs',
      })
      expect(added.rows.appointment_types).toBeUndefined()
      expect(await tx.select().from(appointment_types).where(eq(appointment_types.workspace_id, ws.id))).toEqual([own])
    })
  })

  test('add: only a writable calendar of the account, named as the provider names it; the first is the default', async () => {
    const { services } = fakeGoogle()
    await inRollback(async tx => {
      const connectionId = await connect(tx, services)
      const assistantId = ws.assistant.id
      await tx.delete(assistant_calendars).where(eq(assistant_calendars.assistant_id, assistantId))
      const added = await run(tx, owner, services, 'assistantCalendar.add', { assistantId, connectionId, externalId: 'jobs', instruction: 'Repairs and estimates' })
      expect(added.rows.assistant_calendars).toMatchObject([{ name: 'Brightwater Jobs', instruction: 'Repairs and estimates', is_default: true, enabled: true, workspace_id: ws.id }])
      const second = await run(tx, owner, services, 'assistantCalendar.add', { assistantId, connectionId, externalId: 'mike@brightwater.example', instruction: 'Emergencies' })
      expect(second.rows.assistant_calendars).toMatchObject([{ is_default: false }])
      await expect(run(tx, owner, services, 'assistantCalendar.add', { assistantId, connectionId, externalId: 'holidays' })).rejects.toThrow(/read-only/)
      await expect(run(tx, owner, services, 'assistantCalendar.add', { assistantId, connectionId, externalId: 'nope' })).rejects.toThrow(/no such calendar/)
      await expect(run(tx, owner, services, 'assistantCalendar.add', { assistantId, connectionId, externalId: 'jobs' })).rejects.toThrow(/already/)

      // One default per assistant; removing it hands the default on.
      const secondId = second.data!.assistantCalendarId as string
      await run(tx, owner, services, 'assistantCalendar.setDefault', { assistantCalendarId: secondId })
      const defaults = async () => (await tx.select().from(assistant_calendars).where(eq(assistant_calendars.assistant_id, assistantId))).filter(c => c.is_default).map(c => c.id)
      expect(await defaults()).toEqual([secondId])
      expect((await run(tx, owner, services, 'assistantCalendar.remove', { assistantCalendarId: secondId })).deleted).toEqual({ assistant_calendars: [secondId] })
      expect(await defaults()).toEqual([added.data!.assistantCalendarId])
    })
  })

  test("add refuses another workspace's assistant or account", async () => {
    const { services } = fakeGoogle()
    await inRollback(async tx => {
      const connectionId = await connect(tx, services)
      await expect(run(tx, owner, services, 'assistantCalendar.add', { assistantId: other.assistant.id, connectionId, externalId: 'jobs' })).rejects.toThrow(/assistant not found/)
      await expect(run(tx, owner, services, 'assistantCalendar.add', { assistantId: ws.assistant.id, connectionId: other.connection.id, externalId: 'jobs' })).rejects.toThrow(/account not found/)
    })
  })
})

describe('disconnecting', () => {
  test('revokes at the provider, deletes the tokens and takes the calendars off the assistant', async () => {
    const { services, oauth } = fakeGoogle()
    await inRollback(async tx => {
      const connectionId = await connect(tx, services)
      const added = await run(tx, owner, services, 'assistantCalendar.add', { assistantId: ws.assistant.id, connectionId, externalId: 'jobs' })
      const { data, deleted } = await run(tx, owner, services, 'calendar.disconnect', { connectionId })
      expect(data).toEqual({ revoked: true, note: null })
      expect(deleted).toEqual({ calendar_connections: [connectionId], assistant_calendars: [added.data!.assistantCalendarId] })
      expect(oauth.revoke).toHaveBeenCalledWith('refresh-1')
      expect(await tx.select().from(calendar_credentials).where(eq(calendar_credentials.connection_id, connectionId))).toEqual([])
      expect(await tx.select().from(assistant_calendars).where(eq(assistant_calendars.connection_id, connectionId))).toEqual([])
    })
  })

  test('a provider that cannot be reached does not keep the account connected; the result says so', async () => {
    const { services, oauth } = fakeGoogle()
    oauth.revoke.mockRejectedValueOnce(new Error('network down'))
    await inRollback(async tx => {
      const connectionId = await connect(tx, services)
      const { data } = await run(tx, owner, services, 'calendar.disconnect', { connectionId })
      expect(data).toMatchObject({ revoked: false, note: expect.stringContaining('network down') })
      expect(await tx.select().from(calendar_connections).where(eq(calendar_connections.id, connectionId))).toEqual([])
    })
  })
})

describe('through the API', () => {
  test('members, and the agent, cannot connect or change calendars', async () => {
    for (const name of ['calendar.connectStart', 'calendar.connectFinish', 'calendar.connectWithPassword', 'calendar.listCalendars', 'calendar.disconnect', 'assistantCalendar.add', 'assistantCalendar.update', 'assistantCalendar.setDefault', 'assistantCalendar.remove']) {
      expect(actions.get(name)!.permission, name).toBe('settings:write')
      expect((await act(member, name, {})).status, name).toBe(403)
      expect((await act(agent(ws.id), name, {})).status, name).toBe(403)
    }
  })

  test("an owner cannot reach another workspace's account or calendars", async () => {
    const before = await db.select().from(calendar_connections).where(eq(calendar_connections.id, other.connection.id))
    for (const [name, input] of [
      ['calendar.listCalendars', { connectionId: other.connection.id }],
      ['calendar.disconnect', { connectionId: other.connection.id }],
      ['assistantCalendar.setDefault', { assistantCalendarId: other.assistantCalendar.id }],
      ['assistantCalendar.remove', { assistantCalendarId: other.assistantCalendar.id }],
    ] as const) {
      expect(await act(ws.owner, name, input), name).toMatchObject({ status: 409, body: { ok: false } })
    }
    expect(await db.select().from(calendar_connections).where(eq(calendar_connections.id, other.connection.id))).toEqual(before)
    expect(await db.select().from(assistant_calendars).where(eq(assistant_calendars.id, other.assistantCalendar.id))).toHaveLength(1)
  })

  test('the callback sends the browser back to the calendar settings, with the reason when it fails', async () => {
    const web = 'http://app.test'
    const headers = new Headers(ws.owner.headers)
    const target = (url: string) => Object.fromEntries(new URLSearchParams(url.split('#assistant/calendar?')[1]))
    expect(await calendarCallback('google', new URLSearchParams({ error: 'access_denied' }), headers, web)).toMatch(/^http:\/\/app\.test\/#assistant\/calendar\?/)
    expect(target(await calendarCallback('google', new URLSearchParams({ error: 'access_denied' }), headers, web))).toEqual({ calendar: 'error', reason: 'Access was not granted.' })
    expect(target(await calendarCallback('yahoo', new URLSearchParams({ code: 'c', state: 's' }), headers, web)).reason).toBe('Unknown calendar provider.')
    expect(target(await calendarCallback('google', new URLSearchParams({ code: 'c', state: 'x'.repeat(20) }), new Headers(), web)).reason).toMatch(/signed out/)
    expect(target(await calendarCallback('google', new URLSearchParams({ code: 'c', state: 'x'.repeat(20) }), headers, web))).toMatchObject({ calendar: 'error', reason: expect.stringContaining('expired or is not yours') })
    // The rejected finish is in the command log without the code.
    const [logged] = await db.select().from(commands).where(eq(commands.actor_id, ws.owner.userId)).limit(1)
    expect(JSON.stringify(logged!.input)).not.toContain('"c"')
  })
})

describe('why calendars could not be listed, in the shared provider-failure words (LIN-111)', () => {
  const account = { provider: 'google' as const, account_email: 'mike@example.test' }
  test.each([
    [new CalendarError('google', 'auth', 'refresh access failed', 401, 'invalid_client'), 'member', /^Google Calendar rejected the key it was given\. Ask whoever runs this server/],
    [new CalendarError('google', 'invalid', 'list calendars failed', 403, 'api_disabled'), 'admin', /^The Google Calendar app of this server refused a setting\. .*Server admin › Providers/],
    [new CalendarError('google', 'auth', 'refresh access failed: Token has been expired or revoked.', 400, 'invalid_grant'), 'member', /no longer accepts the access to mike@example\.test\. Connect the account again\.$/],
    [new CalendarError('google', 'unavailable', 'list calendars failed', 503), 'member', /^Google Calendar is not reachable right now\. Try again/],
    [new CalendarError('google', 'invalid', 'list calendars failed: insufficient scope'), 'member', /^Google: list calendars failed: insufficient scope$/],
  ] as const)('%s (%s)', (error, audience, text) => {
    expect(calendarProblemText(error, account, audience)).toMatch(text)
  })
})
