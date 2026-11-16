// Outside addresses for call emails (email routing, email_recipients): an owner or admin adds one, it gets a
// confirmation email, and only after it confirms does a call email ever go to it; every call email to it carries a
// one-click link to stop them (and the List-Unsubscribe headers). Also the Call emails section's read and its preview.
//
// The confirm and stop links are public routes outside the action registry, like setup-unsubscribe.ts: the person who
// clicks has no session. Both are scanner-safe: GET shows a page with a button, only POST acts, and both are limited per
// client address. The confirmation token is random and stored as its sha256 (it expires after OUTSIDE_CONFIRM_DAYS);
// the stop token is the address's id signed with a key derived from SECRETS_KEY (no expiry: an old email must still
// stop them). Tokens are never logged. The confirmation email carries the stop link too ("Don't email me again").
//
// A stop is final for the workspace: no resend, and the row (with its stopped_at) stays when the address is removed,
// so adding it again sends a confirmation only OUTSIDE_STOP_COOLDOWN_DAYS after the stop. A workspace sends at most
// OUTSIDE_CONFIRMS_PER_DAY confirmation emails in 24 hours, counted from confirm_sent_at (removed rows too).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type EmailRoutingCode,
  type EmailRoutingData,
  type EmailRoutingPreview,
  OUTSIDE_CONFIRM_DAYS,
  OUTSIDE_CONFIRMS_PER_DAY,
  OUTSIDE_RECIPIENTS_MAX,
  OUTSIDE_STOP_COOLDOWN_DAYS,
  type OutsideRecipient,
  type OutsideRecipientStatus,
  parseMentions,
} from '@linedesk/actions'
import {
  calls,
  contacts,
  email_recipients,
  member,
  organization,
  transcript_segments,
  type Tx,
  user,
} from '@linedesk/db'
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm'
import type { Env, Hono } from 'hono'
import { getT, localeForUser } from '@linedesk/i18n/server'
import { assistantIn } from './assistants.ts'
import { asMemberRoute, emailRecipients } from './call-notifications.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { invitationLocale } from './email-locale.ts'
import { decideForCall, membersById, previewLine, routingLanguage } from './email-routing.ts'
import { outsideBusyPage, outsideConfirmPage, outsideStopPage } from './emails/pages.ts'
import { emailSafeName, outsideConfirmEmail, WEB_ORIGIN } from './emails/templates.ts'
import { type EvaluationModel, evaluationModel } from './evaluations.ts'
import { type Handler, Reject } from './handler-context.ts'
import { addressBucket, clientIpOf } from './client-ip.ts'
import { createRateLimiter } from './rate-limit.ts'
import { hasSecretsKey, signWithSecretsKey } from './secrets.ts'

export const OUTSIDE_CONFIRM_PATH = '/api/email-recipients/confirm'
export const OUTSIDE_STOP_PATH = '/api/email-recipients/stop'
const STOP_PURPOSE = 'email-recipient-stop'
/** Previews per workspace and hour (each asks the model up to 5 times). */
export const PREVIEWS_PER_HOUR = 30
const PREVIEW_CALLS = 5

const allowPreview = createRateLimiter({ max: PREVIEWS_PER_HOUR, windowMs: 3_600_000 })
// Confirmation emails: per workspace, and per address (the same answer whichever workspace asks).
const allowConfirmFor = createRateLimiter({ max: 30, windowMs: 3_600_000 })
const allowConfirmTo = createRateLimiter({ max: 3, windowMs: 3_600_000 })
/** Requests to the public confirm and stop pages per client address (IPv6: its /64) and minute. */
export const OUTSIDE_PAGE_REQUESTS_PER_MINUTE = 30
const allowPage = createRateLimiter({ max: OUTSIDE_PAGE_REQUESTS_PER_MINUTE, windowMs: 60_000 })

