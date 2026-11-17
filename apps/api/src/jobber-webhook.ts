// POST /v1/apps/webhook/jobber (integrations/jobber/PUBLISHING.md, gap 1; LIN-447): Jobber's webhook for the
// APP_DISCONNECT topic, which Jobber requires of a published app. A business that removes Linedesk in Jobber has its
// connections to that Jobber account deleted here with their tokens (app-connections.ts dropAppAccount), in every
// workspace that uses the account; Jobber is not asked to disconnect again. Other topics are answered 200 and ignored.
//
// No session, no cookie: Jobber signs the raw body with the app's client secret (the one stored under Server admin ›
// Providers › Jobber, encrypted), base64 HMAC-SHA256 in X-Jobber-Hmac-SHA256. A missing or wrong signature is 401.
// Delivery is at least once and Jobber waits one second for the answer: a repeat finds nothing and answers 200, and
// the delete is one short transaction. The body and the secret are never logged.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { dropAppAccount } from './app-connections.ts'
import { db } from './db.ts'
import { resolveProvider } from './provider-settings.ts'
import { SecretsKeyError } from './secrets.ts'

export const JOBBER_WEBHOOK_PATH = '/v1/apps/webhook/jobber'
/** Jobber's events are a few hundred bytes (ids and a time, no record data). */
export const JOBBER_WEBHOOK_MAX_BYTES = 64 * 1024
export const JOBBER_SIGNATURE_HEADER = 'x-jobber-hmac-sha256'
/** A base64 SHA-256 digest: 44 characters. A header of another shape is refused before anything is read. */
const SIGNATURE_SHAPE = /^[A-Za-z0-9+/]{43}=$/

/** Refused deliveries are logged at most once a minute, with how many there were (a flood never fills the log). */
const REFUSED_LOG_MS = 60_000
const refusedLog = { at: 0, count: 0 }
function logRefused(reason: string, now = Date.now()) {
  refusedLog.count++
  if (now - refusedLog.at < REFUSED_LOG_MS) return
  console.warn(`jobber webhook: ${refusedLog.count} deliveries refused since the last note (latest: ${reason})`)
  refusedLog.at = now
  refusedLog.count = 0
}

/** Whether `signature` is Jobber's for this body: compared in constant time, as base64 strings. */
export function jobberSignatureValid(raw: Uint8Array, signature: string, clientSecret: string) {
  const expected = Buffer.from(createHmac('sha256', clientSecret).update(raw).digest('base64'), 'utf8')
  const received = Buffer.from(signature, 'utf8')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

type JobberEvent = { topic: string; accountId: string | null; occurredAt: number | null }

/**
 * How far Jobber's clock and this server's may differ. A grant stored less than this before the event counts as newer
 * than it and stays: a connect again right after a disconnect is never wiped by that disconnect's late delivery.
 */
export const JOBBER_CLOCK_SKEW_MS = 60_000

/**
 * The event of a delivery: `{ data: { webHookEvent: { topic, appId, accountId, itemId, occurredAt } } }`. Read
 * defensively: `webhookEvent` is accepted too, and a body of another shape is no event (null).
 */
export function jobberEvent(raw: Uint8Array): JobberEvent | null {
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return null
  }
  const data = (body as { data?: Record<string, unknown> } | null)?.data
  const event = (data?.webHookEvent ?? data?.webhookEvent) as Record<string, unknown> | undefined
  if (!event || typeof event.topic !== 'string') return null
  const accountId = typeof event.accountId === 'string' && event.accountId.trim() ? event.accountId.trim() : null
  const occurredAt = typeof event.occurredAt === 'string' ? Date.parse(event.occurredAt) : Number.NaN
  return { topic: event.topic, accountId, occurredAt: Number.isFinite(occurredAt) ? occurredAt : null }
}

const GID_PREFIX = 'gid://Jobber/Account/'

/**
 * The forms one Jobber account id may be stored in. The connection stores what `account { id }` answers (an encoded
 * id, base64 of `gid://Jobber/Account/<n>`); the webhook should name the same, but a plain or decoded form matches too.
 */
export function jobberAccountIds(accountId: string): string[] {
  const ids = new Set([accountId])
  let plain: string | null = null
  if (/^\d+$/.test(accountId)) plain = accountId
  else if (accountId.startsWith(GID_PREFIX)) plain = accountId.slice(GID_PREFIX.length)
  else {
    const decoded = Buffer.from(accountId, 'base64').toString('utf8')
    if (decoded.startsWith(GID_PREFIX)) plain = decoded.slice(GID_PREFIX.length)
  }
  if (plain && /^\d+$/.test(plain)) {
    ids.add(plain)
    ids.add(`${GID_PREFIX}${plain}`)
    ids.add(Buffer.from(`${GID_PREFIX}${plain}`, 'utf8').toString('base64'))
  }
  return [...ids]
}

/**
 * The Jobber app's client secret, or null when it is not set up. A stored secret that no longer decrypts (SECRETS_KEY
 * changed) is null too, noted in the log once a minute: every delivery would otherwise be an error report.
 */
async function jobberClientSecret() {
  try {
    return (await resolveProvider(db, 'jobber')).client_secret?.value ?? null
  } catch (error) {
    if (!(error instanceof SecretsKeyError)) throw error
    logRefused('the stored Jobber client secret cannot be decrypted')
    return null
  }
}

/** Forgets the log throttle (tests). */
export function resetJobberWebhookLimits() {
  refusedLog.at = 0
  refusedLog.count = 0
}

// biome-ignore lint/suspicious/noExplicitAny: the app's variables are not this route's concern
export function registerJobberWebhookRoute(app: Hono<any>) {
  app.post(
    JOBBER_WEBHOOK_PATH,
    bodyLimit({
      maxSize: JOBBER_WEBHOOK_MAX_BYTES,
      onError: c => c.json({ ok: false, error: 'request too large' }, 413),
    }),
    async c => {
      const signature = c.req.header(JOBBER_SIGNATURE_HEADER)
      if (!signature) {
        logRefused('missing signature')
        return c.json({ ok: false, error: 'missing signature' }, 401)
      }
      if (!SIGNATURE_SHAPE.test(signature)) {
        logRefused('malformed signature header')
        return c.json({ ok: false, error: 'bad signature' }, 401)
      }
      // The Jobber app is not set up on this install: there is nothing that could have signed this.
      const clientSecret = await jobberClientSecret()
      if (!clientSecret) return c.notFound()
      const raw = new Uint8Array(await c.req.arrayBuffer())
      if (!jobberSignatureValid(raw, signature, clientSecret)) {
        logRefused('bad signature')
        return c.json({ ok: false, error: 'bad signature' }, 401)
      }
      const event = jobberEvent(raw)
      // Signed by Jobber but nothing this route handles: answered 200, so Jobber does not send it again.
      if (event?.topic !== 'APP_DISCONNECT' || !event.accountId) return c.json({ ok: true, ignored: true })
      const ids = jobberAccountIds(event.accountId)
      // Only grants stored before the event go; without a usable time, every connection to the account does.
      const grantedBefore =
        event.occurredAt === null ? null : new Date(event.occurredAt - JOBBER_CLOCK_SKEW_MS).toISOString()
      const deleted = await db.transaction(tx => dropAppAccount(tx, 'jobber', ids, grantedBefore))
      if (deleted.length) console.log(`jobber webhook: APP_DISCONNECT removed ${deleted.length} connection(s)`)
      return c.json({ ok: true })
    },
  )
}
