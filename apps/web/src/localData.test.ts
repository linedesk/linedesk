import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./auth.ts', () => ({ auth: { signOut: vi.fn(async () => ({})) }, signedInAccount: vi.fn(async () => null) }))
vi.mock('./storeCache.ts', () => ({ stopAllStores: vi.fn(async () => ['linedesk-ws_open']) }))
const { forgetBeyond, forgetElectricState, forgetLocalData, signOutAndForget } = await import('./localData.ts')
const { auth } = await import('./auth.ts')
const { stopAllStores } = await import('./storeCache.ts')

/** A browser's IndexedDB with these databases; `listed: false` is a browser without indexedDB.databases(). */
function fakeIndexedDb(names: string[], { listed = true } = {}) {
  const databases = new Set(names)
  const deleted: string[] = []
  vi.stubGlobal('indexedDB', {
    databases: listed ? async () => [...databases].map(name => ({ name, version: 3 })) : undefined,
    deleteDatabase(name: string) {
      const req: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {}
      databases.delete(name)
      deleted.push(name)
      queueMicrotask(() => req.onsuccess?.())
      return req
    },
  })
  return { deleted, left: () => [...databases].sort() }
}

/** Like the browser's: the entries are the object's own keys (Object.keys(localStorage)), the methods are not. */
function fakeStorage(entries: Record<string, string>) {
  const storage: Record<string, string> = { ...entries }
  const keys = () => Object.keys(storage)
  Object.defineProperties(storage, {
    length: { get: () => keys().length },
    key: { value: (i: number) => keys()[i] ?? null },
    getItem: { value: (k: string) => (k in storage ? storage[k] : null) },
    setItem: {
      value: (k: string, v: string) => {
        storage[k] = v
      },
    },
    removeItem: { value: (k: string) => void delete storage[k] },
  })
  vi.stubGlobal('localStorage', storage)
  return { keys: () => keys().sort() }
}

const member = {
  actorId: 'u1',
  role: 'owner',
  permissions: [],
  onboarding: null,
  phoneSetup: null,
  impersonation: null,
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('leaving a session deletes everything this browser kept of it', () => {
  it('every linedesk database (not only the open workspace), Electric’s keys and the cached reads', async () => {
    const idb = fakeIndexedDb(['linedesk-ws_open', 'linedesk-ws_other', 'someone-elses-db'])
    const storage = fakeStorage({
      electric_expired_shapes: '{}',
      electric_up_to_date_tracker: '{}',
      'linedesk-last-me': '{}',
      'linedesk-q:u1/ws_open:team': '[]',
      'linedesk-q::auth-methods': '{}', // what the sign-in page shows: no member, stays
      'linedesk.seenInvitations': '["inv_1"]',
      'linedesk-account': 'u1',
      'theme-of-the-page': 'dark',
    })
    await forgetLocalData()
    expect(stopAllStores).toHaveBeenCalledOnce() // stopped first, so the databases can go
    expect(idb.left()).toEqual(['someone-elses-db'])
    expect(storage.keys()).toEqual(['linedesk-q::auth-methods', 'theme-of-the-page'])
  })

  it('without indexedDB.databases() it still deletes the ones this page opened', async () => {
    const idb = fakeIndexedDb(['linedesk-ws_open', 'linedesk-ws_other'], { listed: false })
    fakeStorage({})
    await forgetLocalData()
    expect(idb.deleted).toEqual(['linedesk-ws_open'])
  })

  it('"Use a different account" signs out and forgets', async () => {
    const idb = fakeIndexedDb(['linedesk-ws_open'])
    fakeStorage({ electric_expired_shapes: '{}' })
    await signOutAndForget()
    expect(auth.signOut).toHaveBeenCalledOnce()
    expect(idb.left()).toEqual([])
  })

  it('Electric’s keys only', () => {
    const storage = fakeStorage({ electric_a: '1', electricity: '2', b_electric_: '3' })
    forgetElectricState()
    expect(storage.keys()).toEqual(['b_electric_', 'electricity'])
  })
})

describe('once the session is known', () => {
  it('another account than the last one (signed in in another tab): nothing of the last one stays', async () => {
    const idb = fakeIndexedDb(['linedesk-ws_shared', 'linedesk-ws_only_theirs'])
    const storage = fakeStorage({
      'linedesk-account': 'u_before',
      electric_expired_shapes: '{}',
      'linedesk-q:u_before/ws_shared:team': '[]',
      'linedesk-q:u1/ws_shared:workspaces': '[]',
      'linedesk-q::auth-methods': '{}',
      'linedesk.seenInvitations': '["inv_1"]',
    })
    const me = {
      ...member,
      workspace: { id: 'ws_shared', name: 'Shared' },
      workspaces: [
        { id: 'ws_shared', name: 'Shared' },
        { id: 'ws_only_theirs', name: 'X' },
      ],
    }
    await forgetBeyond({ state: 'ready', me, offline: false })
    // The workspace opening now is emptied by its store (it is marked with its account); every other database goes.
    expect(idb.left()).toEqual(['linedesk-ws_shared'])
    expect(storage.keys()).toEqual([
      'linedesk-account',
      'linedesk-q::auth-methods',
      'linedesk-q:u1/ws_shared:workspaces',
    ])
    expect(localStorage.getItem('linedesk-account')).toBe('u1')
  })

  it('signed in: databases of workspaces the member is no longer in go, theirs stay', async () => {
    const idb = fakeIndexedDb(['linedesk-ws_a', 'linedesk-ws_b', 'linedesk-ws_removed'])
    fakeStorage({})
    const me = {
      ...member,
      workspace: { id: 'ws_a', name: 'A' },
      workspaces: [
        { id: 'ws_a', name: 'A' },
        { id: 'ws_b', name: 'B' },
      ],
    }
    await forgetBeyond({ state: 'ready', me, offline: false })
    expect(idb.left()).toEqual(['linedesk-ws_a', 'linedesk-ws_b'])
    expect(stopAllStores).not.toHaveBeenCalled()
  })

  it('removed from the last workspace, or signed out: everything goes', async () => {
    for (const session of [{ state: 'needsWorkspace', impersonation: null, me: null, lostWorkspace: null }, { state: 'signedOut' }] as const) {
      const idb = fakeIndexedDb(['linedesk-ws_a'])
      fakeStorage({ electric_expired_shapes: '{}' })
      await forgetBeyond(session)
      expect(idb.left()).toEqual([])
    }
  })

  it('offline or unreachable: nothing is known, so nothing goes', async () => {
    const idb = fakeIndexedDb(['linedesk-ws_a', 'linedesk-ws_b'])
    fakeStorage({})
    const me = { ...member, workspace: { id: 'ws_a', name: 'A' }, workspaces: [{ id: 'ws_a', name: 'A' }] }
    await forgetBeyond({ state: 'ready', me, offline: true })
    await forgetBeyond({ state: 'unreachable' })
    expect(idb.deleted).toEqual([])
  })
})
