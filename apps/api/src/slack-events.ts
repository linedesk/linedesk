// POST /v1/apps/events/slack (LIN-447): the Events API URL of the install's Slack app, for the two events that say
// the app was removed inside Slack: `app_uninstalled`, and `tokens_revoked` with a bot token (the install's only token).
// Without it, an uninstall done in Slack showed only at the next post (a 404 or `no_service` from the webhook). Here
// the connections to that Slack workspace are deleted with their tokens and webhook (app-connections.ts
// dropAppAccount), in every Linedesk workspace that uses it; Slack is not asked to uninstall again. Slack's URL check
// (`url_verification`) is answered with its challenge. Every other event is answered 200 and ignored.
//
// No session, no cookie: Slack signs every request with the app's signing secret (Server admin › Providers › Slack,
// encrypted): `X-Slack-Signature` is `v0=` and the hex HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<raw body>`.
// A missing or wrong signature, or a timestamp more than five minutes off, is 401. Without a signing secret the
// route is 404 (an install without the events URL keeps the old behaviour). Slack waits three seconds and sends again
// on failure: a repeat finds nothing and answers 200. The body and the secret are never logged.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { dropAppAccount } from './app-connections.ts'
import { db } from './db.ts'
import { resolveProvider } from './provider-settings.ts'
import { SecretsKeyError } from './secrets.ts'

export const SLACK_EVENTS_PATH = '/v1/apps/events/slack'
/** The two events this route handles are a few hundred bytes. */
export const SLACK_EVENTS_MAX_BYTES = 64 * 1024
export const SLACK_SIGNATURE_HEADER = 'x-slack-signature'
export const SLACK_TIMESTAMP_HEADER = 'x-slack-request-timestamp'
/** Slack's own advice: refuse a request whose timestamp is more than five minutes from now (a replayed request). */
export const SLACK_MAX_AGE_SEC = 5 * 60
/** `v0=` and a hex SHA-256 digest. A header of another shape is refused before anything is read. */
const SIGNATURE_SHAPE = /^v0=[0-9a-f]{64}$/
const TIMESTAMP_SHAPE = /^\d{1,12}$/

/** Refused requests are logged at most once a minute, with how many there were (a flood never fills the log). */
const REFUSED_LOG_MS = 60_000
const refusedLog = { at: 0, count: 0 }
function logRefused(reason: string, now = Date.now()) {
  refusedLog.count++
  if (now - refusedLog.at < REFUSED_LOG_MS) return
  console.warn(`slack events: ${refusedLog.count} requests refused since the last note (latest: ${reason})`)
  refusedLog.at = now
  refusedLog.count = 0
}

/** Forgets the log throttle (tests). */
export function resetSlackEventsLimits() {
  refusedLog.at = 0
  refusedLog.count = 0
}

/** Whether `signature` is Slack's for this timestamp and body: compared in constant time, as hex strings. */
export function slackSignatureValid(raw: Uint8Array, timestamp: string, signature: string, signingSecret: string) {
  const mac = createHmac('sha256', signingSecret).update(`v0:${timestamp}:`, 'utf8').update(raw).digest('hex')
  const expected = Buffer.from(`v0=${mac}`, 'utf8')
  const received = Buffer.from(signature, 'utf8')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export type SlackRequest =
  | { kind: 'challenge'; challenge: string }
  /** The app left a Slack workspace (or organisation): the account ids its connections are stored under. */
  | { kind: 'removed'; accountIds: string[]; eventTime: number | null }
  | { kind: 'other' }

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/**
 * What a signed request asks. A connection stores the Slack workspace id (`team.id`), or the organisation id for an
 * org-wide install (`enterprise.id`, connectors slack.ts): the organisation id counts only when the event says the
 * install is org-wide, so one workspace of an organisation leaving never removes the organisation's install.
 */
export function slackRequest(raw: Uint8Array): SlackRequest {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
  } catch {
    return { kind: 'other' }
  }
  if (!body || typeof body !== 'object') return { kind: 'other' }
  if (body.type === 'url_verification') {
    const challenge = text(body.challenge)
    return challenge ? { kind: 'challenge', challenge: challenge.slice(0, 200) } : { kind: 'other' }
  }
  if (body.type !== 'event_callback') return { kind: 'other' }
  const event = (body.event ?? {}) as Record<string, unknown>
  const botTokens = ((event.tokens ?? {}) as Record<string, unknown>).bot
  const removed =
    event.type === 'app_uninstalled' ||
    (event.type === 'tokens_revoked' && Array.isArray(botTokens) && botTokens.length > 0)
  if (!removed) return { kind: 'other' }
  const authorizations = Array.isArray(body.authorizations) ? (body.authorizations as Record<string, unknown>[]) : []
  const orgWide = body.is_enterprise_install === true || authorizations.some(a => a?.is_enterprise_install === true)
  const ids = new Set<string>()
  const team = text(body.team_id)
  if (team) ids.add(team)
  const enterprise = text(body.enterprise_id)
  if (orgWide && enterprise) ids.add(enterprise)
  if (!ids.size) return { kind: 'other' }
  // Seconds; a time more than a day ahead is no usable time (it would not fit a date).
  const eventTime = Number(body.event_time) * 1000
  return {
    kind: 'removed',
    accountIds: [...ids],
    eventTime: Number.isFinite(eventTime) && eventTime > 0 && eventTime < Date.now() + 86_400_000 ? eventTime : null,
  }
}

