// Passkeys of a user, from the server's shell: for the first instance admin of an install, and for
// the last admin who lost their passkey (nobody else can reset it in the admin area).
//   node apps/api/src/user-passkeys.ts --enrol --email ann@example.com
//     only prints a one-time code for the first passkey of an instance admin who has none yet (refused if they have
//     one). Nothing ends: their sessions and AI agent setup links keep working (user.issuePasskeyEnrolment).
//   node apps/api/src/user-passkeys.ts --remove --email ann@example.com
//     the recovery reset (user.resetPasskeys): removes every passkey of the account, ends all their sessions and AI
//     agent setup links, and emails them; for an instance admin, prints a one-time code for their new first passkey
// Both run a registry action as the operator, so they are in the audit log.
import { parseArgs } from 'node:util'
import type { UserIssuePasskeyEnrolmentData, UserResetPasskeysData } from '@linedesk/actions'
import { user } from '@linedesk/db'
import { sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db, pool } from './db.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { runAction } from './run-action.ts'

// The operator on the server vouches for themselves: no passkey step-up (admin-step-up.ts).
const operator: Actor = {
  actorId: 'cli',
  role: 'member',
  workspaceId: null,
  permissions: ['instance:admin'],
  passkeyConfirmed: true,
}
const USAGE = 'Usage: node apps/api/src/user-passkeys.ts (--remove | --enrol) --email <address>'

const printCode = (email: string, data: { enrolmentCode?: string; enrolmentExpiresAt?: string }) => {
  if (!data.enrolmentCode) return
  console.log(
    `Passkey enrolment code for ${email} (works once, until ${data.enrolmentExpiresAt}):\n\n  ${data.enrolmentCode}\n`,
  )
  console.log('They sign in, open Account, Sign-in & security, choose Add passkey and enter the code.')
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

async function main() {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, remove: { type: 'boolean' }, enrol: { type: 'boolean' } },
  })
  if (!values.email || values.remove === values.enrol) throw new Error(USAGE)
  const email = values.email.trim().toLowerCase()
  const [account] = await db.select().from(user).where(sql`lower(${user.email}) = ${email}`)
  if (!account) throw new Error(`No account with the address ${email}.`)
  if (values.enrol) {
    if (!isInstanceAdmin(account))
      throw new Error(`${email} is not an instance admin: they add a passkey without a code.`)
    const { body } = await runAction('user.issuePasskeyEnrolment', { userId: account.id }, operator)
    // Has a passkey already: the action says to reset instead, and what that ends.
    if (!body.ok) throw new Error(`${body.error}. Run --remove for that.`)
    printCode(email, body.data as UserIssuePasskeyEnrolmentData)
    console.log('Nothing else changed: their sessions and AI agent setup links keep working.')
    return
  }
  console.log(
    `Resetting the passkeys of ${email}: removes every passkey, signs them out everywhere and ends their AI agent setup links.`,
  )
  const { body } = await runAction('user.resetPasskeys', { userId: account.id }, operator)
  if (!body.ok) throw new Error(body.error)
  const data = body.data as UserResetPasskeysData
  console.log(
    `Removed ${plural(data.removed, 'passkey')} of ${email}, ended ${plural(data.sessionsEnded, 'session')} and ${plural(data.setupLinksEnded, 'AI agent setup link')}, and emailed them.`,
  )
  printCode(email, data)
}

main()
  .catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
