// Provisions a business from the server, for installs where nobody clicks through Server admin: the workspace with its
// owner, assistant and settings (onboarding done), and optionally its phone number, attached (never bought) and routed
// to LiveKit SIP.
// The workspace is made by the registry action workspace.create, run as a named server admin (--as), exactly like
// Server admin › Workspaces › New workspace: the same audit entry, rights and owner rules (decision of 2026-11-15, Q9). An
// existing account with a confirmed address becomes the owner at once; a new address (an account is made for it: give
// --owner-name) or an unconfirmed one gets the owner invitation by email from that admin and becomes the owner once it
// confirms the address. So email delivery must be set up unless the owner's account is already confirmed.
// --as names the server admin, since an invitation names the person who sent it. It may be left out only while the
// install has exactly one enabled server admin (it is then that one, and the output says so); with none or several it
// stops, so a script never invites in the name of an admin nobody chose. The number is attached as the same admin, so
// one run has one actor in the audit log. (The command log has no field for where a command came from, so the entries
// look like the admin's own; a `via` marker is in the backlog.)
// Safe to run again: a workspace with this name whose owner is, or is invited as, --owner is reused, and only the
// missing steps run. A disabled one stops the command, as Server admin refuses to change it.
//   pnpm --filter @linedesk/api workspace:create --name "Brightwater Plumbing" --owner mike@example.com [--owner-name "Mike Shaw"] [--as admin@example.com] [--number +15035550142] [--time-zone America/Los_Angeles]
//   in the api container: node apps/api/src/workspace-create.ts --name … --owner … [--as …]
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { rolePermissions, type WorkspaceCreateData } from '@linedesk/actions'
import { invitation, member, organization, phone_numbers, user } from '@linedesk/db'
import { and, eq, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db, pool } from './db.ts'
import { enabledInstanceAdmins, isInstanceAdmin } from './instance-admin.ts'
import { ensureWorkspaceRows } from './onboarding.ts'
import { runAction } from './run-action.ts'

const USAGE =
  'Usage: workspace:create --name <business name> --owner <email> [--owner-name <name, for a new account>] [--as <server admin email>] [--number +1…] [--time-zone <IANA zone>]'

/**
 * The server admin the command runs as: the one named with --as, which must be an enabled server admin; without --as
 * the install's only enabled server admin. None or several without --as: an error that says what to do.
 */
export function pickAdmin(as: string | undefined, admins: readonly { id: string; email: string }[]) {
  if (as) {
    const named = admins.find(a => a.email.toLowerCase() === as.trim().toLowerCase())
    if (!named) throw new Error(`${as} is not an enabled server admin of this install. Name one with --as.`)
    return { ...named, chosen: 'named' as const }
  }
  if (admins.length === 1) return { ...admins[0]!, chosen: 'only' as const }
  if (!admins.length)
    throw new Error(
      'This install has no server admin. Make one first: user:create --email <address> --name <name> --admin',
    )
  throw new Error(`This install has ${admins.length} server admins: name the one this runs as with --as <email>.`)
}

/** The actor of a server admin on the server: the operator vouches for them, so no passkey step (admin-second-factor.ts). */
export const adminOnServer = (adminId: string): Actor => ({
  actorId: adminId,
  role: 'member',
  workspaceId: null,
  permissions: ['instance:admin'],
  passkeyConfirmed: true,
})

/** A workspace with this name whose owner is this address, or that has a pending owner invitation for it. */
async function existingWorkspace(name: string, email: string): Promise<{ id: string; disabled: boolean } | null> {
  const columns = { id: organization.id, disabledAt: organization.disabledAt }
  const [owned] = await db
    .select(columns)
    .from(organization)
    .innerJoin(member, and(eq(member.organizationId, organization.id), eq(member.role, 'owner')))
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(organization.name, name), sql`lower(${user.email}) = ${email}`))
  const found = (row: { id: string; disabledAt: Date | null }) => ({ id: row.id, disabled: row.disabledAt !== null })
  if (owned) return found(owned)
  const [invited] = await db
    .select(columns)
    .from(organization)
    .innerJoin(
      invitation,
      and(
        eq(invitation.organizationId, organization.id),
        eq(invitation.role, 'owner'),
        eq(invitation.status, 'pending'),
        sql`lower(${invitation.email}) = ${email}`,
      ),
    )
    .where(eq(organization.name, name))
  return invited ? found(invited) : null
}

export type ProvisionInput = {
  name: string
  owner: string
  ownerName?: string
  as?: string
  number?: string
  timeZone?: string
}

/** What the command does, without the argument parsing; returns the lines it prints. */
export async function provisionWorkspace(input: ProvisionInput): Promise<string[]> {
  return (await provision(input)).lines
}

