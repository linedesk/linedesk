// Creates an account by hand and emails the person how to sign in, for installs with closed sign-up.
// pnpm --filter @callfront/api user:create --email ann@example.com --name "Ann Lee" [--admin]
// Runs the registry action user.invite as the operator. Without SMTP_URL, set EMAIL_TO_LOG=true
// and the email is printed here instead of sent.
import { parseArgs } from 'node:util'
import type { Actor } from './context.ts'
import { pool } from './db.ts'
import { runAction } from './run-action.ts'

const operator: Actor = { actorId: 'cli', role: 'member', workspaceId: null, permissions: ['instance:admin'] }

async function main() {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' }, admin: { type: 'boolean' } },
  })
  if (!values.email || !values.name) throw new Error('Usage: user:create --email <address> --name <name> [--admin]')
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
}

main()
  .catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
