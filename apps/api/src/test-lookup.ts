// POST /v1/webhooks/test-lookup: a stand-in for a business's during-call webhook (docs/webhooks.md, "Testing the
// during-call hook"), so a lookup can be tried end to end without a server of one's own. Set an assistant's webhook
// URL to it and turn on "During the call": it answers each lookup with made-up data, at once, or after `?delay_ms=`
// (at most TEST_LOOKUP_MAX_DELAY_MS) to try the filler, the long-wait line and the time-out (LIN-341).
//
// Off unless TEST_LOOKUP=on: then it answers, else 404, so an install that never turned it on exposes nothing and a
// live assistant cannot be pointed at made-up answers by mistake. Not an action: it reads only the request, writes
// and logs nothing, and calls nobody. No session, no signature check (the answers are the same for everyone).
import type { Env as HonoEnv, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

type Env = Record<string, string | undefined>

export const TEST_LOOKUP_PATH = '/v1/webhooks/test-lookup'
/** As much as Linedesk sends for one lookup (10 fields and the call), with room to spare. */
const TEST_LOOKUP_MAX_BYTES = 32 * 1024
/** The longest `?delay_ms=` waits: past the lookup's own time-out, so that can be tried too. */
export const TEST_LOOKUP_MAX_DELAY_MS = 15_000
/** A value said back in the answer is cut to this many characters. */
const VALUE_MAX = 40

export const testLookupOn = (env: Env = process.env) => env.TEST_LOOKUP === 'on'

/** The value the answer names: the field about the order or a number, else the first one; one line, short. */
function namedValue(values: Record<string, unknown>): string | null {
  const entries = Object.entries(values).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
  const [, value] = entries.find(([name]) => /order|number/i.test(name)) ?? entries[0] ?? []
  if (value === undefined) return null
  const text = String(value).replace(/\s+/g, ' ').trim().slice(0, VALUE_MAX)
  return text || null
}

/** The made-up answer to one lookup: an order status for a lookup about orders, else a record that is on file. */
export function testLookupAnswer(lookup: string, values: Record<string, unknown>): string {
  const value = namedValue(values)
  if (/order/i.test(lookup))
    return value
      ? `Order ${value} shipped on Monday and arrives on Thursday.`
      : 'The order shipped on Monday and arrives on Thursday.'
  return value
    ? `Found the record for ${value}; everything is up to date.`
    : 'Found the record; everything is up to date.'
}

/** `?delay_ms=` as a wait in ms: a whole number from 0 to TEST_LOOKUP_MAX_DELAY_MS, anything else 0. */
export function testLookupDelay(param: string | undefined): number {
  const ms = Number(param)
  return Number.isInteger(ms) && ms > 0 ? Math.min(ms, TEST_LOOKUP_MAX_DELAY_MS) : 0
}

/** The lookup and its values of a during-call request, or null when the body is not one. */
function duringCallOf(body: unknown): { lookup: string; values: Record<string, unknown> } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const { hook, lookup, values } = body as { hook?: unknown; lookup?: unknown; values?: unknown }
  if (hook !== 'during_call' || typeof lookup !== 'string') return null
  const fields =
    values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>) : {}
  return { lookup, values: fields }
}

export function registerTestLookupRoute<E extends HonoEnv>(app: Hono<E>) {
  app.post(
    TEST_LOOKUP_PATH,
    async (c, next) => (testLookupOn() ? next() : c.json({ ok: false, error: 'not found' }, 404)),
    bodyLimit({ maxSize: TEST_LOOKUP_MAX_BYTES, onError: c => c.json({ ok: false, error: 'request too large' }, 413) }),
    async c => {
      const request = duringCallOf(await c.req.json().catch(() => null))
      if (!request) return c.json({ ok: false, error: 'not a during_call request' }, 400)
      const delay = testLookupDelay(c.req.query('delay_ms'))
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      return c.json({ answer: testLookupAnswer(request.lookup, request.values) })
    },
  )
}
