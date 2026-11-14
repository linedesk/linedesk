// A person's profile picture (Account settings › Profile): account.setAvatar / account.removeAvatar, the checks it
// shares with the workspace icon (a real PNG of at most 512×512 and 512 KB), who may see it, how it is served, and
// where its address goes: /v1/me, the synced workspace_members rows of every workspace the person is in, team.list.
import { actions } from '@linedesk/actions'
import { commands, user_avatars, workspace_members } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { mayRunWhileImpersonating } from '../src/impersonation-guard.ts'
import { readAvatarFor } from '../src/user-avatar.ts'
import { act, addMember, agent, appRequest, type Caller, createWorkspace, request, type Workspace } from './helpers.ts'

/** A real 1×1 PNG. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const dataUrl = (bytes: Buffer, type = 'image/png') => `data:${type};base64,${bytes.toString('base64')}`
const PNG = dataUrl(PNG_BYTES)

function pngSized(width: number, height: number) {
  const bytes = Buffer.from(PNG_BYTES)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return dataUrl(bytes)
}

const get = (who: Caller, path: string) => appRequest(path, { headers: who.headers })
const memberRows = (userId: string) => db.select().from(workspace_members).where(eq(workspace_members.user_id, userId))

let ws: Workspace
let other: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Avatar Plumbing')
  other = await createWorkspace('Avatar Heating')
})

describe('account.setAvatar', () => {
  test('a member sets their own picture: served as a PNG, in /v1/me, and on their synced member rows', async () => {
    const member = await addMember(ws.id, 'member')
    const res = await act(member, 'account.setAvatar', { avatar: PNG })
    expect(res.status).toBe(200)
    const avatarUrl = res.body.data.avatarUrl as string
    expect(avatarUrl).toMatch(new RegExp(`^/v1/avatars/${member.userId}\\.png\\?v=[\\w-]+$`))
    // The tab gets its own row back at once, with the new version.
    const [version] = avatarUrl.split('v=').slice(-1)
    expect(res.body.rows.workspace_members).toEqual([
      expect.objectContaining({ user_id: member.userId, avatar_version: version }),
    ])

    const served = await get(member, avatarUrl)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(served.headers.get('cache-control')).toContain('private')
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG_BYTES)).toBe(true)

    expect((await request(member, 'GET', '/v1/me')).body.avatarUrl).toBe(avatarUrl)
    const team = await act(ws.owner, 'team.list', {})
    expect(team.body.data.members).toContainEqual(expect.objectContaining({ userId: member.userId, avatarUrl }))
    expect((await memberRows(member.userId)).map(r => r.avatar_version)).toEqual([version])
  })

  test('every workspace the person is in sees the new picture; one who joins later gets it too', async () => {
    const person = await addMember(ws.id, 'member')
    const { avatarUrl } = (await act(person, 'account.setAvatar', { avatar: PNG })).body.data
    const version = avatarUrl.split('v=')[1]
    await auth.api.addMember({ body: { userId: person.userId, organizationId: other.id, role: 'member' } })
    const rows = await memberRows(person.userId)
    expect(rows.map(r => [r.workspace_id, r.avatar_version]).sort()).toEqual(
      [
        [ws.id, version],
        [other.id, version],
      ].sort(),
    )
    // Their owners in both workspaces may load it.
    expect((await get(ws.owner, avatarUrl)).status).toBe(200)
    expect((await get(other.owner, avatarUrl)).status).toBe(200)
  })

  test('a new picture gets a new address; the command log does not keep the image', async () => {
    const first = (await act(ws.owner, 'account.setAvatar', { avatar: PNG })).body.data.avatarUrl
    const second = (await act(ws.owner, 'account.setAvatar', { avatar: PNG })).body.data.avatarUrl
    expect(second).not.toBe(first)
    const [row] = await db.select().from(user_avatars).where(eq(user_avatars.user_id, ws.owner.userId))
    expect(second).toContain(`v=${row!.version}`)
    const logged = await db
      .select({ input: commands.input })
      .from(commands)
      .where(and(eq(commands.workspace_id, ws.id), eq(commands.action, 'account.setAvatar')))
    expect(logged.length).toBeGreaterThan(0)
    expect(JSON.stringify(logged)).not.toContain(PNG_BYTES.toString('base64').slice(0, 20))
  })

  test('only a real PNG of at most 512×512 pixels and 512 KB: SVG, JPEG, a renamed file and larger images are refused', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>')
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(40)])
    const huge = dataUrl(Buffer.concat([PNG_BYTES, Buffer.alloc(600 * 1024)]))
    for (const avatar of [
      dataUrl(svg, 'image/svg+xml'),
      dataUrl(jpeg, 'image/jpeg'),
      'https://example.com/a.png',
      huge,
    ])
      expect((await act(other.owner, 'account.setAvatar', { avatar })).status, avatar.slice(0, 40)).toBe(422)
    const refused = [
      dataUrl(svg),
      dataUrl(jpeg),
      dataUrl(Buffer.from('not an image at all, just text that is long enough')),
      pngSized(513, 512),
      pngSized(512, 4096),
      pngSized(0, 0),
      dataUrl(Buffer.concat([PNG_BYTES, Buffer.alloc(512 * 1024 + 1 - PNG_BYTES.length)])),
    ]
    for (const avatar of refused) {
      const res = await act(other.owner, 'account.setAvatar', { avatar })
      expect(res.status, avatar.slice(0, 40)).toBe(409)
      expect(res.body.error).toMatch(/^The picture (must be a PNG image|must be at most 512×512 pixels|is too large)/)
    }
    expect(await db.select().from(user_avatars).where(eq(user_avatars.user_id, other.owner.userId))).toEqual([])
  })

  test('the voice agent cannot set one, and an impersonating admin is refused (only inbox triage is allowed)', async () => {
    expect((await act(agent(ws.id), 'account.setAvatar', { avatar: PNG })).status).toBe(403)
    expect(mayRunWhileImpersonating(actions.get('account.setAvatar')!)).toBe(false)
    expect(mayRunWhileImpersonating(actions.get('account.removeAvatar')!)).toBe(false)
  })
})

describe('who sees a picture', () => {
  test('people who share no workspace get 404, like a person without a picture; signed out gets 401', async () => {
    const person = await addMember(ws.id, 'member')
    const { avatarUrl } = (await act(person, 'account.setAvatar', { avatar: PNG })).body.data
    const stranger = await createWorkspace('Avatar Stranger')
    expect((await get(stranger.owner, avatarUrl)).status).toBe(404)
    expect((await get({ headers: {} }, avatarUrl)).status).toBe(401)
    expect((await get(person, `/v1/avatars/${person.userId}`)).status).toBe(404)
    expect((await get(stranger.owner, `/v1/avatars/${stranger.owner.userId}.png?v=x`)).status).toBe(404)
  })

  test('instance admins see every picture (Server admin › Users)', async () => {
    const person = await addMember(other.id, 'member')
    await act(person, 'account.setAvatar', { avatar: PNG })
    const outsider = { actorId: 'someone-else', permissions: [] }
    expect(await readAvatarFor(db, person.userId, outsider)).toBeNull()
    expect(
      (await readAvatarFor(db, person.userId, { ...outsider, permissions: ['instance:admin'] }))?.equals(PNG_BYTES),
    ).toBe(true)
  })
})

describe('account.removeAvatar', () => {
  test('removes the picture: no longer served, /v1/me, team.list and the member rows say null', async () => {
    const person = await addMember(ws.id, 'member')
    const { avatarUrl } = (await act(person, 'account.setAvatar', { avatar: PNG })).body.data
    const res = await act(person, 'account.removeAvatar', {})
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ avatarUrl: null })
    expect(res.body.rows.workspace_members).toEqual([
      expect.objectContaining({ user_id: person.userId, avatar_version: null }),
    ])
    expect((await get(person, avatarUrl)).status).toBe(404)
    expect((await request(person, 'GET', '/v1/me')).body.avatarUrl).toBeNull()
    const team = await act(ws.owner, 'team.list', {})
    expect(team.body.data.members).toContainEqual(expect.objectContaining({ userId: person.userId, avatarUrl: null }))
    expect((await memberRows(person.userId)).map(r => r.avatar_version)).toEqual([null])
    expect((await act(person, 'account.removeAvatar', {})).status).toBe(200)
  })
})
