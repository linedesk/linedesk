import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./auth.ts', () => ({ signedInAccount: vi.fn(async () => null) }))
const { forgetMe, loadSession } = await import('./session.ts')
const { signedInAccount } = await import('./auth.ts')

const me = { actorId: 'u1', role: 'owner', permissions: ['call:write'], workspace: { id: 'ws1', name: 'Tims Org' } }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => memory.set(k, v), removeItem: (k: string) => memory.delete(k) })
})
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(signedInAccount).mockResolvedValue(null) })

describe('session at load', () => {
  it('opens the app and remembers the member when the server answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, me)))
    expect(await loadSession()).toEqual({ state: 'ready', me, offline: false })
  })
  it('opens from local data when the server is unreachable and this device was signed in before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, me)))
    await loadSession()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await loadSession()).toEqual({ state: 'ready', me, offline: true })
    vi.stubGlobal('fetch', vi.fn(async () => json(502, {})))
    expect(await loadSession()).toEqual({ state: 'ready', me, offline: true })
  })
  it('waits for the server when this device has nothing to open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(503, {})))
    expect(await loadSession()).toEqual({ state: 'unreachable' })
  })
  it('forgets the member when signed out, here or on the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, me)))
    await loadSession()
    vi.stubGlobal('fetch', vi.fn(async () => json(401, {})))
    expect(await loadSession()).toEqual({ state: 'signedOut' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await loadSession()).toEqual({ state: 'unreachable' }) // nothing to open offline any more

    vi.stubGlobal('fetch', vi.fn(async () => json(200, me)))
    await loadSession()
    forgetMe()
    vi.stubGlobal('fetch', vi.fn(async () => json(502, {})))
    expect(await loadSession()).toEqual({ state: 'unreachable' })
  })
  it('asks for a workspace when signed in without one', async () => {
    vi.mocked(signedInAccount).mockResolvedValue('u_new')
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { ...me, actorId: 'u_new', workspace: null })))
    expect(await loadSession()).toEqual({ state: 'needsWorkspace', impersonation: null, me: { ...me, actorId: 'u_new', workspace: null }, lostWorkspace: null })
  })
  it('says which workspace was lost when the member was removed from the one this browser had open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, me)))
    await loadSession()
    vi.mocked(signedInAccount).mockResolvedValue('u1')
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { ok: false, code: 'no_workspace' })))
    expect(await loadSession()).toEqual({ state: 'needsWorkspace', impersonation: null, me: null, lostWorkspace: 'Tims Org' })
    // Loaded twice in a row (React's dev double start, a refresh): still said.
    expect(await loadSession()).toMatchObject({ lostWorkspace: 'Tims Org' })
    forgetMe() // the local data cleanup that follows (localData.ts forgetBeyond) does not lose it
    expect(await loadSession()).toMatchObject({ lostWorkspace: 'Tims Org' })
  })
  it("never names the last person's workspace to someone else who signed in on this browser", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, me)))
    await loadSession()
    vi.mocked(signedInAccount).mockResolvedValue('someone_else')
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { ok: false, code: 'no_workspace' })))
    expect(await loadSession()).toMatchObject({ state: 'needsWorkspace', lostWorkspace: null })
  })
})
