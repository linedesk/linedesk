// Creates a server admin by hand and emails them how to sign in, for installs with closed sign-up. Only server admins
// (decision of 2026-11-15, Q9): a business owner comes with their workspace (Server admin › Workspaces › New workspace, or
// workspace-create.ts --owner, which runs workspace.create as a server admin); Add user in the admin area puts people
// into a workspace.
// pnpm --filter @linedesk/api user:create --email ann@example.com --name "Ann Lee" --admin
// Runs the registry action user.invite as the operator. Without SMTP_URL, set EMAIL_TO_LOG=true
// and the email is printed here instead of sent. Without either, only --admin works: the first admin
// of an install without email gets a one-time password printed here (createAdminWithPassword).
import { parseArgs } from 'node:util'
import { emailDelivery } from './auth-methods.ts'
import type { Actor } from './context.ts'
import { pool } from './db.ts'
import { createAdminWithPassword } from './instance-admin.ts'
import { runAction } from './run-action.ts'

// The operator on the server vouches for themselves: no passkey step-up (admin-step-up.ts).
const operator: Actor = {
  actorId: 'cli',
  role: 'member',
  workspaceId: null,
  permissions: ['instance:admin'],
  passkeyConfirmed: true,
}

async function main() {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' }, admin: { type: 'boolean' } },
  })
  if (!values.email || !values.name || !values.admin)
    throw new Error(
      'Usage: user:create --email <address> --name <name> --admin\nIt makes server admins only. For a business owner: workspace:create --name <business> --owner <email> [--owner-name <name>] [--as <admin email>].',
    )
  if (emailDelivery(process.env) === 'none') return createWithoutEmail(values.email, values.name)
  const { status, body } = await runAction(
    'user.invite',
    { email: values.email, name: values.name, admin: true },
    operator,
  )
  if (!body.ok) throw new Error(body.error)
  const where = body.data?.delivery === 'log' ? 'printed above (EMAIL_TO_LOG)' : `sent to ${body.data?.email}`
  console.log(`Created ${body.data?.email} as instance admin (${status}). Welcome email ${where}.`)
  // A new instance admin adds their first passkey with this one-time code (passkey-enrolment.ts).
  if (body.data?.enrolmentCode)
    console.log(
      `Passkey enrolment code (give it to them; works once, until ${body.data.enrolmentExpiresAt}):\n\n  ${body.data.enrolmentCode}\n`,
    )
}

/** No email delivery: the admin signs in with a one-time password (instance-admin.ts). */
async function createWithoutEmail(email: string, name: string) {
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