/**
 * How far Slack's clock and this server's may differ. A grant stored less than this before the event counts as newer
 * than it and stays: an install again right after an uninstall is never wiped by that uninstall's late delivery.
 */
export const SLACK_CLOCK_SKEW_MS = 60_000

/**
 * The Slack app's signing secret, or null when it is not set. A stored secret that no longer decrypts (SECRETS_KEY
 * changed) is null too, noted in the log once a minute.
 */
async function slackSigningSecret() {
  try {
    return (await resolveProvider(db, 'slack')).signing_secret?.value ?? null
  } catch (error) {
    if (!(error instanceof SecretsKeyError)) throw error
    logRefused('the stored Slack signing secret cannot be decrypted')
    return null
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the app's variables are not this route's concern
export function registerSlackEventsRoute(app: Hono<any>) {
  app.post(
    SLACK_EVENTS_PATH,
    bodyLimit({
      maxSize: SLACK_EVENTS_MAX_BYTES,
      onError: c => c.json({ ok: false, error: 'request too large' }, 413),
    }),
    async c => {
      const signature = c.req.header(SLACK_SIGNATURE_HEADER)
      const timestamp = c.req.header(SLACK_TIMESTAMP_HEADER)
      if (!signature || !timestamp) {
        logRefused('missing signature')
        return c.json({ ok: false, error: 'missing signature' }, 401)
      }
      if (!SIGNATURE_SHAPE.test(signature) || !TIMESTAMP_SHAPE.test(timestamp)) {
        logRefused('malformed signature headers')
        return c.json({ ok: false, error: 'bad signature' }, 401)
      }
      if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SLACK_MAX_AGE_SEC) {
        logRefused('stale timestamp')
        return c.json({ ok: false, error: 'stale request' }, 401)
      }
      // No signing secret on this install: the events URL is not set up, nothing could have signed this.
      const signingSecret = await slackSigningSecret()
      if (!signingSecret) return c.notFound()
      const raw = new Uint8Array(await c.req.arrayBuffer())
      if (!slackSignatureValid(raw, timestamp, signature, signingSecret)) {
        logRefused('bad signature')
        return c.json({ ok: false, error: 'bad signature' }, 401)
      }
      const request = slackRequest(raw)
      if (request.kind === 'challenge') return c.json({ challenge: request.challenge })
      if (request.kind === 'other') return c.json({ ok: true, ignored: true })
      // Only grants stored before the event go; without a usable time, every connection to the account does.
      const grantedBefore =
        request.eventTime === null ? null : new Date(request.eventTime - SLACK_CLOCK_SKEW_MS).toISOString()
      const deleted = await db.transaction(tx => dropAppAccount(tx, 'slack', request.accountIds, grantedBefore))
      if (deleted.length) console.log(`slack events: uninstall removed ${deleted.length} connection(s)`)
      return c.json({ ok: true })
    },
  )
}
