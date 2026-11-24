// The Checkout return confirms each session once, however often its page mounts (StrictMode runs effects twice):
// one `billing.confirmCheckout` request, one audit log entry.
import { expect, test, vi } from 'vitest'

const callAction = vi.fn()
vi.mock('./settings/settings-api.ts', () => ({ callAction }))
const { confirmCheckout } = await import('./checkout.ts')

test('one request per session, shared by every caller', async () => {
  callAction.mockResolvedValueOnce({ status: 'trialing' })
  const [a, b] = await Promise.all([confirmCheckout('cs_test_once'), confirmCheckout('cs_test_once')])
  expect(a).toEqual({ status: 'trialing' })
  expect(b).toBe(a)
  expect(await confirmCheckout('cs_test_once')).toBe(a)
  expect(callAction).toHaveBeenCalledTimes(1)
})

test('a failed confirmation is asked again on the next try', async () => {
  callAction.mockReset()
  callAction.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 'trialing' })
  expect(await confirmCheckout('cs_test_retry')).toEqual({ status: 'failed' })
  expect(await confirmCheckout('cs_test_retry')).toEqual({ status: 'trialing' })
  expect(callAction).toHaveBeenCalledTimes(2)
})
