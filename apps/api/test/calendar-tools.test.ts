// Calendar tools beyond Google and Microsoft are off until an instance admin switches them on (Server admin ›
// Providers › Calendar): off, members' own keys, or one click through the install's OAuth app. What is off is not
// offered, not connected, not booked into. Install-wide: its own database (vitest.config.ts).
import { actions, rolePermissions } from '@linedesk/actions'
import type { CalendarAccess, CalendarOAuth, CalendarProvider } from '@linedesk/calendar'
import { calendar_connections, calendar_credentials, instance_settings, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { CalendarServices } from '../src/calendar-connections.ts'
import { calendarToolModes, connectWays } from '../src/calendar-tools.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { runHandler } from '../src/handlers.ts'
import { decryptSecret } from '../src/secrets.ts'
import { act, addMember, agent, createWorkspace, request, type Workspace } from './helpers.ts'

let ws: Workspace
let owner: Actor
const admin = (): Actor => ({
  actorId: ws.owner.userId,
  role: 'owner',
  workspaceId: ws.id,
  permissions: [...rolePermissions.owner, 'instance:admin'],
})

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  owner = { actorId: ws.owner.userId, role: 'owner', workspaceId: ws.id, permissions: rolePermissions.owner }
})
afterEach(async () => {
  await db.delete(instance_settings).where(eq(instance_settings.key, 'calendar_tools'))
  delete process.env.CALENDLY_CLIENT_ID
  delete process.env.CALENDLY_CLIENT_SECRET
})

const run = (tx: Tx, actor: Actor, name: string, input: unknown, calendars?: CalendarServices) =>
  runHandler(
    { tx, actor, now: new Date().toISOString(), calendars },
    actions.get(name)!,
    actions.get(name)!.input.parse(input),
  )

