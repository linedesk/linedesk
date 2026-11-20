// feedback.send (packages/actions/src/feedback.ts, LIN-639): a bug report, a feature request or setup feedback to the
// Linedesk team. The text, page and context are masked with scrubText (keys and tokens, phone numbers, email
// addresses) before anything is stored or sent; only `contact_email` stays, as the address to answer at. The report is
// a `feedback` row; after the commit it is emailed to FEEDBACK_EMAIL (default support@linedesk.ai) in the background,
// with the screenshot attached, and the row says how that went: sent, failed (with the masked error), or kept when
// FEEDBACK_EMAIL is `off` or the install cannot send email. The screenshot is never stored (no file store for it): it
// goes with the email only, so a kept report has none. At most FEEDBACK_PER_HOUR an hour and one per
// FEEDBACK_MIN_GAP_SECONDS per sender (a person, or a workspace API key), counted in the table under a per-sender lock.
//
// A setup report (`kind: setup` with `setup`, LIN-210) comes only from an install setup link's agent, only with the
// admin's yes (`user_consented: true`; the setup MCP showed the preview before), and goes to SETUP_FEEDBACK_URL after
// the commit instead of the email: setup-feedback.ts builds, redacts and sends it. feedback.resend sends a kept one again.
import {
  FEEDBACK_MIN_GAP_SECONDS,
  FEEDBACK_PER_HOUR,
  FEEDBACK_RATE_LIMITED,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  type FeedbackKind,
  type SetupReportRow,
  type SetupReportsData,
} from '@linedesk/actions'
import { api_keys, feedback, organization, personal_keys, type Tx } from '@linedesk/db'
import { scrubPath, scrubText } from '@linedesk/scrub'
import { and, desc, eq, gt, isNotNull, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { type EmailAttachment, type EmailSender, emailSender } from './email.ts'
import { emailOrigin } from './email-brand.ts'
import { feedbackEmail, type FeedbackReport } from './emails/feedback.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import {
  agentClientOf,
  CLAIM_GAP_MS,
  buildSetupReport,
  checkPreviewTokenUnused,
  checkSetupReportRate,
  lockSetupLink,
  deliverSetupReport,
  previewTokenHash,
  previewTokenMatches,
  readSetupFeedbackUrl,
  SENDING_OFF,
  type SetupReportInput,
  serverVersion,
} from './setup-feedback.ts'

export const DEFAULT_FEEDBACK_EMAIL = 'support@linedesk.ai'

/**
 * Where feedback goes: FEEDBACK_EMAIL, the default when it is empty, null when it is `off` (reports are only kept).
 * A value that is no email address stops the server at start (as SUPPORT_EMAIL does, auth-methods.ts).
 */
export function feedbackRecipient(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.FEEDBACK_EMAIL?.trim()
  if (!value) return DEFAULT_FEEDBACK_EMAIL
  if (value.toLowerCase() === 'off') return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new Error(`FEEDBACK_EMAIL ${value} is not an email address or off`)
  return value
}
feedbackRecipient()

type Via = (typeof feedback.$inferInsert)['via']

/** How the sender reached the API, and the name of the key or MCP client they used (null from the app). */
async function senderOf(tx: Tx, actor: Actor): Promise<{ via: Via; client: string | null }> {
  if (actor.apiKeyId) {
    const [key] = await tx.select({ name: api_keys.name }).from(api_keys).where(eq(api_keys.id, actor.apiKeyId))
    return { via: 'api_key', client: key?.name ?? null }
  }
  if (actor.personalKeyId) {
    const [key] = await tx
      .select({ name: personal_keys.name })
      .from(personal_keys)
      .where(eq(personal_keys.id, actor.personalKeyId))
    return { via: actor.oauthKey ? 'mcp_oauth' : 'personal_key', client: key?.name ?? null }
  }
  if (actor.setupKeyId) return { via: 'setup_link', client: null }
  return { via: 'app', client: null }
}

/** A text as it may be stored and sent: keys and tokens, phone numbers and email addresses replaced. */
const masked = (text: string) => scrubText(text)
/** A page: its path without query or fragment, secret-looking segments replaced, then masked like text. */
const maskedPage = (page: string) => scrubText(scrubPath(page))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Buffer.from([0xff, 0xd8, 0xff])

/** The screenshot's bytes, checked to be what its data URL says (the input schema checked its shape and size). */
function screenshotOf(dataUrl: string): EmailAttachment {
  const png = dataUrl.startsWith('data:image/png;')
  const content = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  const signature = png ? PNG : JPEG
  if (content.length > FEEDBACK_SCREENSHOT_MAX_BYTES || !content.subarray(0, signature.length).equals(signature))
    throw Reject.t('server.input.screenshotFormat')
  return { filename: png ? 'screenshot.png' : 'screenshot.jpg', content, contentType: png ? 'image/png' : 'image/jpeg' }
}

