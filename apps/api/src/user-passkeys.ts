// Passkeys of a user, from the server's shell: for the first instance admin of an install, and the recovery when an
// admin lost every passkey (Server admin needs one, admin-second-factor.ts; nobody else may be left to reset it).
//   node apps/api/src/user-passkeys.ts --enrol --email ann@example.com
//     only prints a one-time code for the first passkey of an instance admin who has none yet (refused if they have
//     one). Nothing ends: their sessions and AI agent setup links keep working (user.issuePasskeyEnrolment).
//   node apps/api/src/user-passkeys.ts --remove --email ann@example.com
//     the recovery reset (user.resetPasskeys): removes every passkey of the account, ends all their sessions and AI
//     agent setup links, and emails them; for an instance admin, prints a one-time code for their new first passkey,
//     which they enter on Server admin's passkey page after signing in with any method.
// Both run a registry action as the operator, so they are in the audit log.
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { UserIssuePasskeyEnrolmentData, UserResetPasskeysData } from '@linedesk/actions'
import { user } from '@linedesk/db'
import { sql } from 'drizzle-orm'
import { enrolmentCodeLines, operator } from './admin-passkey-codes.ts'
import { db, pool } from './db.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { runAction } from './run-action.ts'

const USAGE = 'Usage: node apps/api/src/user-passkeys.ts (--remove | --enrol) --email <address>'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The command with its arguments (as on the command line); what it says goes to `log`. Throws what it refuses. */
export async function passkeysCommand(args: string[], log: (line: string) => void = console.log) {
  const { values } = parseArgs({
    args,
    options: { email: { type: 'string' }, remove: { type: 'boolean' }, enrol: { type: 'boolean' } },
  })
  if (!values.email || Boolean(values.remove) === Boolean(values.enrol)) throw new Error(USAGE)
  const email = values.email.trim().toLowerCase()
  const [account] = await db.select().from(user).where(sql`lower(${user.email}) = ${email}`)
  if (!account) throw new Error(`No account with the address ${email}.`)
  const printCode = (data: { enrolmentCode?: string; enrolmentExpiresAt?: string }) => {
    const lines = enrolmentCodeLines(email, data)
    if (lines.length) log(lines.join('\n'))
  }
  if (values.enrol) {
    if (!isInstanceAdmin(account))
      throw new Error(`${email} is not an instance admin: they add a passkey without a code.`)
    const { body } = await runAction('user.issuePasskeyEnrolment', { userId: account.id }, operator)
    // Has a passkey already: the action says to reset instead, and what that ends.
    if (!body.ok) throw new Error(`${body.error}. Run --remove for that.`)
    printCode(body.data as UserIssuePasskeyEnrolmentData)
    log('Nothing else changed: their sessions and AI agent setup links keep working.')
    return
  }
  log(
    `Resetting the passkeys of ${email}: removes every passkey, signs them out everywhere and ends their AI agent setup links.`,
  )
  const { body } = await runAction('user.resetPasskeys', { userId: account.id }, operator)
  if (!body.ok) throw new Error(body.error)
  const data = body.data as UserResetPasskeysData
  log(
    `Removed ${plural(data.removed, 'passkey')} of ${email}, ended ${plural(data.sessionsEnded, 'session')} and ${plural(data.setupLinksEnded, 'AI agent setup link')}, and emailed them.`,
  )
  printCode(data)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  passkeysCommand(process.argv.slice(2))
    .catch(e => {
      console.error(e instanceof Error ? e.message : e)
      process.exitCode = 1
    })
    .finally(() => pool.end())
