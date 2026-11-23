// Outside addresses for call emails (email_recipients): from before LIN-470, when an instruction could name an address
// outside the team. Rules name members only and LIN-769 removed the actions that added and confirmed them, so no new
// address is ever added; a confirmed one a stored route still names gets the call email (call-notifications.ts) with a
// one-click link to stop them (and the List-Unsubscribe headers). Also the rules' read for owners and admins
// (emailRouting.get).
//
// The stop link is a public route outside the action registry, like setup-unsubscribe.ts: the person who clicks has no
// session. It is scanner-safe (GET shows a page with a button, only POST acts) and limited per client address. The stop
// token is the address's id signed with a key derived from SECRETS_KEY (no expiry: an old email must still stop them).
// Tokens are never logged.
import { timingSafeEqual } from 'node:crypto'
import type { EmailRoutingData } from '@linedesk/actions'
import { email_recipients, member, organization, type Tx } from '@linedesk/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { Env, Hono } from 'hono'
import { localeForUser } from '@linedesk/i18n/server'
import { db } from './db.ts'
import { membersById } from './email-routing.ts'
import { outsideBusyPage, outsideStopPage } from './emails/pages.ts'
import { emailSafeName, WEB_ORIGIN } from './emails/templates.ts'
import { type EvaluationModel, evaluationModel } from './evaluations.ts'
import { type Handler, Reject } from './handler-context.ts'
import { addressBucket, clientIpOf } from './client-ip.ts'
import { createRateLimiter } from './rate-limit.ts'
import { hasSecretsKey, signWithSecretsKey } from './secrets.ts'

export const OUTSIDE_STOP_PATH = '/api/email-recipients/stop'
const STOP_PURPOSE = 'email-recipient-stop'
/** Requests to the public stop page per client address (IPv6: its /64) and minute. */
export const OUTSIDE_PAGE_REQUESTS_PER_MINUTE = 30
const allowPage = createRateLimiter({
  max: OUTSIDE_PAGE_REQUESTS_PER_MINUTE,
  windowMs: 60_000,
})

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8')

/** The stop token of an address: base64url(id).hmac. */
export const outsideStopToken = (id: string) => `${b64(id)}.${signWithSecretsKey(STOP_PURPOSE, id)}`

/** The id a stop token is for, or null when it is malformed, tampered with, or there is no SECRETS_KEY. */
export function readOutsideStopToken(token: string | undefined): string | null {
  const parts = (token ?? '').split('.')
  if (parts.length !== 2 || !hasSecretsKey()) return null
  const [encoded, mac] = parts as [string, string]
  if (!/^[0-9a-f]{64}$/.test(mac) || !/^[\w-]+$/.test(encoded)) return null
  const id = unb64(encoded)
  if (!id || b64(id) !== encoded) return null
  if (!timingSafeEqual(Buffer.from(signWithSecretsKey(STOP_PURPOSE, id)), Buffer.from(mac))) return null
  return id
}

/** The one-click stop link of an address, or null without SECRETS_KEY (then it gets no call email). */
export function outsideStopUrl(id: string, origin = WEB_ORIGIN): string | null {
  if (!hasSecretsKey()) return null
  return `${origin}${OUTSIDE_STOP_PATH}?t=${outsideStopToken(id)}`
}

/** Lets tests hand in a language model (emailRouting.get and callEmails.get say whether one is set up). */
export const previewDeps: {
  model: (tx: Tx) => Promise<EvaluationModel | null>
} = {
  model: tx => evaluationModel(tx),
}

export const emailRecipientHandlers: Record<string, Handler> = {
  'emailRouting.get': async ({ tx, actor }) => {
    // i18n-ignore: API error body for logs and API clients
    if (!actor.workspaceId) throw new Reject('no workspace', 'no_workspace')
    const ids = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, actor.workspaceId))
    const [members, model] = await Promise.all([
      membersById(
        tx,
        actor.workspaceId,
        ids.map(m => m.userId),
      ),
      previewDeps.model(tx).catch(() => null),
    ])
    const data: EmailRoutingData = {
      members: members
        .map(m => ({ userId: m.userId, name: m.name, email: m.email }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      llm: !!model,
    }
    return { rows: {}, data }
  },
}

/** Stops call emails to the address; repeating it on a stopped address changes nothing. */
export async function stopOutside(id: string, now = new Date().toISOString()) {
  await db
    .update(email_recipients)
    .set({ stopped_at: now })
    .where(and(eq(email_recipients.id, id), isNull(email_recipients.stopped_at)))
}

/** The workspace's name for the pages, email-safe. */
async function workspaceNameOf(id: string) {
  const [row] = await db
    .select({ name: organization.name })
    .from(email_recipients)
    .innerJoin(organization, eq(organization.id, email_recipients.workspace_id))
    .where(eq(email_recipients.id, id))
  return row?.name ?? null
}

export function registerEmailRecipientRoutes<E extends Env>(app: Hono<E>) {
  // Per client address: the token cannot be guessed; this only keeps the pages from being hammered.
  app.use(OUTSIDE_STOP_PATH, async (c, next) => {
    if (allowPage(addressBucket(clientIpOf(c)))) return next()
    c.header('retry-after', '60')
    return c.html(outsideBusyPage(localeForUser(null, c.req.header('accept-language'))), 429)
  })
  // The stop link in every call email to the address: a page with a button.
  app.get(OUTSIDE_STOP_PATH, async c => {
    const token = c.req.query('t')
    const id = readOutsideStopToken(token)
    const locale = localeForUser(null, c.req.header('accept-language'))
    const name = id ? await workspaceNameOf(id) : null
    if (!id || !name) return c.html(outsideStopPage('invalid', locale), 400)
    return c.html(outsideStopPage('confirm', locale, emailSafeName(name, ''), `${OUTSIDE_STOP_PATH}?t=${token}`))
  })
  // The page's button, and mail apps' one-click POST (List-Unsubscribe-Post; the body is not read).
  app.post(OUTSIDE_STOP_PATH, async c => {
    const id = readOutsideStopToken(c.req.query('t'))
    const locale = localeForUser(null, c.req.header('accept-language'))
    const name = id ? await workspaceNameOf(id) : null
    if (!id || !name) return c.html(outsideStopPage('invalid', locale), 400)
    await stopOutside(id)
    return c.html(outsideStopPage('done', locale, emailSafeName(name, '')))
  })
}
