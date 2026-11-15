import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from './session.ts'

vi.mock('./auth.ts', () => ({ signedInAccount: vi.fn(async () => null) }))
const { expectSessionChange, forgetMe, leftAndDeleted, loadSession, markLeft, rememberedSession, sameSession, signedOutOfWorkspace } = await import('./session.ts')
const { signedInAccount } = await import('./auth.ts')
const { i18n } = await import('./i18n/index.tsx')

const me = { actorId: 'u1', role: 'owner', permissions: ['call:write'], workspace: { id: 'ws1', name: 'Tims Org' }, sessionExpiresAt: '2100-01-01T00:00:00.000Z' }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

const storage = () => {
  const memory = new Map<string, string>()
  return { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => memory.set(k, v), removeItem: (k: string) => memory.delete(k) }
}
beforeEach(() => {
  vi.stubGlobal('localStorage', storage())
  vi.stubGlobal('sessionStorage', storage())
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

describe('a session the server ended while signed in (A7)', () => {
  const signIn = async (who: object = me) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, who)))
    await loadSession()
  }
  it('names the workspace on the sign-in page when the session ended before its time, until someone signs in', async () => {
    await signIn()
    vi.stubGlobal('fetch', vi.fn(async () => json(401, {})))
    expect(await loadSession()).toEqual({ state: 'signedOut' })
    expect(signedOutOfWorkspace()).toBe('Tims Org')
    expect(await loadSession()).toEqual({ state: 'signedOut' }) // a second load (React's dev double start) keeps it
    expect(signedOutOfWorkspace()).toBe('Tims Org')
    await signIn()
    expect(signedOutOfWorkspace()).toBeNull()
  })
  it('says only "signed out": the server does not say why (a removal, a password change, another device signing it out)', async () => {
    await signIn()
    vi.stubGlobal('fetch', vi.fn(async () => json(401, {})))
    await loadSession()
    const note = i18n().t('auth.signedOutOf', { workspace: signedOutOfWorkspace()! })
    expect(note).toBe('You were signed out of Tims Org.')
    expect(note).not.toMatch(/access|removed|ended/i)
  })
  it('says nothing after a session that ran out, a sign-out here, or without a remembered workspace', async () => {
    await signIn({ ...me, sessionExpiresAt: '2020-01-01T00:00:00.000Z' })
    vi.stubGlobal('fetch', vi.fn(async () => json(401, {})))
    await loadSession()
    expect(signedOutOfWorkspace()).toBeNull()

    await signIn()
    forgetMe() // signed out on purpose
    vi.stubGlobal('fetch', vi.fn(async () => json(401, {})))
    await loadSession()
    expect(signedOutOfWorkspace()).toBeNull()
  })
})

describe('warm start from this device', () => {
  const signIn = async (who: object = me) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, who)))
    await loadSession()
  }
  it('opens the remembered workspace before the server answers', async () => {
    expect(rememberedSession()).toBeNull() // nobody remembered: wait for /v1/me
    await signIn()
    expect(rememberedSession()).toEqual({ state: 'ready', me, offline: false })
  })
  it('waits for the server after signing out, or while impersonating or onboarding', async () => {
    await signIn()
    forgetMe()
    expect(rememberedSession()).toBeNull()
    await signIn({ ...me, impersonation: { userId: 'u2' } })
    expect(rememberedSession()).toBeNull()
    await signIn({ ...me, onboarding: { step: 'business' } })
    expect(rememberedSession()).toBeNull()
  })
  it('waits for the server once the remembered session has ended, or when it does not say when it ends', async () => {
    await signIn({ ...me, sessionExpiresAt: '2020-01-01T00:00:00.000Z' })
    expect(rememberedSession()).toBeNull()
    await signIn({ ...me, sessionExpiresAt: undefined })
    expect(rememberedSession()).toBeNull()
    await signIn({ ...me, sessionExpiresAt: '2030-01-01T00:00:00.000Z' })
    expect(rememberedSession(null, Date.parse('2029-12-31T23:59:59Z'))).toMatchObject({ state: 'ready' })
    expect(rememberedSession(null, Date.parse('2030-01-01T00:00:00Z'))).toBeNull()
  })
  it('never lets an answer that was on its way undo a sign-out or a switch', async () => {
    await signIn()
    let answer!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answer = resolve })))
    const late = loadSession()
    forgetMe() // signed out in another tab meanwhile
    answer(json(200, me))
    await late
    expect(rememberedSession()).toBeNull()

    await signIn()
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answer = resolve })))
    const beforeSwitch = loadSession()
    expectSessionChange() // this tab switches while the answer is on its way
    answer(json(200, me))
    await beforeSwitch
    expect(rememberedSession()).toBeNull() // the reload after the switch still waits for /v1/me
  })
  it('waits for the server for a link to another workspace', async () => {
    await signIn()
    expect(rememberedSession('ws2')).toBeNull()
    expect(rememberedSession('ws1')).toMatchObject({ state: 'ready' })
  })
  it('waits for the server once while this tab changes its session, until it answers', async () => {
    await signIn()
    expectSessionChange()
    expect(rememberedSession()).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await loadSession()
    expect(rememberedSession()).toBeNull() // no answer yet: still waiting
    await signIn()
    expect(rememberedSession()).toMatchObject({ state: 'ready' })
  })
  it('keeps the screen only when the answer says the same', async () => {
    await signIn()
    const shown = rememberedSession()!
    const ready = (who: object, offline = false) => ({ state: 'ready', me: who, offline }) as Session
    expect(sameSession(shown, ready({ ...me }))).toBe(true)
    expect(sameSession(shown, ready({ ...me, permissions: [] }))).toBe(false)
    expect(sameSession(shown, ready({ ...me, workspace: { id: 'ws2', name: 'Other' } }))).toBe(false)
    expect(sameSession(shown, ready(me, true))).toBe(false)
    expect(sameSession(shown, { state: 'signedOut' })).toBe(false)
  })
})

describe('leaving the last workspace with the account (LIN-266)', () => {
  it('the sign-in page learns that the account is gone, and which workspace was left', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, me)))
    await loadSession()
    markLeft({ accountDeleted: true })
    forgetMe() // signed out and forgotten right after (TeamPage.tsx LeaveWorkspace)
    expect(leftAndDeleted()).toBe('Tims Org')
  })
  it('says nothing when the account stays, or once a workspace opens again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, me)))
    await loadSession()
    markLeft()
    expect(leftAndDeleted()).toBeNull()
    markLeft({ accountDeleted: true })
    await loadSession()
    expect(leftAndDeleted()).toBeNull()
  })
})