/** Refuses a sender's report past the limits; holds a per-sender lock until the transaction ends, so two at once count. */
async function checkRate(tx: Tx, actorId: string, now: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`feedback:${actorId}`}))`)
  const hourAgo = new Date(Date.parse(now) - 60 * 60 * 1000).toISOString()
  const [recent] = await tx
    .select({ count: sql<number>`count(*)::int`, last: sql<string | null>`max(${feedback.created_at})` })
    .from(feedback)
    .where(and(eq(feedback.actor_id, actorId), gt(feedback.created_at, hourAgo)))
  if ((recent?.count ?? 0) >= FEEDBACK_PER_HOUR)
    throw Reject.t('server.api.feedback.tooMany', { count: FEEDBACK_PER_HOUR }, FEEDBACK_RATE_LIMITED)
  const last = recent?.last ? Date.parse(recent.last) : null
  if (last !== null && Date.parse(now) - last < FEEDBACK_MIN_GAP_SECONDS * 1000)
    throw Reject.t('server.api.feedback.tooSoon', { seconds: FEEDBACK_MIN_GAP_SECONDS }, FEEDBACK_RATE_LIMITED)
}

/**
 * Emails a committed report and records how it went. `none` (no email set up) and `log` (EMAIL_TO_LOG, development:
 * printed, not sent) keep it; a failure is stored masked and logged, never shown to the sender (the report is kept).
 */
export async function deliverFeedback(
  report: FeedbackReport,
  to: string,
  screenshot: EmailAttachment | null,
  sender: EmailSender = emailSender,
) {
  const kind = sender.kind
  if (kind === 'none') return setStatus(report.id, { status: 'kept' })
  const email = feedbackEmail(report)
  try {
    await sender.send({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      ...(report.contactEmail ? { replyTo: report.contactEmail } : {}),
      ...(screenshot ? { attachments: [screenshot] } : {}),
    })
    await setStatus(
      report.id,
      kind === 'log' ? { status: 'kept' } : { status: 'sent', sent_at: new Date().toISOString() },
    )
  } catch (e) {
    const error = masked(e instanceof Error ? e.message : String(e)).slice(0, 500)
    console.error(`feedback ${report.id}: the email failed: ${error}`)
    await setStatus(report.id, { status: 'failed', last_error: error })
  }
}

const setStatus = (id: string, set: Partial<typeof feedback.$inferInsert>) =>
  db.update(feedback).set(set).where(eq(feedback.id, id))

const newId = () => `fb_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

type FeedbackInput = SetupReportInput & {
  kind: FeedbackKind
  text: string
  page?: string
  context?: { version?: string; browser?: string; errors?: string }
  screenshot?: string
  contact_email?: string
}

/** The list and Send again are a person's in Server admin, never an AI agent's setup link (which holds instance:admin). */
function refuseSetupLink(actor: Actor) {
  if (actor.setupKeyId) throw Forbidden.t('server.api.feedback.notOnSetupLink')
}

/** An install setup link (not a workspace's or a partner's): the one sender of setup reports. */
const installSetupLink = (actor: Actor) => Boolean(actor.setupKeyId && !actor.setupWorkspaceId && !actor.setupPartnerId)

/**
 * A setup report with the admin's yes: stored with its redacted `report` (no workspace: an install link acts in none)
 * and sent to SETUP_FEEDBACK_URL right after the commit; runAction waits for that (5 s at most), so the setup MCP can
 * say at once whether it went out.
 */
const sendSetupReport: Handler = async ({ tx, actor, now, onCommit }, input: FeedbackInput) => {
  if (!installSetupLink(actor)) throw Reject.t('server.api.feedback.setupLinkOnly')
  if (input.kind !== 'setup' || !input.setup) throw Reject.t('server.api.feedback.setupNeedsReport')
  if (input.user_consented !== true) throw Reject.t('server.api.feedback.setupNeedsConsent')
  if (input.screenshot || input.page || input.context) throw Reject.t('server.api.feedback.setupTextOnly')
  // A preview_token works once per link; refused before the rate limits, so the agent hears why (nothing is counted).
  await lockSetupLink(tx, actor.setupKeyId!)
  await checkPreviewTokenUnused(tx, actor.setupKeyId!, input.preview_token)
  await checkRate(tx, actor.actorId, now)
  await checkSetupReportRate(tx, actor.setupKeyId!, now)
  const report = await buildSetupReport(tx, actor, input, { now })
  // The yes is to the preview the admin saw (security review F7): built again here, it must be that exact report.
  if (!previewTokenMatches(input.preview_token, actor.setupKeyId!, report, Date.parse(now)))
    throw Reject.t('server.api.feedback.setupPreviewMismatch')
  const off = readSetupFeedbackUrl() === null
  const row = {
    id: newId(),
    workspace_id: null,
    actor_id: actor.actorId,
    via: 'setup_link' as const,
    client: report.agent.client,
    kind: 'setup' as const,
    text: report.summary ?? '',
    contact_email: report.contact?.email ?? null,
    status: off ? ('kept' as const) : ('pending' as const),
    last_error: off ? SENDING_OFF : null,
    setup_key_id: actor.setupKeyId!,
    report,
    preview_token_hash: previewTokenHash(input.preview_token!),
    created_at: now,
  }
  await tx.insert(feedback).values(row)
  if (!off)
    onCommit?.(async () => {
      await deliverSetupReport(row.id)
    })
  return { rows: {}, data: { id: row.id } }
}