const newRecipientId = () => `erc_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
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

/**
 * Stopped, until a confirmation sent after the stop (the address was removed and added again after the cooldown)
 * makes it waiting (or expired) for that confirmation.
 */
export function statusOf(
  row: Pick<
    typeof email_recipients.$inferSelect,
    'confirmed_at' | 'stopped_at' | 'confirm_expires_at' | 'confirm_token_hash' | 'confirm_sent_at'
  >,
  now = Date.now(),
): OutsideRecipientStatus {
  const askedAgain =
    !!row.stopped_at && !!row.confirm_token_hash && !!row.confirm_sent_at && row.confirm_sent_at > row.stopped_at
  if (row.stopped_at && !askedAgain) return 'stopped'
  // Asked again after a stop: an old confirmation does not count, only the new one.
  if (row.confirmed_at && !askedAgain) return 'confirmed'
  if (row.confirm_expires_at && Date.parse(row.confirm_expires_at) < now) return 'expired'
  return 'waiting'
}

const toOutside = (row: typeof email_recipients.$inferSelect): OutsideRecipient => ({
  id: row.id,
  email: row.email,
  label: row.label,
  status: statusOf(row),
  confirmed_at: row.confirmed_at,
  stopped_at: row.stopped_at,
  confirm_sent_at: row.confirm_sent_at,
})

/** A new confirmation link: stores the token's hash and expiry, sends the email. The token itself is not kept. */
async function sendConfirmation(
  tx: Tx,
  row: typeof email_recipients.$inferSelect,
  actorId: string,
  now: string,
): Promise<typeof email_recipients.$inferSelect> {
  if (emailSender.kind === 'none') throw refuse('no_email')
  const since = new Date(Date.parse(now) - 86_400_000).toISOString()
  const [{ sentToday }] = (await tx
    .select({ sentToday: count() })
    .from(email_recipients)
    .where(and(eq(email_recipients.workspace_id, row.workspace_id), gt(email_recipients.confirm_sent_at, since)))) as [
    { sentToday: number },
  ]
  if (sentToday >= OUTSIDE_CONFIRMS_PER_DAY) throw refuse('confirm_daily_limit')
  if (!allowConfirmFor(row.workspace_id) || !allowConfirmTo(row.email)) throw refuse('resend_limit')
  const token = randomBytes(32).toString('base64url')
  const expires = new Date(Date.parse(now) + OUTSIDE_CONFIRM_DAYS * 86_400_000).toISOString()
  const [updated] = await tx
    .update(email_recipients)
    .set({ confirm_token_hash: sha256(token), confirm_expires_at: expires, confirm_sent_at: now })
    .where(eq(email_recipients.id, row.id))
    .returning()
  const [ws] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, row.workspace_id))
  const [inviter] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actorId))
  const locale = await invitationLocale(tx, row.workspace_id, actorId)
  const { t } = getT(locale)
  const email = outsideConfirmEmail(
    {
      inviter: emailSafeName(inviter?.name, t('email.fallback.teammate')),
      workspace: emailSafeName(ws?.name, t('email.fallback.team')),
      email: row.email,
      url: `${WEB_ORIGIN}${OUTSIDE_CONFIRM_PATH}?t=${token}`,
      days: OUTSIDE_CONFIRM_DAYS,
      stopUrl: outsideStopUrl(row.id),
    },
    undefined,
    locale,
  )
  try {
    await emailSender.send({ to: row.email, ...email })
  } catch (err) {
    console.error('confirmation email to an outside address failed', err instanceof Error ? err.message : err)
    throw refuse('send_failed')
  }
  return updated!
}

/**
 * A refusal with its code: the web app shows the code's key (EMAIL_ROUTING_CODES,
 * settings.assistant.emails.error.*); the English stays in the API body for logs and API clients.
 */
// i18n-ignore: API error bodies for logs and API clients; the web app shows the key of the code
const REFUSALS: Record<EmailRoutingCode, string> = {
  no_email: 'email is not set up, so the confirmation cannot be sent',
  confirm_daily_limit: `at most ${OUTSIDE_CONFIRMS_PER_DAY} confirmation emails a day; try again tomorrow`,
  resend_limit: 'too many confirmation emails in the last hour; try again later',
  send_failed: 'could not send the confirmation email; try again in a moment',
  recipient_stopped: `this address stopped the emails; remove it and add it again, at the earliest ${OUTSIDE_STOP_COOLDOWN_DAYS} days after it stopped`,
  recipient_exists: 'this address is on the list already',
  recipient_confirmed: 'this address has confirmed already',
  recipients_full: `at most ${OUTSIDE_RECIPIENTS_MAX} outside addresses per workspace`,
  preview_limit: `at most ${PREVIEWS_PER_HOUR} previews an hour; try again later`,
  not_found: 'not found',
  no_workspace: 'no workspace',
}
const refuse = (code: EmailRoutingCode) => new Reject(REFUSALS[code], code)

/** When an address that stopped may get a confirmation email again (added again after a remove). */
const cooldownEnds = (stoppedAt: string) => Date.parse(stoppedAt) + OUTSIDE_STOP_COOLDOWN_DAYS * 86_400_000

async function recipientIn(tx: Tx, workspaceId: string, id: string) {
  const [row] = await tx
    .select()
    .from(email_recipients)
    .where(and(eq(email_recipients.id, id), eq(email_recipients.workspace_id, workspaceId)))
  if (!row) throw refuse('not_found')
  return row
}

/** Lets tests hand in a language model for the preview. */
export const previewDeps: { model: (tx: Tx) => Promise<EvaluationModel | null> } = {
  model: tx => evaluationModel(tx),
}

export const emailRecipientHandlers: Record<string, Handler> = {
  'emailRouting.get': async ({ tx, actor }) => {
    if (!actor.workspaceId) throw refuse('no_workspace')
    const ids = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, actor.workspaceId))
    const [members, rows, model] = await Promise.all([
      membersById(
        tx,
        actor.workspaceId,
        ids.map(m => m.userId),
      ),
      tx
        .select()
        .from(email_recipients)
        .where(and(eq(email_recipients.workspace_id, actor.workspaceId), isNull(email_recipients.removed_at)))
        .orderBy(asc(email_recipients.created_at)),
      previewDeps.model(tx).catch(() => null),
    ])
    const data: EmailRoutingData = {
      members: members
        .map(m => ({ userId: m.userId, name: m.name, email: m.email, emailOn: m.emailOn }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      recipients: rows.map(toOutside),
      llm: !!model,
    }
    return { rows: {}, data }
  },

  'emailRecipient.add': async ({ tx, actor, now }, input: { email: string; label?: string | null }) => {
    if (!actor.workspaceId) throw refuse('no_workspace')
    const workspaceId = actor.workspaceId
    const [existing] = await tx
      .select()
      .from(email_recipients)
      .where(and(eq(email_recipients.workspace_id, workspaceId), eq(email_recipients.email, input.email)))
    if (existing && !existing.removed_at) throw refuse('recipient_exists')
    // Removed after it stopped: its stop still counts, and it is asked again only after the cooldown.
    if (existing?.stopped_at && Date.parse(now) < cooldownEnds(existing.stopped_at)) throw refuse('recipient_stopped')
    const [{ n }] = (await tx
      .select({ n: count() })
      .from(email_recipients)
      .where(and(eq(email_recipients.workspace_id, workspaceId), isNull(email_recipients.removed_at)))) as [
      { n: number },
    ]
    if (n >= OUTSIDE_RECIPIENTS_MAX) throw refuse('recipients_full')
    // Added again after a remove: the same row, so a confirmation or a stop from before still counts. A stopped one
    // (past the cooldown) gets a new confirmation; its stop holds until it confirms.
    const [row] = existing
      ? await tx
          .update(email_recipients)
          .set({ removed_at: null, label: input.label ?? existing.label, added_by: actor.actorId })
          .where(eq(email_recipients.id, existing.id))
          .returning()
      : await tx
          .insert(email_recipients)
          .values({
            id: newRecipientId(),
            workspace_id: workspaceId,
            email: input.email,
            label: input.label || null,
            added_by: actor.actorId,
            created_at: now,
          })
          .returning()
    const sent = row!.confirmed_at && !row!.stopped_at ? row! : await sendConfirmation(tx, row!, actor.actorId, now)
    return { rows: {}, data: { recipient: toOutside(sent) } }
  },

  'emailRecipient.resend': async ({ tx, actor, now }, input: { id: string }) => {
    if (!actor.workspaceId) throw refuse('no_workspace')
    const row = await recipientIn(tx, actor.workspaceId, input.id)
    if (row.removed_at) throw refuse('not_found')
    if (row.confirmed_at && !row.stopped_at) throw refuse('recipient_confirmed')
    // The person said no: only removing and adding it again (after the cooldown) asks them again.
    if (row.stopped_at) throw refuse('recipient_stopped')
    const sent = await sendConfirmation(tx, row, actor.actorId, now)
    return { rows: {}, data: { recipient: toOutside(sent) } }
  },

  'emailRecipient.remove': async ({ tx, actor, now }, input: { id: string }) => {
    if (!actor.workspaceId) throw refuse('no_workspace')
    const row = await recipientIn(tx, actor.workspaceId, input.id)
    if (!row.removed_at)
      await tx.update(email_recipients).set({ removed_at: now }).where(eq(email_recipients.id, row.id))
    return { rows: {}, data: { id: row.id } }
  },

  'emailRecipient.restore': async ({ tx, actor }, input: { id: string }) => {
    if (!actor.workspaceId) throw refuse('no_workspace')
    const row = await recipientIn(tx, actor.workspaceId, input.id)
    const [{ n }] = (await tx
      .select({ n: count() })
      .from(email_recipients)
      .where(and(eq(email_recipients.workspace_id, actor.workspaceId), isNull(email_recipients.removed_at)))) as [
      { n: number },
    ]
    if (row.removed_at && n >= OUTSIDE_RECIPIENTS_MAX) throw refuse('recipients_full')
    const [restored] = await tx
      .update(email_recipients)
      .set({ removed_at: null })
      .where(eq(email_recipients.id, row.id))
      .returning()
    return { rows: {}, data: { recipient: toOutside(restored!) } }
  },

  'assistant.previewEmailRouting': async ({ tx, actor }, input: { assistantId: string; text: string }) => {
    if (!actor.workspaceId) throw refuse('no_workspace')
    const workspaceId = actor.workspaceId
    const assistant = await assistantIn(tx, workspaceId, input.assistantId)
    if (!assistant) throw refuse('not_found')
    const recent = await tx
      .select()
      .from(calls)
      .where(
        and(
          eq(calls.workspace_id, workspaceId),
          eq(calls.assistant_id, assistant.id),
          eq(calls.status, 'completed'),
          isNull(calls.deleted_at),
          ne(calls.source, 'test'),
          or(isNull(calls.outcome), ne(calls.outcome, 'spam')),
        ),
      )
      .orderBy(desc(calls.started_at))
      .limit(PREVIEW_CALLS)
    const preview: EmailRoutingPreview = { calls: [] }
    // A call that falls back goes to every member with call emails on: the line names them.
    const fallbackTo = recent.length ? (await emailRecipients(tx, workspaceId)).map(asMemberRoute) : []
    // Nothing to try it on, or no instruction (every member with call emails on gets every call): no request.
    if (!recent.length || !parseMentions(input.text).length || !input.text.trim()) {
      preview.calls = recent.map(c => previewLine(c, { ok: false, problem: 'nothing_fit' }, fallbackTo))
      return { rows: {}, data: preview }
    }
    if (!allowPreview(workspaceId)) throw refuse('preview_limit')
    const model = await previewDeps.model(tx).catch(() => null)
    const language = await routingLanguage(tx, workspaceId)
    const ids = recent.map(c => c.id)
    const contactIds = recent.flatMap(c => (c.contact_id ? [c.contact_id] : []))
    const [segments, people] = await Promise.all([
      tx
        .select({
          call_id: transcript_segments.call_id,
          speaker: transcript_segments.speaker,
          text: transcript_segments.text,
        })
        .from(transcript_segments)
        .where(
          and(
            inArray(transcript_segments.call_id, ids),
            inArray(transcript_segments.speaker, ['caller', 'agent']),
            isNull(transcript_segments.tool_event),
          ),
        )
        .orderBy(asc(transcript_segments.at_ms), asc(transcript_segments.id)),
      contactIds.length
        ? tx.select({ id: contacts.id, name: contacts.name }).from(contacts).where(inArray(contacts.id, contactIds))
        : Promise.resolve([] as { id: string; name: string | null }[]),
    ])
    preview.calls = await Promise.all(
      recent.map(async c => {
        const { decision } = await decideForCall(
          tx,
          workspaceId,
          input.text,
          {
            title: c.title,
            urgent: c.urgency === 'urgent',
            caller: people.find(p => p.id === c.contact_id)?.name ?? c.from_number,
            summary: c.summary,
            fields: c.fields,
            assistantName: assistant.name,
            transcript: segments.filter(s => s.call_id === c.id),
          },
          model,
          { preview: true, budget: false, language },
        )
        return previewLine(c, decision, fallbackTo)
      }),
    )
    return { rows: {}, data: preview }
  },
}

/** Confirms the address the token is for; false when the token is unknown or expired. */
export async function confirmOutside(token: string, now = new Date().toISOString()): Promise<boolean> {
  const [row] = await db
    .select()
    .from(email_recipients)
    .where(eq(email_recipients.confirm_token_hash, sha256(token)))
  if (!row || !row.confirm_expires_at || Date.parse(row.confirm_expires_at) < Date.parse(now)) return false
  await db
    .update(email_recipients)
    .set({ confirmed_at: now, stopped_at: null, confirm_token_hash: null, confirm_expires_at: null })
    .where(eq(email_recipients.id, row.id))
  return true
}

/**
 * Stops call emails to the address, and ends a confirmation link still open (so it cannot undo the stop); the cooldown
 * counts from now. Repeating it on a stopped address with no open link changes nothing.
 */
export async function stopOutside(id: string, now = new Date().toISOString()) {
  await db
    .update(email_recipients)
    .set({ stopped_at: now, confirm_token_hash: null, confirm_expires_at: null })
    .where(
      and(
        eq(email_recipients.id, id),
        or(isNull(email_recipients.stopped_at), isNotNull(email_recipients.confirm_token_hash)),
      ),
    )
}

/** The workspace's name for the pages, email-safe. */
async function workspaceNameOf(where: { token?: string; id?: string }) {
  const [row] = await db
    .select({ name: organization.name })
    .from(email_recipients)
    .innerJoin(organization, eq(organization.id, email_recipients.workspace_id))
    .where(
      where.id ? eq(email_recipients.id, where.id) : eq(email_recipients.confirm_token_hash, sha256(where.token ?? '')),
    )
  return row?.name ?? null
}

const validConfirmToken = (token: string | undefined): token is string => !!token && /^[\w-]{20,100}$/.test(token)

export function registerEmailRecipientRoutes<E extends Env>(app: Hono<E>) {
  // Per client address: the tokens cannot be guessed; this only keeps the pages from being hammered.
  for (const path of [OUTSIDE_CONFIRM_PATH, OUTSIDE_STOP_PATH])
    app.use(path, async (c, next) => {
      if (allowPage(addressBucket(clientIpOf(c)))) return next()
      c.header('retry-after', '60')
      return c.html(outsideBusyPage(localeForUser(null, c.req.header('accept-language'))), 429)
    })
  // The confirmation link: a page with a button, so a link scanner that opens it confirms nothing.
  app.get(OUTSIDE_CONFIRM_PATH, async c => {
    const token = c.req.query('t')
    const locale = localeForUser(null, c.req.header('accept-language'))
    const name = validConfirmToken(token) ? await workspaceNameOf({ token }) : null
    if (!name) return c.html(outsideConfirmPage('invalid', locale), 400)
    return c.html(outsideConfirmPage('confirm', locale, emailSafeName(name, ''), `${OUTSIDE_CONFIRM_PATH}?t=${token}`))
  })
  app.post(OUTSIDE_CONFIRM_PATH, async c => {
    const token = c.req.query('t')
    const locale = localeForUser(null, c.req.header('accept-language'))
    const name = validConfirmToken(token) ? await workspaceNameOf({ token }) : null
    if (!name || !(await confirmOutside(token!))) return c.html(outsideConfirmPage('invalid', locale), 400)
    return c.html(outsideConfirmPage('done', locale, emailSafeName(name, '')))
  })
  // The stop link in every call email to the address: a page with a button.
  app.get(OUTSIDE_STOP_PATH, async c => {
    const token = c.req.query('t')
    const id = readOutsideStopToken(token)
    const locale = localeForUser(null, c.req.header('accept-language'))
    const name = id ? await workspaceNameOf({ id }) : null
    if (!id || !name) return c.html(outsideStopPage('invalid', locale), 400)
    return c.html(outsideStopPage('confirm', locale, emailSafeName(name, ''), `${OUTSIDE_STOP_PATH}?t=${token}`))
  })
  // The page's button, and mail apps' one-click POST (List-Unsubscribe-Post; the body is not read).
  app.post(OUTSIDE_STOP_PATH, async c => {
    const id = readOutsideStopToken(c.req.query('t'))
    const locale = localeForUser(null, c.req.header('accept-language'))
    const name = id ? await workspaceNameOf({ id }) : null
    if (!id || !name) return c.html(outsideStopPage('invalid', locale), 400)
    await stopOutside(id)
    return c.html(outsideStopPage('done', locale, emailSafeName(name, '')))
  })
}