describe('calendar tools', () => {
  test('all off by default: not offered, not connected', async () => {
    expect(await calendarToolModes()).toEqual({ caldav: 'off', calendly: 'off', calcom: 'off' })
    expect(connectWays(await calendarToolModes(), {})).toEqual({})
    await expect(
      db.transaction(tx =>
        run(tx, owner, 'calendar.connectWithPassword', { provider: 'calcom', password: 'cal_live_x' }),
      ),
    ).rejects.toThrow(/Cal.com is not switched on/)
    const { body } = await request(ws.owner, 'GET', '/v1/calendar/providers')
    expect(body).toEqual({ providers: [], ways: {} })
  })

  test('an instance admin switches a tool on with keys; then it is offered with a key form', async () => {
    await db.transaction(tx => run(tx, admin(), 'calendarTools.set', { tool: 'calendly', mode: 'keys' }))
    expect(await calendarToolModes()).toMatchObject({ calendly: 'keys', calcom: 'off' })
    const { body } = await request(ws.owner, 'GET', '/v1/calendar/providers')
    expect(body).toEqual({ providers: ['calendly'], ways: { calendly: 'key' } })
  })

  test('one click needs the OAuth app first; CalDAV has none', async () => {
    await expect(
      db.transaction(tx => run(tx, admin(), 'calendarTools.set', { tool: 'calendly', mode: 'oauth' })),
    ).rejects.toThrow(/Set up the Calendly app first/)
    await expect(
      db.transaction(tx => run(tx, admin(), 'calendarTools.set', { tool: 'caldav', mode: 'oauth' })),
    ).rejects.toThrow(/no one-click connect/)
    process.env.CALENDLY_CLIENT_ID = 'cid'
    process.env.CALENDLY_CLIENT_SECRET = 'secret'
    const { data } = await db.transaction(tx =>
      run(tx, admin(), 'calendarTools.set', { tool: 'calendly', mode: 'oauth' }),
    )
    expect(data).toEqual({ modes: { caldav: 'off', calendly: 'oauth', calcom: 'off' }, apps: ['calendly'] })
    expect(connectWays(await calendarToolModes())).toMatchObject({ calendly: 'oauth' })
    // In one-click mode the key form is refused: members connect through the app.
    await expect(
      db.transaction(tx => run(tx, owner, 'calendar.connectWithPassword', { provider: 'calendly', password: 'pat' })),
    ).rejects.toThrow(/not switched on on this server for this way/)
  })

  test('only instance admins switch tools; members and the agent cannot', async () => {
    const member = await addMember(ws.id, 'admin')
    for (const actor of [member, agent(ws.id)])
      expect((await act(actor, 'calendarTools.set', { tool: 'caldav', mode: 'keys' })).status).toBe(403)
    expect(await calendarToolModes()).toMatchObject({ caldav: 'off' })
  })

  test('one click: Calendly connects by its consent page; the connection then signs in with the OAuth token, not a login', async () => {
    process.env.CALENDLY_CLIENT_ID = 'cid'
    process.env.CALENDLY_CLIENT_SECRET = 'secret'
    await db.transaction(tx => run(tx, admin(), 'calendarTools.set', { tool: 'calendly', mode: 'oauth' }))
    const accesses: CalendarAccess[] = []
    const oauth: CalendarOAuth = {
      name: 'calendly',
      scopes: [],
      authorizeUrl: ({ state }) => `https://auth.calendly.com/oauth/authorize?state=${state}`,
      exchangeCode: async () => ({
        accessToken: 'oauth-access',
        refreshToken: 'oauth-refresh',
        expiresAt: new Date(Date.now() + 7200_000).toISOString(),
        scope: 'default',
      }),
      refresh: async () => {
        throw new Error('not expected')
      },
      revoke: async () => true,
      accountEmail: async () => 'Mike@Brightwater.example',
    }
    const provider = (access: CalendarAccess): CalendarProvider => {
      accesses.push(access)
      return {
        name: 'calendly',
        listCalendars: async () => [
          {
            id: 'https://api.calendly.com/event_types/E',
            name: 'Repair visit',
            primary: true,
            canWrite: true,
            durationMin: 60,
          },
        ],
        busy: async () => [],
        slots: async () => [],
        createEvent: async () => ({ id: 'x' }),
        updateEvent: async () => {},
        deleteEvent: async () => {},
        getEvent: async () => null,
      }
    }
    const services: CalendarServices = {
      oauth: name => (name === 'calendly' ? oauth : null),
      provider: (_name, access) => provider(access),
    }
    await db
      .transaction(async tx => {
        const started = await run(tx, owner, 'calendar.connectStart', { provider: 'calendly' }, services)
        const state = new URL(started.data!.url as string).searchParams.get('state')!
        const { data } = await run(
          tx,
          owner,
          'calendar.connectFinish',
          { provider: 'calendly', state, code: 'code' },
          services,
        )
        const connectionId = data!.connectionId as string
        const [connection] = await tx
          .select()
          .from(calendar_connections)
          .where(eq(calendar_connections.id, connectionId))
        expect(connection).toMatchObject({ provider: 'calendly', account_email: 'mike@brightwater.example' })
        const [credentials] = await tx
          .select()
          .from(calendar_credentials)
          .where(eq(calendar_credentials.connection_id, connectionId))
        expect(credentials!.scope).not.toBe('login')
        // Stored under a slot with the provider's name: a release from before Calendly, which takes it for
        // Microsoft, cannot decrypt the tokens (and so cannot send them to Microsoft).
        expect(decryptSecret(credentials!.access_token_encrypted, `calendar.${connectionId}.calendly.access`)).toBe('oauth-access')
        expect(decryptSecret(credentials!.refresh_token_encrypted, `calendar.${connectionId}.calendly.refresh`)).toBe('oauth-refresh')
        expect(() => decryptSecret(credentials!.access_token_encrypted, `calendar.${connectionId}.access`)).toThrow()
        expect(() => decryptSecret(credentials!.refresh_token_encrypted, `calendar.${connectionId}.refresh`)).toThrow()
        await run(tx, owner, 'calendar.listCalendars', { connectionId }, services)
        const access = accesses.at(-1)!
        expect('accessToken' in access && (await access.accessToken())).toBe('oauth-access')
        throw new Error('rollback')
      })
      .catch(e => expect(String(e)).toContain('rollback'))
  })
})
