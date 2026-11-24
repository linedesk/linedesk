// The stand-in during-call webhook (test-lookup.ts): 404 unless TEST_LOOKUP=on; then a made-up answer that
// lookupAnswerFrom takes, for the request Linedesk itself sends (duringCallRequest).
import { lookupAnswerFrom } from '@linedesk/actions'
import { afterEach, describe, expect, test } from 'vitest'
import { TEST_LOOKUP_MAX_DELAY_MS, TEST_LOOKUP_PATH, testLookupAnswer, testLookupDelay } from '../src/test-lookup.ts'
import { appRequest } from './helpers.ts'

const saved = process.env.TEST_LOOKUP
afterEach(() => {
  if (saved === undefined) delete process.env.TEST_LOOKUP
  else process.env.TEST_LOOKUP = saved
})

const request = (lookup: string, values: Record<string, unknown>) => ({
  hook: 'during_call',
  lookup,
  values,
  call_id: 'call_x',
  workspace_id: 'ws_x',
  assistant_id: 'as_x',
  assistant_name: 'Maya',
  from_number: '+15035550123',
  to_number: '+15035550100',
  started_at: new Date().toISOString(),
  test: true,
  caller_verified: true,
  caller: null,
})

const post = (body: unknown, contentType = 'application/json', query = '') =>
  appRequest(TEST_LOOKUP_PATH + query, {
    method: 'POST',
    headers: { 'content-type': contentType, 'linedesk-hook': 'during_call' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('test lookup responder', () => {
  test('is off unless TEST_LOOKUP=on', async () => {
    delete process.env.TEST_LOOKUP
    expect((await post(request('order_status', { order_number: '1234' }))).status).toBe(404)
    process.env.TEST_LOOKUP = 'true'
    expect((await post(request('order_status', { order_number: '1234' }))).status).toBe(404)
  })

  test('answers an order lookup with the order number, as lookupAnswerFrom reads it', async () => {
    process.env.TEST_LOOKUP = 'on'
    const res = await post(request('order_status', { email: 'sam@brightwater.example', order_number: 1234 }))
    expect(res.status).toBe(200)
    expect(lookupAnswerFrom(await res.json())).toBe('Order 1234 shipped on Monday and arrives on Thursday.')
  })

  test('answers any other lookup with a generic made-up answer', async () => {
    process.env.TEST_LOOKUP = 'on'
    const res = await post(request('service_area', { zip: '97201' }))
    expect(await res.json()).toEqual({ answer: 'Found the record for 97201; everything is up to date.' })
  })

  test('refuses a body that is not a during-call request', async () => {
    process.env.TEST_LOOKUP = 'on'
    expect((await post({ hook: 'call_start' })).status).toBe(400)
    expect((await post('not json', 'text/plain')).status).toBe(400)
  })

  test('says back one short line of what the caller gave, and nothing without values', () => {
    expect(testLookupAnswer('order_status', {})).toBe('The order shipped on Monday and arrives on Thursday.')
    expect(testLookupAnswer('account', { flag: true })).toBe('Found the record for true; everything is up to date.')
    expect(testLookupAnswer('account', { nested: { a: 1 } })).toBe('Found the record; everything is up to date.')
    const long = testLookupAnswer('order_status', { order: `12\n34 ${'x'.repeat(100)}` })
    expect(long).toBe(`Order 12 34 ${'x'.repeat(34)} shipped on Monday and arrives on Thursday.`)
  })

  test('?delay_ms= waits before it answers, at most TEST_LOOKUP_MAX_DELAY_MS', async () => {
    process.env.TEST_LOOKUP = 'on'
    const started = Date.now()
    const res = await post(request('order_status', { order_number: '1' }), 'application/json', '?delay_ms=300')
    expect(res.status).toBe(200)
    expect(Date.now() - started).toBeGreaterThanOrEqual(290)
    expect(testLookupDelay('5000')).toBe(5000)
    expect(testLookupDelay('999999')).toBe(TEST_LOOKUP_MAX_DELAY_MS)
    for (const bad of [undefined, '', '-5', '1.5', 'abc']) expect(testLookupDelay(bad)).toBe(0)
  })
})
