import { expect, test, vi } from 'vitest'
import { ActionError } from './api-client.ts'
import { withRetry } from './retry.ts'

test('retries transport and server errors with exponential backoff', async () => {
  const wait = vi.fn(async () => {})
  const run = vi.fn<() => Promise<string>>()
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockRejectedValueOnce(new ActionError('call.finish', 500, 'internal error'))
    .mockResolvedValue('done')
  expect(await withRetry(run, { wait })).toBe('done')
  expect(run).toHaveBeenCalledTimes(3)
  expect(wait.mock.calls).toEqual([[500], [1000]])
})

test('gives up after the last attempt and does not retry a rejection', async () => {
  const wait = async () => {}
  const down = vi.fn(async () => { throw new TypeError('fetch failed') })
  await expect(withRetry(down, { attempts: 3, wait })).rejects.toThrow('fetch failed')
  expect(down).toHaveBeenCalledTimes(3)

  const rejected = vi.fn(async () => { throw new ActionError('call.finish', 409, 'call not found') })
  await expect(withRetry(rejected, { wait })).rejects.toThrow('call not found')
  expect(rejected).toHaveBeenCalledTimes(1)
})
