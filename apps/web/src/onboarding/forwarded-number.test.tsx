import type { Tables } from '@linedesk/db/types'
import type { Snapshot } from '@linedesk/sync'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { ForwardingMissing } from './SetupRowActions.tsx'
import { waitForForwardedNumber } from './forwarded-number.ts'

type Number = Pick<Tables['phone_numbers'], 'id' | 'mode'>

/** A store whose numbers the test sets, and whose read of them the test answers (or never does). */
function fakeStore(read: () => Promise<boolean>, numbers: Number[] = []) {
  const listeners = new Set<() => void>()
  let snapshot = snap(numbers)
  function snap(rows: Number[]) {
    return {
      tables: { phone_numbers: new Map(rows.map(r => [r.id, r])) },
      synced: new Set(),
      online: true,
      readSyncDown: false,
      refused: null,
    } as unknown as Snapshot
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    refresh: vi.fn(read),
    /** The read sync brings these numbers. */
    arrive(rows: Number[]) {
      snapshot = snap(rows)
      for (const l of listeners) l()
    },
    listeners,
  }
}
const forwarded = { id: 'pn_1', mode: 'forward_conditional' } as Number
const never = () => new Promise<boolean>(() => {})

afterEach(() => vi.restoreAllMocks())

test('opens at once when the forwarded number is in the store, without asking the server', async () => {
  const store = fakeStore(never, [forwarded])
  const wait = waitForForwardedNumber(store, 50)
  expect(await wait.done).toBeNull()
  expect(store.refresh).not.toHaveBeenCalled()
  expect(store.listeners.size).toBe(0)
})

test('opens as soon as the number arrives with the read sync', async () => {
  const store = fakeStore(never)
  const wait = waitForForwardedNumber(store, 5000)
  expect(store.refresh).toHaveBeenCalledWith(['phone_numbers'], undefined)
  store.arrive([{ id: 'pn_2', mode: 'new' } as Number, { id: 'pn_3', mode: 'forward_all' } as Number])
  expect(await wait.done).toBeNull()
})

// The review build: the tab leading the read sync was in the background and read nothing; the button spun forever.
test('never waits forever: numbers that do not arrive in time are said, and the cause is logged', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = fakeStore(never)
  expect(await waitForForwardedNumber(store, 20).done).toBe('not_loaded')
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('did not arrive'),
    expect.objectContaining({ readFinished: null, numbersOnDevice: 0 }),
  )
  expect(store.listeners.size).toBe(0)
})

test('says at once when the numbers were read, also the whole table, and none forwards', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = fakeStore(async () => true, [{ id: 'pn_2', mode: 'new' } as Number])
  expect(await waitForForwardedNumber(store, 5000).done).toBe('none')
  expect(store.refresh.mock.calls).toEqual([
    [['phone_numbers'], undefined],
    [['phone_numbers'], { fresh: true }],
  ])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('no forwarded number'), { numbers: ['new'] })
})

// The review build's device had no numbers while the leading tab's cursor said the table was up to date: a read from
// that cursor brings nothing, the whole table brings the number.
test('a read that brings no number is followed by one of the whole table, which opens the dialog', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let store: ReturnType<typeof fakeStore>
  store = fakeStore(async () => {
    if (store.refresh.mock.calls.length === 2) store.arrive([forwarded])
    return true
  })
  expect(await waitForForwardedNumber(store, 5000).done).toBeNull()
  expect(store.refresh).toHaveBeenLastCalledWith(['phone_numbers'], { fresh: true })
  expect(warn).not.toHaveBeenCalled()
})

test('a read that did not finish in time is not taken for "no number"', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = fakeStore(async () => false)
  expect(await waitForForwardedNumber(store, 30).done).toBe('not_loaded')
})

test('cancel stops waiting (the dialog closed)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = fakeStore(never)
  const wait = waitForForwardedNumber(store, 20)
  wait.cancel()
  await new Promise(r => setTimeout(r, 40))
  expect(warn).not.toHaveBeenCalled()
  expect(store.listeners.size).toBe(0)
})

test('the message in place of the button says why and links to Workspace settings › Phone numbers', () => {
  const none = renderToStaticMarkup(<ForwardingMissing missing="none" onRetry={() => {}} />)
  expect(none).toContain('No forwarded number in this workspace.')
  expect(none).toContain('href="#workspace/phone"')
  expect(none).toContain('Workspace settings › Phone numbers')
  expect(none).not.toContain('Try again')
  const late = renderToStaticMarkup(<ForwardingMissing missing="not_loaded" onRetry={() => {}} />)
  expect(late).toContain('Your phone numbers didn&#x27;t load.')
  expect(late).toContain('Try again')
  expect(late).toContain('href="#workspace/phone"')
})
