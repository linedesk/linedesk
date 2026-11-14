// The workspace icon (Workspace settings › General): workspace.setIcon / workspace.removeIcon, the checks it shares
// with the install logo (a real PNG of at most 512×512 and 512 KB), who may set it and who may see it, how it is
// served, and the workspace lists of /v1/me that carry its address.
import { commands, workspace_icons } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { act, addMember, appRequest, type Caller, createWorkspace, request, type Workspace } from './helpers.ts'

/** A real 1×1 PNG. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const dataUrl = (bytes: Buffer, type = 'image/png') => `data:${type};base64,${bytes.toString('base64')}`
const PNG = dataUrl(PNG_BYTES)

/** The same PNG claiming other dimensions in its header. */
function pngSized(width: number, height: number) {
  const bytes = Buffer.from(PNG_BYTES)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return dataUrl(bytes)
}

const get = (who: Caller, path: string) => appRequest(path, { headers: who.headers })

let ws: Workspace
let other: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Icon Plumbing')
  other = await createWorkspace('Other Heating')
})

describe('workspace.setIcon', () => {
  test('an owner sets the icon; it is served as a PNG to members, and /v1/me carries its address', async () => {
    const res = await act(ws.owner, 'workspace.setIcon', { icon: PNG })
    expect(res.status).toBe(200)
    const iconUrl = res.body.data.iconUrl as string
    expect(iconUrl).toMatch(new RegExp(`^/v1/workspace-icons/${ws.id}\\.png\\?v=[\\w-]+$`))

    const served = await get(ws.owner, iconUrl)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(served.headers.get('cache-control')).toContain('private')
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG_BYTES)).toBe(true)

    const member = await addMember(ws.id, 'member')
    expect((await get(member, iconUrl)).status).toBe(200)

    const me = await request(ws.owner, 'GET', '/v1/me')
    expect(me.body.workspace).toMatchObject({ id: ws.id, iconUrl })
    expect(me.body.workspaces).toContainEqual(expect.objectContaining({ id: ws.id, iconUrl }))
    const list = await request(ws.owner, 'GET', '/v1/me/workspaces')
    expect(list.body).toContainEqual(expect.objectContaining({ id: ws.id, iconUrl }))
  })

  test('a new icon gets a new address; the command log does not keep the image', async () => {
    const first = (await act(ws.owner, 'workspace.setIcon', { icon: PNG })).body.data.iconUrl
    const second = (await act(ws.owner, 'workspace.setIcon', { icon: PNG })).body.data.iconUrl
    expect(second).not.toBe(first)
    const [row] = await db.select().from(workspace_icons).where(eq(workspace_icons.workspace_id, ws.id))
    expect(second).toContain(`v=${row!.version}`)
    const logged = await db
      .select({ input: commands.input })
      .from(commands)
      .where(and(eq(commands.workspace_id, ws.id), eq(commands.action, 'workspace.setIcon')))
    expect(logged.length).toBeGreaterThan(0)
    expect(JSON.stringify(logged)).not.toContain(PNG_BYTES.toString('base64').slice(0, 20))
  })

  test('members and the agent may not set or remove it', async () => {
    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'workspace.setIcon', { icon: PNG })).status).toBe(403)
    expect((await act(member, 'workspace.removeIcon', {})).status).toBe(403)
    const admin = await addMember(ws.id, 'admin')
    expect((await act(admin, 'workspace.setIcon', { icon: PNG })).status).toBe(200)
  })

  test('only a real PNG of at most 512×512 pixels and 512 KB: SVG, JPEG, a renamed file and larger images are refused', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(40)])
    // Not a PNG data URL at all: refused by the input schema.
    const huge = dataUrl(Buffer.concat([PNG_BYTES, Buffer.alloc(600 * 1024)]))
    for (const icon of [dataUrl(svg, 'image/svg+xml'), dataUrl(jpeg, 'image/jpeg'), 'https://example.com/a.png', huge])
      expect((await act(other.owner, 'workspace.setIcon', { icon })).status, icon.slice(0, 40)).toBe(422)
    // Claims to be a PNG: the bytes are checked like the install logo's.
    const refused = [
      dataUrl(svg), // an SVG sent as a PNG
      dataUrl(jpeg), // a JPEG sent as a PNG
      dataUrl(Buffer.from('not an image at all, just text that is long enough')),
      pngSized(513, 512),
      pngSized(512, 4096),
      pngSized(0, 0),
      dataUrl(Buffer.concat([PNG_BYTES, Buffer.alloc(512 * 1024 + 1 - PNG_BYTES.length)])), // one byte over 512 KB
    ]
    for (const icon of refused) {
      const res = await act(other.owner, 'workspace.setIcon', { icon })
      expect(res.status, icon.slice(0, 40)).toBe(409)
      expect(res.body.error).toMatch(/^The icon (must be a PNG image|must be at most 512×512 pixels|is too large)/)
    }
    expect(await db.select().from(workspace_icons).where(eq(workspace_icons.workspace_id, other.id))).toEqual([])
    expect((await act(other.owner, 'workspace.setIcon', { icon: pngSized(512, 512) })).status).toBe(200)
    expect((await act(other.owner, 'workspace.removeIcon', {})).status).toBe(200)
  })

  test('people outside the workspace do not get its icon; its members get it from any of their workspaces', async () => {
    const { iconUrl } = (await act(ws.owner, 'workspace.setIcon', { icon: PNG })).body.data
    expect((await get(other.owner, iconUrl)).status).toBe(404)
    expect((await get({ headers: {} }, iconUrl)).status).toBe(401)
    expect((await get(ws.owner, `/v1/workspace-icons/${ws.id}`)).status).toBe(404)

    // The other workspace's owner joins this one too: its icon shows in their switcher while they work in their own.
    await auth.api.addMember({ body: { userId: other.owner.userId, organizationId: ws.id, role: 'member' } })
    expect((await get(other.owner, iconUrl)).status).toBe(200)
    const me = await request(other.owner, 'GET', '/v1/me')
    expect(me.body.workspace.id).toBe(other.id)
    expect(me.body.workspaces).toContainEqual(expect.objectContaining({ id: ws.id, iconUrl }))
  })
})

describe('workspace.removeIcon', () => {
  test('removes the icon: no longer served, the lists say null', async () => {
    const { iconUrl } = (await act(ws.owner, 'workspace.setIcon', { icon: PNG })).body.data
    const res = await act(ws.owner, 'workspace.removeIcon', {})
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ iconUrl: null })
    expect((await get(ws.owner, iconUrl)).status).toBe(404)
    const me = await request(ws.owner, 'GET', '/v1/me')
    expect(me.body.workspace.iconUrl).toBeNull()
    expect(me.body.workspaces).toContainEqual(expect.objectContaining({ id: ws.id, iconUrl: null }))
    // Removing it again is fine.
    expect((await act(ws.owner, 'workspace.removeIcon', {})).status).toBe(200)
  })
})
