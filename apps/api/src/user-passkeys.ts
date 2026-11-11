// Passkeys of a user, from the server's shell: for the first instance admin of an install, and for
// the last admin who lost their passkey (nobody else can reset it in the admin area).
//   node apps/api/src/user-passkeys.ts --remove --email ann@example.com
//     removes every passkey of the account and emails them; for an instance admin, prints a
//     one-time code for their new first passkey
//   node apps/api/src/user-passkeys.ts --enrol --email ann@example.com
//     only prints that code, for an instance admin who has no passkey yet (refused if they have one)
// Both run the registry action user.resetPasskeys as the operator, so they are in the audit log.
import { parseArgs } from 'node:util'
import { passkey, user } from '@linedesk/db'
import { eq, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db, pool } from './db.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { runAction } from './run-action.ts'

// The operator on the server vouches for themselves: no passkey step-up (admin-step-up.ts).
const operator: Actor = { actorId: 'cli', role: 'member', workspaceId: null, permissions: ['instance:admin'], passkeyConfirmed: true }
const USAGE = 'Usage: node apps/api/src/user-passkeys.ts (--remove | --enrol) --email <address>'

async function main() {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, remove: { type: 'boolean' }, enrol: { type: 'boolean' } },
  })
  if (!values.email || values.remove === values.enrol) throw new Error(USAGE)
  const email = values.email.trim().toLowerCase()
  const [account] = await db.select().from(user).where(sql`lower(${user.email}) = ${email}`)
  if (!account) throw new Error(`No account with the address ${email}.`)
  if (values.enrol) {
    if (!isInstanceAdmin(account)) throw new Error(`${email} is not an instance admin: they add a passkey without a code.`)
    const [existing] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, account.id)).limit(1)
    if (existing) throw new Error(`${email} has a passkey already. To start over, use --remove.`)
  }
  const { body } = await runAction('user.resetPasskeys', { userId: account.id }, operator)
  if (!body.ok) throw new Error(body.error)
  const data = body.data as { removed: number; enrolmentCode?: string; enrolmentExpiresAt?: string }
  if (values.remove) console.log(`Removed ${data.removed} passkey(s) of ${email} and emailed them.`)
  if (data.enrolmentCode) {
    console.log(`Passkey enrolment code for ${email} (works once, until ${data.enrolmentExpiresAt}):\n\n  ${data.enrolmentCode}\n`)
    console.log('They sign in, open Account, Sign-in & security, choose Add passkey and enter the code.')
  }
}

main()
  .catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
