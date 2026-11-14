import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  fetchQuery,
  forgetQueries,
  peekQuery,
  queryState,
  setQueryData,
  setQueryScope,
  subscribeQuery,
} from './cachedQuery.ts'

/** A Storage stand-in: the tests run without a browser. */
function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    keys: () => [...data.keys()],
  }
}

let storage: ReturnType<typeof memoryStorage>
beforeEach(() => {
  storage = memoryStorage()
  // Object.keys(localStorage) lists the stored keys, as in a browser.
  const enumerable = { enumerable: true, configurable: true }
  vi.stubGlobal(
    'localStorage',
    new Proxy(storage, { ownKeys: () => storage.keys(), getOwnPropertyDescriptor: () => enumerable }),
  )
  forgetQueries()
  setQueryScope('member-1/ws-1')
})
afterEach(() => vi.unstubAllGlobals())

describe('cached queries', () => {
  test('one load at a time, shared by everyone who asks', async () => {
    const load = vi.fn(async () => ['Brightwater'])
    await Promise.all([fetchQuery('workspaces', load), fetchQuery('workspaces', load)])
    expect(load).toHaveBeenCalledTimes(1)
    expect(peekQuery('workspaces')).toEqual(['Brightwater'])
  })

  test('a failed load keeps the last answer', async () => {
    await fetchQuery('team', async () => ['Mike'])
    await fetchQuery('team', async () => {
      throw new Error('offline')
    })
    expect(peekQuery('team')).toEqual(['Mike'])
  })

  test('a persisted answer is there at once after a reload of the page, for the same member only', async () => {
    await fetchQuery('settings', async () => ({ on: true }), { persist: true })
    setQueryScope('member-2/ws-1') // another member on this device starts empty
    await fetchQuery('settings', async () => ({ on: false }), { persist: true })
    setQueryScope('member-1/ws-1') // "reload": memory is gone, storage is not
    expect(peekQuery('settings')).toBeUndefined()
    void fetchQuery('settings', () => new Promise(() => {}), { persist: true }) // still loading…
    expect(peekQuery('settings')).toEqual({ on: true }) // …but the last answer shows
  })

  test('a change the page made shows at once', () => {
    setQueryData('settings', { days: 30 })
    setQueryData<{ days: number }>('settings', s => ({ ...s, days: 90 }))
    expect(peekQuery('settings')).toEqual({ days: 90 })
  })

  test('an answer to a load that started before such a change does not undo it', async () => {
    let answer!: (value: { zone: string }) => void
    const loading = fetchQuery('zone', () => new Promise<{ zone: string }>(resolve => (answer = resolve)))
    setQueryData('zone', { zone: 'America/Denver' })
    answer({ zone: 'America/Los_Angeles' })
    await loading
    expect(peekQuery('zone')).toEqual({ zone: 'America/Denver' })
    await fetchQuery('zone', async () => ({ zone: 'America/Chicago' }))
    expect(peekQuery('zone')).toEqual({ zone: 'America/Chicago' })
  })

  test('a query on screen when the member or workspace changes loads again for the new one', async () => {
    // An instance admin without a workspace: Server admin is on screen before /v1/me sets the scope.
    setQueryScope('')
    const answers = ['admin lists of the old scope', 'admin lists']
    const load = vi.fn(async () => answers.shift())
    const seen = vi.fn(() => queryState('admin.data').data)
    const unsubscribe = subscribeQuery('admin.data', seen)
    await fetchQuery('admin.data', load)
    expect(seen).toHaveLastReturnedWith('admin lists of the old scope')

    setQueryScope('admin-1/')
    // Nothing of the old scope shows under the new one…
    expect(seen).toHaveLastReturnedWith(undefined)
    await vi.waitFor(() => expect(seen).toHaveLastReturnedWith('admin lists'))
    // …and the screen still gets the next answers.
    expect(load).toHaveBeenCalledTimes(2)
    const calls = seen.mock.calls.length
    unsubscribe()
    await fetchQuery('admin.data', async () => 'later')
    expect(seen).toHaveBeenCalledTimes(calls)
  })

  test('an answer of the old scope still on its way does not show under the new one', async () => {
    const answers: ((value: string) => void)[] = []
    const unsubscribe = subscribeQuery('team', () => {})
    void fetchQuery('team', () => new Promise<string>(resolve => answers.push(resolve)))
    setQueryScope('member-2/ws-1')
    expect(answers).toHaveLength(2) // loaded again for member-2
    answers[0]?.('team of member-1')
    await Promise.resolve()
    expect(peekQuery('team')).toBeUndefined()
    answers[1]?.('team of member-2')
    await vi.waitFor(() => expect(peekQuery('team')).toBe('team of member-2'))
    unsubscribe()
  })

  test("sign-out forgets every member's answers but keeps what the sign-in page shows", async () => {
    setQueryScope('')
    await fetchQuery('auth-methods', async () => ({ password: true }), { persist: true })
    setQueryScope('member-1/ws-1')
    await fetchQuery('account', async () => ({ name: 'Mike' }), { persist: true })
    forgetQueries()
    expect(storage.keys()).toEqual(['linedesk-q::auth-methods'])
  })
})
