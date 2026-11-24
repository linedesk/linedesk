// Server admin needs a passkey (admin-second-factor.ts). An instance admin without one (an install updated from before
// that rule, or one whose passkeys were all removed) adds the first with a one-time enrolment code. Besides another
// admin and the CLI (user-passkeys.ts), the API prints one to its log at start for each such admin, like the setup
// code of a fresh install: only someone who can read the server's log gets it. Nothing is printed for an admin who has
// a code that still works (another admin's, the CLI's), so a start never replaces a code someone was given. Each code
// is issued through the registry as the server operator, so it is audited, the admin is emailed and the admins alerted.
import type { UserIssuePasskeyEnrolmentData } from '@linedesk/actions'
import { passkey, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { adminSecondFactorRequired } from './admin-second-factor.ts'
import { passkeySignInEnabled } from './auth-methods.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { enabledInstanceAdmins } from './instance-admin.ts'
import { enrolmentPending } from './passkey-enrolment.ts'
import { runAction } from './run-action.ts'

/** The server operator, as the CLI runs actions (user-passkeys.ts): no session, no passkey of their own. */
export const operator: Actor = {
  actorId: 'cli',
  role: 'member',
  workspaceId: null,
  permissions: ['instance:admin'],
  passkeyConfirmed: true,
}

/** The lines the log and the CLI print for a code: the address, the code, until when, and where to enter it. */
export function enrolmentCodeLines(email: string, data: { enrolmentCode?: string; enrolmentExpiresAt?: string }) {
  if (!data.enrolmentCode) return []
  return [
    `Passkey enrolment code for ${email} (works once, until ${data.enrolmentExpiresAt}):`,
    '',
    `  ${data.enrolmentCode}`,
    '',
    'They sign in, open Server admin (or Account, Sign-in & security), choose Add passkey and enter the code.',
  ]
}

/**
 * At start: a code for every enabled instance admin without a passkey and without a working code, printed with
 * `log`. Returns the addresses it printed one for. Off while the passkey rule is off, and while passkeys are off as a
 * sign-in method (AUTH_PASSKEY_ENABLED=false): a code could not be used then, and the start warns instead
 * (passkeysOffWarning).
 */
export async function printMissingAdminEnrolments(log: (line: string) => void = console.log): Promise<string[]> {
  if (!adminSecondFactorRequired() || !passkeySignInEnabled()) return []
  const printed: string[] = []
  for (const admin of await enabledInstanceAdmins()) {
    const [own] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, admin.id)).limit(1)
    if (own) continue
    const [account] = await db.select().from(user).where(eq(user.id, admin.id))
    if (!account || enrolmentPending(account)) continue
    const { body } = await runAction('user.issuePasskeyEnrolment', { userId: admin.id }, operator)
    if (!body.ok) continue // a passkey was added meanwhile
    log(
      [
        `Server admin needs a passkey, and ${admin.email} has none yet.`,
        ...enrolmentCodeLines(admin.email, body.data as UserIssuePasskeyEnrolmentData),
      ].join('\n'),
    )
    printed.push(admin.email)
  }
  return printed
}
