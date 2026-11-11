import { expect, test, vi } from 'vitest'
import { TEST_CALL_TIMEOUT_MS, TimedOut, testCallErrorText, within } from './testCallModel.ts'

test('a connection that never answers ends after the timeout', async () => {
  vi.useFakeTimers()
  const hung = within(new Promise(() => {}), TEST_CALL_TIMEOUT_MS)
  const seen = hung.catch(e => e)
  await vi.advanceTimersByTimeAsync(TEST_CALL_TIMEOUT_MS)
  expect(await seen).toBeInstanceOf(TimedOut)
  vi.useRealTimers()
})

test('an answer in time passes through', async () => {
  await expect(within(Promise.resolve('room'), 1000)).resolves.toBe('room')
})

test('server refusals never name LiveKit or settings', () => {
  expect(testCallErrorText('test calls are not set up: LiveKit is not configured on the server')).not.toMatch(/LiveKit/)
  expect(testCallErrorText('Too many test calls in a short time. Try again in a few minutes.')).toMatch(/few minutes/)
  expect(testCallErrorText('')).toMatch(/Try again/)
})

test('the daily limits are shown as the server words them', () => {
  for (const limit of ['You made 20 test calls today. Try again tomorrow.', 'This Linedesk has had as many test calls today as it allows. Try again tomorrow.', 'This workspace reached its monthly spending cap, so test calls are off until next month.'])
    expect(testCallErrorText(limit)).toBe(limit)
})
