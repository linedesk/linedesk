// Emails to a user about support access (docs/architecture.md §12, "Email to the user"): whether they go out, and the
// one about an API key an instance admin made while signed in as them. The one at the start is in impersonation.ts.
import { instance_settings, organization, type Tx, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { emailSender, sendNotice } from './email.ts'
import { localeForUserId } from './email-locale.ts'
import { impersonationApiKeyEmail } from './emails/templates.ts'

export const EMAILS_SETTING = 'impersonation_emails'

/** Whether users are emailed when an instance admin signs in as them. Off by default. */
export async function impersonationEmailsOn(tx: Tx): Promise<boolean> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, EMAILS_SETTING))
  return row?.value === 'on'
}

/** Email goes out over SMTP, as impersonationEmails.get reports it (`emailConnected`). */
export const emailConnected = () => emailSender.kind === 'smtp'

/** Turned on and email connected: a notice is queued (sent once the command commits). */
export const impersonationNoticesGoOut = async (tx: Tx) => (await impersonationEmailsOn(tx)) && emailConnected()

type ApiKeyNotice = { userId: string; adminId: string; workspaceId: string; keyName: string; prefix: string; role: 'member' | 'admin'; at: string }

/**
 * Queues the email to `userId` that `adminId` made an API key while signed in as them, when impersonation emails go out.
 * Returns whether it was queued. `onCommit` sends it once the command has committed.
 */
export async function queueApiKeyNotice(
  tx: Tx,
  notice: ApiKeyNotice,
  onCommit: ((work: () => Promise<void>) => void) | undefined,
): Promise<boolean> {
  if (!onCommit || !(await impersonationNoticesGoOut(tx))) return false
  const [target] = await tx.select({ email: user.email }).from(user).where(eq(user.id, notice.userId))
  if (!target) return false
  const [admin] = await tx.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, notice.adminId))
  const [ws] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, notice.workspaceId))
  const locale = await localeForUserId(tx, notice.userId)
  const email = impersonationApiKeyEmail(
    {
      admin: { name: admin?.name ?? '', email: admin?.email ?? '' },
      keyName: notice.keyName,
      prefix: notice.prefix,
      role: notice.role,
      at: notice.at,
      workspace: ws?.name ?? null,
    },
    undefined,
    locale,
  )
  onCommit(async () => sendNotice({ to: target.email, ...email }, 'impersonation API key email'))
  return true
}