export const feedbackHandlers: Record<string, Handler> = {
  'feedback.send': async (ctx, input: FeedbackInput) => {
    const { tx, actor, now, onCommit } = ctx
    if (input.setup || input.user_consented !== undefined || actor.setupKeyId) return sendSetupReport(ctx, input)
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const screenshot = input.screenshot ? screenshotOf(input.screenshot) : null
    await checkRate(tx, actor.actorId, now)
    const [workspace] = await tx
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, actor.workspaceId))
    const { via, client } = await senderOf(tx, actor)
    const context = input.context
      ? Object.fromEntries(
          Object.entries(input.context)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
            .map(([key, value]) => [key, masked(value)]),
        )
      : null
    const to = feedbackRecipient()
    const row = {
      id: newId(),
      workspace_id: actor.workspaceId,
      actor_id: actor.actorId,
      via,
      client: client === null ? null : masked(client),
      kind: input.kind,
      text: masked(input.text),
      page: input.page ? maskedPage(input.page) : null,
      context: context && Object.keys(context).length ? context : null,
      has_screenshot: screenshot !== null,
      contact_email: input.contact_email ?? null,
      status: to ? ('pending' as const) : ('kept' as const),
      created_at: now,
    }
    await tx.insert(feedback).values(row)
    if (to) {
      const report: FeedbackReport = {
        id: row.id,
        kind: row.kind,
        text: row.text,
        page: row.page,
        context: row.context,
        hasScreenshot: row.has_screenshot,
        contactEmail: row.contact_email,
        workspace: { id: actor.workspaceId, name: workspace?.name ?? null },
        sender: { actorId: row.actor_id, via, client: row.client },
        origin: emailOrigin(),
        serverVersion: serverVersion() === 'unknown' ? null : serverVersion(),
      }
      // In the background: the sender gets their answer at once, whatever the mail server does.
      onCommit?.(async () => {
        void deliverFeedback(report, to, screenshot).catch(e => console.error(`feedback ${row.id}: not delivered`, e))
      })
    }
    return { rows: {}, data: { id: row.id } }
  },

  // Server admin › System › Setup reports: the latest 50, newest first; outcome and items from the stored report.
  'feedback.setupReports': async ({ tx, actor }) => {
    refuseSetupLink(actor)
    const rows = await tx
      .select()
      .from(feedback)
      .where(isNotNull(feedback.report))
      .orderBy(desc(feedback.created_at))
      .limit(50)
    const reports: SetupReportRow[] = rows.map(row => {
      const report = row.report as { outcome?: unknown; items?: unknown[] }
      return {
        id: row.id,
        createdAt: row.created_at,
        outcome: typeof report.outcome === 'string' ? report.outcome : 'in_progress',
        items: Array.isArray(report.items) ? report.items.length : 0,
        agent: agentClientOf(row.client),
        status: row.status,
        reason:
          row.status === 'sent'
            ? null
            : row.status === 'refused'
              ? 'refused'
              : row.last_error === SENDING_OFF
                ? 'off'
                : row.last_error
                  ? 'unreachable'
                  : null,
        detail: row.status === 'sent' ? null : row.last_error,
        tries: row.tries,
        sentAt: row.sent_at,
      }
    })
    const data: SetupReportsData = { reports, sendingOff: readSetupFeedbackUrl() === null }
    return { rows: {}, data }
  },

  // An instance admin sends a kept setup report again (Server admin › System › Setup reports). It does not count
  // against the link's limit; the answer is the row as it is after the try.
  'feedback.resend': async ({ tx, actor, onCommit }, input: { id: string }) => {
    refuseSetupLink(actor)
    const [row] = await tx
      .select({ id: feedback.id, status: feedback.status, report: feedback.report, tried_at: feedback.tried_at })
      .from(feedback)
      .where(eq(feedback.id, input.id))
    if (!row?.report) throw Reject.t('server.api.feedback.notASetupReport')
    if (row.status === 'sent') throw Reject.t('server.api.feedback.alreadySent')
    if (row.status === 'refused') throw Reject.t('server.api.feedback.refusedNoResend')
    if (readSetupFeedbackUrl() === null) throw Reject.t('server.api.feedback.sendingOff')
    if (row.tried_at && Date.now() - Date.parse(row.tried_at) < CLAIM_GAP_MS)
      throw Reject.t('server.api.feedback.justTried')
    onCommit?.(async () => {
      await deliverSetupReport(row.id)
    })
    return { rows: {}, data: { id: row.id } }
  },
}
