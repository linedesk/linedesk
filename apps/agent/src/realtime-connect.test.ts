import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { firstConnection, REALTIME_CONNECT_DEADLINE_MS, REALTIME_CONNECT_TIMEOUT_MS } from './realtime-connect.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('the connect timeout is a few seconds, and the call deadline only a little later', () => {
  expect(REALTIME_CONNECT_TIMEOUT_MS).toBe(4_000)
  expect(REALTIME_CONNECT_DEADLINE_MS).toBeGreaterThan(REALTIME_CONNECT_TIMEOUT_MS)
  expect(REALTIME_CONNECT_DEADLINE_MS).toBeLessThanOrEqual(6_000)
})

test('connected in time: the call goes on with the model', async () => {
  const connection = firstConnection(5_000)
  connection.start()
  vi.advanceTimersByTime(300)
  connection.connected()
  // A later error (a reconnect mid-call) changes nothing.
  connection.failed()
  vi.advanceTimersByTime(10_000)
  expect(await connection.first).toBe('connected')
  expect(await connection.later).toBe(true)
})

test("LiveKit's connect timeout before the first connection: failed at once, connected on the next try", async () => {
  const connection = firstConnection(5_000)
  connection.start()
  vi.advanceTimersByTime(4_000)
  connection.failed()
  expect(await connection.first).toBe('failed')
  connection.connected()
  expect(await connection.later).toBe(true)
})

test('nothing by the deadline: failed, also without an error (LIN-634: never a minute of silence)', async () => {
  const connection = firstConnection(5_000)
  connection.start()
  let outcome: string | null = null
  void connection.first.then(o => (outcome = o))
  await vi.advanceTimersByTimeAsync(4_999)
  expect(outcome).toBeNull()
  await vi.advanceTimersByTimeAsync(1)
  expect(outcome).toBe('failed')
})

test('the deadline runs from the first start only', async () => {
  const connection = firstConnection(5_000)
  connection.start()
  vi.advanceTimersByTime(3_000)
  connection.start()
  let outcome: string | null = null
  void connection.first.then(o => (outcome = o))
  await vi.advanceTimersByTimeAsync(2_000)
  expect(outcome).toBe('failed')
})

test('the caller hung up first: closed, and the model is no longer waited for', async () => {
  const connection = firstConnection(5_000)
  connection.start()
  connection.closed()
  expect(await connection.first).toBe('closed')
  expect(await connection.later).toBe(false)
})
