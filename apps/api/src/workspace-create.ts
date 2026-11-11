// Sets up a business by hand, for installs where nobody can click through sign-up and onboarding:
// the workspace with an existing user as owner, its assistant and settings (onboarding done), and
// optionally its phone number, attached (never bought) and routed to LiveKit SIP.
// Safe to run again: it finishes a half setup and changes nothing that is already there.
//   pnpm --filter @linedesk/api workspace:create --name "Brightwater Plumbing" --owner mike@example.com [--number +15035550142] [--time-zone America/Los_Angeles]
//   in the api container: node apps/api/src/workspace-create.ts --name … --owner …
import { parseArgs } from 'node:util'
import { rolePermissions } from '@linedesk/actions'
import { member, organization, phone_numbers, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { auth } from './auth.ts'
import type { Actor } from './context.ts'
import { db, pool } from './db.ts'
import { ensureWorkspaceRows } from './onboarding.ts'
import { runAction } from './run-action.ts'

const USAGE = 'Usage: workspace:create --name <business name> --owner <email of an existing user> [--number +1…] [--time-zone <IANA zone>]'

async function findOwner(email: string) {
  const [owner] = await db.select().from(user).where(eq(user.email, email.toLowerCase()))
  if (!owner) throw new Error(`No user ${email}. Create the account first (user:create).`)
  return owner
}

/** The owner's workspace with this name, or a new one. */
async function ensureWorkspace(name: string, ownerId: string): Promise<{ id: string; created: boolean }> {
  const [existing] = await db.select({ id: organization.id }).from(organization)
    .innerJoin(member, and(eq(member.organizationId, organization.id), eq(member.userId, ownerId), eq(member.role, 'owner')))
    .where(eq(organization.name, name))
  if (existing) return { id: existing.id, created: false }
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 6)}`
  const org = await auth.api.createOrganization({ body: { name, slug, userId: ownerId } })
  if (!org) throw new Error('Better Auth did not create the workspace')
  return { id: org.id, created: true }
}

/** Attaches the number through the registry, as the owner, like onboarding does. Never buys one. */
async function ensureNumber(e164: string, workspaceId: string, ownerId: string): Promise<string> {
  const [taken] = await db.select().from(phone_numbers).where(eq(phone_numbers.e164, e164))
  if (taken?.workspace_id === workspaceId) return `${e164} was already set up`
  if (taken) throw new Error(`${e164} belongs to another workspace`)
  const owner: Actor = { actorId: ownerId, role: 'owner', workspaceId, permissions: rolePermissions.owner }
  const { body } = await runAction('phoneNumber.setup', { e164, purchase: false }, owner)
  if (!body.ok) throw new Error(`phone setup failed: ${body.error}`)
  return `${e164} attached and routed to LiveKit SIP (${process.env.LIVEKIT_SIP_ENDPOINT ?? 'no endpoint set'})`
}

async function main() {
  const { values } = parseArgs({ options: { name: { type: 'string' }, owner: { type: 'string' }, number: { type: 'string' }, 'time-zone': { type: 'string' } } })
  const name = values.name?.trim()
  if (!name || name.length > 80 || !values.owner) throw new Error(USAGE)
  if (values.number && !/^\+[1-9]\d{6,14}$/.test(values.number)) throw new Error(`--number must be E.164, like +15035550142. ${USAGE}`)

  const owner = await findOwner(values.owner)
  const workspace = await ensureWorkspace(name, owner.id)
  await ensureWorkspaceRows(workspace.id, name, values['time-zone'], 'done')
  console.log(`${workspace.created ? 'Created' : 'Found'} workspace "${name}" (${workspace.id}), owner ${owner.email}; assistant and settings in place, onboarding done.`)
  if (values.number) console.log(await ensureNumber(values.number, workspace.id, owner.id))
  if (values.number) console.log(`Next, in the agent container: node src/setup-sip.ts ${values.number}`)
}

main()
  .catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
