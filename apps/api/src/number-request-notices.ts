// Who hears about a number request once the carrier decided (docs/numbers-kyc.md): the person who asked for it and the
// workspace's owners when the number is live (`active`) or was not approved (`rejected`); every instance admin when an
// approved number could not be set up (`needs_operator`), as with every other ALERT the operator acts on.
//
// notifyNumberRequestChange is called in the transaction that changed the request's status (number-requests.ts) and
// queues one job there, so the email goes only once that commits, never for a change that rolled back. The job reads
// the request again: a request that moved on meanwhile (parked, then set up after all) gets the email of where it is
// now from its own change, not a stale one.
import type { KycCountry, NumberRequestStatus } from '@linedesk/actions'
import { member, number_requests, organization, type Tx, user } from '@linedesk/db'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { fromDrizzle, type PgBoss } from 'pg-boss'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { db } from './db.ts'
import type { EmailSender } from './email.ts'
import { localeForEmail } from './email-locale.ts'
import { numberRequestEmail, numberRequestNeedsOperatorAlert } from './emails/number-requests.ts'
import { emailSafeName } from './emails/templates.ts'
import { jobQueue } from './jobs.ts'
import { withWorkspaceBrand } from './partner-brand.ts'

export const NUMBER_REQUEST_NOTICE = 'numberRequest.notice'

type NoticeStatus = NumberRequestStatus
export type NoticeKind = 'active' | 'rejected' | 'needs_operator'
export type NumberRequestNoticeJob = { requestId: string; kind: NoticeKind }

/** The notice a change of status calls for, or null: only on reaching active, rejected or needs_operator. */
export function noticeFor(status: NoticeStatus, previous: NoticeStatus | null | undefined): NoticeKind | null {
  if (status === previous) return null
  return status === 'active' || status === 'rejected' || status === 'needs_operator' ? status : null
}

/**
 * Queues the email about a request whose status just changed from `previousStatus`, in the caller's transaction:
 * it goes out only if that commits. Nothing for a change no one needs to hear about (pending_review, cancelled by the
 * owner), nor without a queue (tests).
 */
export async function notifyNumberRequestChange(
  tx: Tx,
  request: { id: string; status: NoticeStatus },
  previousStatus: NoticeStatus | null | undefined,
) {
  const kind = noticeFor(request.status, previousStatus)
  if (!kind) return
  const job: NumberRequestNoticeJob = { requestId: request.id, kind }
  await jobQueue()?.send(NUMBER_REQUEST_NOTICE, job, { db: fromDrizzle(tx, sql) })
}

export type NoticeResult = { sent: number; failed: number; skipped?: 'gone' | 'moved_on' | 'nobody' }

/**
 * Sends one notice (the job). `active` and `rejected`: to who asked for the number and the workspace's owners (enabled
 * accounts that are still members), each in their own language, in the workspace's brand. `needs_operator`: to every
 * instance admin, in the install's brand. Throws when nothing could go out, so the job tries again.
 */
export async function sendNumberRequestNotice(
  tx: Tx | typeof db,
  sender: EmailSender,
  { requestId, kind }: NumberRequestNoticeJob,
): Promise<NoticeResult> {
  const [request] = await tx.select().from(number_requests).where(eq(number_requests.id, requestId))
  if (!request) return { sent: 0, failed: 0, skipped: 'gone' }
  if (request.status !== kind) return { sent: 0, failed: 0, skipped: 'moved_on' }
  const [workspace] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, request.workspace_id))
  if (!workspace) return { sent: 0, failed: 0, skipped: 'gone' }

  if (kind === 'needs_operator') {
    await alertInstanceAdmins(
      numberRequestNeedsOperatorAlert({
        requestId: request.id,
        workspace: `${emailSafeName(workspace.name, request.workspace_id)} (${request.workspace_id})`,
        e164: request.e164,
        reason: request.reason,
        carrierAccount: request.carrier_account,
      }),
      sender,
      { wait: true },
    )
    return { sent: 1, failed: 0 }
  }

  const people = await tx
    .select({ email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, request.workspace_id),
        or(eq(member.role, 'owner'), eq(member.userId, request.requested_by)),
        isNull(user.disabledAt),
      ),
    )
  const addresses = [...new Set(people.map(p => p.email.toLowerCase()))]
  if (!addresses.length) return { sent: 0, failed: 0, skipped: 'nobody' }
  const content = {
    kind,
    country: request.country as KycCountry,
    city: request.city,
    prefix: request.prefix,
    e164: request.e164,
    reason: request.reason,
  }
  return withWorkspaceBrand(
    request.workspace_id,
    async () => {
      let sent = 0
      let failed = 0
      for (const to of addresses) {
        try {
          const locale = await localeForEmail(tx, to)
          await sender.send({ to, ...numberRequestEmail(content, request.workspace_id, undefined, locale) })
          sent++
        } catch (e) {
          failed++
          console.warn(
            `number request email (${kind}) for ${request.id} failed: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      if (failed && !sent) throw new Error(`no number request email could be sent (${failed} failed)`)
      return { sent, failed }
    },
    tx,
  )
}

/** The queue of this file (jobs.ts `startJobs`). */
export async function createNumberRequestNoticeQueue(instance: PgBoss) {
  await instance.createQueue(NUMBER_REQUEST_NOTICE, { retryLimit: 4, retryDelay: 60, retryBackoff: true })
}

/** The worker of this file (jobs.ts `runJobs`). */
export async function runNumberRequestNoticeJobs(instance: PgBoss, sender: EmailSender) {
  await instance.work<NumberRequestNoticeJob>(NUMBER_REQUEST_NOTICE, async ([job]) =>
    sendNumberRequestNotice(db, sender, job!.data),
  )
}