/** provisionWorkspace with the workspace and the server admin it ran as, for scripts that go on from there (demo-workspace.ts). */
export async function provision(
  input: ProvisionInput,
): Promise<{ lines: string[]; workspaceId: string; adminId: string }> {
  const out: string[] = []
  const name = input.name.trim()
  const email = input.owner.trim().toLowerCase()
  const admin = pickAdmin(input.as, await enabledInstanceAdmins())
  // Checked again from the account row: enabled and still a server admin.
  const [account] = await db.select().from(user).where(eq(user.id, admin.id))
  if (!account || account.disabledAt || !isInstanceAdmin(account))
    throw new Error(`${admin.email} is not an enabled server admin of this install.`)
  if (admin.chosen === 'only') out.push(`Running as ${admin.email}, the only server admin of this install.`)

  const existing = await existingWorkspace(name, email)
  if (existing?.disabled)
    throw new Error(`Workspace "${name}" (${existing.id}) is disabled: enable it in Server admin first.`)
  let workspaceId = existing?.id
  if (workspaceId) out.push(`Found workspace "${name}" (${workspaceId}) for ${email}.`)
  else {
    const made = await runAction(
      'workspace.create',
      {
        name,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        owner: { email, ...(input.ownerName ? { name: input.ownerName } : {}) },
      },
      adminOnServer(admin.id),
    )
    if (!made.body.ok) throw new Error(made.body.error)
    const data = made.body.data as WorkspaceCreateData
    workspaceId = data.workspace.id
    out.push(
      data.owner.joined === 'added'
        ? `Created workspace "${name}" (${workspaceId}) as ${admin.email}; ${email} is its owner.`
        : `Created workspace "${name}" (${workspaceId}) as ${admin.email}; ${email} got the owner invitation by email and becomes the owner once they confirm their address.`,
    )
  }
  await ensureWorkspaceRows(workspaceId, name, input.timeZone, 'done')
  out.push('Assistant and settings in place, onboarding done.')
  if (input.number) {
    out.push(await ensureNumber(input.number, workspaceId, admin.id))
    out.push(`Next, in the agent container: node src/setup-sip.ts ${input.number}`)
  }
  return { lines: out, workspaceId, adminId: admin.id }
}

/**
 * The admin of the run, acting in the workspace to attach its number: owner rights there, and instance:admin to hand
 * it a number of the install's account. A disabled workspace says so, as context.ts does for a member (the handler
 * refuses then).
 */
export async function numberSetupActor(adminId: string, workspaceId: string): Promise<Actor> {
  const [ws] = await db
    .select({ disabledAt: organization.disabledAt })
    .from(organization)
    .where(eq(organization.id, workspaceId))
  return {
    ...adminOnServer(adminId),
    role: 'owner',
    workspaceId,
    permissions: [...rolePermissions.owner, 'instance:admin'],
    ...(ws?.disabledAt ? { workspaceDisabled: true as const } : {}),
  }
}

/** Attaches the number through the registry, like onboarding does. Never buys one. */
async function ensureNumber(e164: string, workspaceId: string, adminId: string): Promise<string> {
  const [taken] = await db.select().from(phone_numbers).where(eq(phone_numbers.e164, e164))
  if (taken?.workspace_id === workspaceId) return `${e164} was already set up`
  if (taken) throw new Error(`${e164} belongs to another workspace`)
  const { body } = await runAction(
    'phoneNumber.setup',
    { e164, purchase: false },
    await numberSetupActor(adminId, workspaceId),
  )
  if (!body.ok) throw new Error(`phone setup failed: ${body.error}`)
  return `${e164} attached and routed to LiveKit SIP (${process.env.LIVEKIT_SIP_ENDPOINT ?? 'no endpoint set'})`
}

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      owner: { type: 'string' },
      'owner-name': { type: 'string' },
      as: { type: 'string' },
      number: { type: 'string' },
      'time-zone': { type: 'string' },
    },
  })
  const name = values.name?.trim()
  if (!name || name.length > 80 || !values.owner) throw new Error(USAGE)
  if (values.number && !/^\+[1-9]\d{6,14}$/.test(values.number))
    throw new Error(`--number must be E.164, like +15035550142. ${USAGE}`)
  const lines = await provisionWorkspace({
    name,
    owner: values.owner,
    ownerName: values['owner-name'],
    as: values.as,
    number: values.number,
    timeZone: values['time-zone'],
  })
  for (const line of lines) console.log(line)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
    .catch(e => {
      console.error(e instanceof Error ? e.message : e)
      process.exitCode = 1
    })
    .finally(() => pool.end())
