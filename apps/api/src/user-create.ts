// Creates an account by hand and emails the person how to sign in, for installs with closed sign-up.
// pnpm --filter @linedesk/api user:create --email ann@example.com --name "Ann Lee" [--admin]
// Runs the registry action user.invite as the operator. Without SMTP_URL, set EMAIL_TO_LOG=true
// and the email is printed here instead of sent. Without either, only --admin works: the first admin
// of an install without email gets a one-time password printed here (createAdminWithPassword).
import { parseArgs } from 'node:util'
import { emailDelivery } from './auth-methods.ts'
import type { Actor } from './context.ts'
import { pool } from './db.ts'
import { createAdminWithPassword } from './instance-admin.ts'
import { runAction } from './run-action.ts'

const operator: Actor = { actorId: 'cli', role: 'member', workspaceId: null, permissions: ['instance:admin'] }

async function main() {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' }, admin: { type: 'boolean' } },
  })
  if (!values.email || !values.name) throw new Error('Usage: user:create --email <address> --name <name> [--admin]')
  if (emailDelivery(process.env) === 'none') return createWithoutEmail(values.email, values.name, values.admin ?? false)
  const { status, body } = await runAction(
    'user.invite',
    { email: values.email, name: values.name, admin: values.admin ?? false },
    operator,
  )
  if (!body.ok) throw new Error(body.error)
  const where = body.data?.delivery === 'log' ? 'printed above (EMAIL_TO_LOG)' : `sent to ${body.data?.email}`
  console.log(
    `Created ${body.data?.email}${values.admin ? ' as instance admin' : ''} (${status}). Welcome email ${where}.`,
  )
  // A new instance admin adds their first passkey with this one-time code (passkey-enrolment.ts).
  if (body.data?.enrolmentCode)
    console.log(
      `Passkey enrolment code (give it to them; works once, until ${body.data.enrolmentExpiresAt}):\n\n  ${body.data.enrolmentCode}\n`,
    )
}

/** No email delivery: only the first admin, who signs in with a one-time password (instance-admin.ts). */
async function createWithoutEmail(email: string, name: string, admin: boolean) {
  if (!admin)
    throw new Error(
      'Email is not set up (SMTP_URL), so a new user could not get sign-in codes. Set it up first; only --admin works without it.',
    )
  if (process.env.AUTH_PASSWORD_ENABLED === 'false')
    throw new Error(
      'Email is not set up and password sign-in is off (AUTH_PASSWORD_ENABLED=false): set up SMTP_URL first.',
    )
  const created = await createAdminWithPassword({ email, name })
  console.log(`Created ${created.email} as instance admin. Email is not set up, so nothing was sent.\n`)
  console.log(
    `One-time password (sign in with it at ${process.env.PUBLIC_URL ?? 'your Linedesk address'}, then change it under Account):\n\n  ${created.password}\n`,
  )
  console.log(
    `Passkey enrolment code (works once, until ${created.enrolmentExpiresAt}):\n\n  ${created.enrolmentCode}\n`,
  )
}

main()
  .catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
