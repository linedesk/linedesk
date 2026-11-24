// The server CLI workspace-create.ts runs workspace.create as a named server admin (decision of 2026-11-15, Q9): the same
// audit entry, rights and owner rules as Server admin › Workspaces › New workspace. --as may be left out only while the
// install has exactly one enabled server admin. user:create makes server admins only. Own database (vitest.config.ts):
// this file counts the install's server admins.
import { commands, invitation, member, organization, phone_numbers, user, workspace_settings } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { runAction } from '../src/run-action.ts'
import { numberSetupActor, pickAdmin, provisionWorkspace } from '../src/workspace-create.ts'
import { randomNumber, signUp } from './helpers.ts'

const unique = (prefix: string) => `${prefix} ${crypto.randomUUID().slice(0, 6)}`
const address = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const emailOf = async (id: string) => (await db.select().from(user).where(eq(user.id, id)))[0]!.email
async function makeAdmin() {
  const admin = await signUp()
  await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, admin.userId))
  return { id: admin.userId, email: await emailOf(admin.userId) }
}
const workspacesNamed = (name: string) => db.select().from(organization).where(eq(organization.name, name))

describe('pickAdmin', () => {
  const admins = [
    { id: 'a1', email: 'ann@example.com' },
    { id: 'a2', email: 'bob@example.com' },
  ]
  test('--as names an enabled server admin (any case); anyone else is refused', () => {
    expect(pickAdmin(' BOB@example.com', admins)).toMatchObject({ id: 'a2', chosen: 'named' })
    expect(() => pickAdmin('eve@example.com', admins)).toThrow(/not an enabled server admin/)
  })
  test('without --as: the only server admin; none or several stop with what to do', () => {
    expect(pickAdmin(undefined, [admins[0]!])).toMatchObject({ id: 'a1', chosen: 'only' })
    expect(() => pickAdmin(undefined, [])).toThrow(/no server admin.*user:create/)
    expect(() => pickAdmin(undefined, admins)).toThrow(/2 server admins: name the one this runs as with --as/)
  })
})

// In order: the file's database starts without a server admin.
describe('provisionWorkspace', () => {
  let first: { id: string; email: string }

  test('no server admin on the install: stops, nothing made', async () => {
    const name = unique('Nobody Plumbing')
    await expect(provisionWorkspace({ name, owner: address('owner'), ownerName: 'Nobody' })).rejects.toThrow(
      /no server admin/,
    )
    expect(await workspacesNamed(name)).toEqual([])
  })

  test('the only server admin, a new owner address: workspace.create as that admin, an owner invitation, onboarding done', async () => {
    first = await makeAdmin()
    const name = unique('Brightwater Plumbing')
    const owner = address('mike')
    const out = await provisionWorkspace({ name, owner, ownerName: 'Mike Brennan', timeZone: 'America/Los_Angeles' })
    expect(out[0]).toBe(`Running as ${first.email}, the only server admin of this install.`)
    expect(out[1]).toMatch(/got the owner invitation by email/)
    const [ws] = await workspacesNamed(name)
    // One logged command by the admin, like Server admin › New workspace: the audit log has it.
    const logged = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'workspace.create'), eq(commands.actor_id, first.id)))
    expect(logged.filter(c => (c.input as { name?: string }).name === name)).toHaveLength(1)
    // The owner is invited by the admin (an invitation names its sender); nobody is a member yet, the admin never joins.
    expect(await db.select().from(invitation).where(eq(invitation.organizationId, ws!.id))).toMatchObject([
      { email: owner, role: 'owner', status: 'pending', inviterId: first.id },
    ])
    expect(await db.select().from(member).where(eq(member.organizationId, ws!.id))).toEqual([])
    const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, ws!.id))
    expect(settings).toMatchObject({ onboarding_step: 'done', timezone: 'America/Los_Angeles' })
    // Safe to run again: the invited workspace is found, not made twice.
    const again = await provisionWorkspace({ name, owner: owner.toUpperCase(), ownerName: 'Mike Brennan' })
    expect(again).toContain(`Found workspace "${name}" (${ws!.id}) for ${owner}.`)
    expect(await workspacesNamed(name)).toHaveLength(1)
  })

  test('a confirmed account becomes the owner at once; the number is attached by the same admin (one actor per run)', async () => {
    const ownerUser = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, ownerUser.userId))
    const name = unique('Riverside Dental')
    const number = randomNumber()
    const out = await provisionWorkspace({ name, owner: await emailOf(ownerUser.userId), number })
    expect(out.join('\n')).toMatch(/is its owner/)
    const [ws] = await workspacesNamed(name)
    expect(await db.select().from(member).where(eq(member.organizationId, ws!.id))).toMatchObject([
      { userId: ownerUser.userId, role: 'owner' },
    ])
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.e164, number))).toMatchObject([
      { workspace_id: ws!.id },
    ])
    // The creation and the number in the command log: both by the run's admin, nothing as "the server operator".
    const logged = await db.select().from(commands).where(eq(commands.workspace_id, ws!.id))
    expect(logged.find(c => c.action === 'phoneNumber.setup')?.actor_id).toBe(first.id)
    expect(logged.filter(c => c.actor_id === 'cli')).toEqual([])
    // Again: found by its owner, the number already there.
    const again = await provisionWorkspace({ name, owner: await emailOf(ownerUser.userId), number })
    expect(again).toContain(`${number} was already set up`)
  })

  test('a disabled workspace found again stops the run: no onboarding change, no number; the number actor says disabled', async () => {
    const ownerUser = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, ownerUser.userId))
    const owner = await emailOf(ownerUser.userId)
    const name = unique('Disabled Roofing')
    await provisionWorkspace({ name, owner })
    const [ws] = await workspacesNamed(name)
    await db
      .update(workspace_settings)
      .set({ onboarding_step: 'business' })
      .where(eq(workspace_settings.workspace_id, ws!.id))
    await db.update(organization).set({ disabledAt: new Date() }).where(eq(organization.id, ws!.id))
    const number = randomNumber()
    await expect(provisionWorkspace({ name, owner, number })).rejects.toThrow(
      `Workspace "${name}" (${ws!.id}) is disabled: enable it in Server admin first.`,
    )
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.e164, number))).toEqual([])
    const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, ws!.id))
    expect(settings?.onboarding_step).toBe('business')
    // Belt and braces: the actor the number is attached with carries the flag, so phoneNumber.setup refuses too.
    const actor = await numberSetupActor(first.id, ws!.id)
    expect(actor).toMatchObject({ actorId: first.id, workspaceId: ws!.id, workspaceDisabled: true })
    expect(await runAction('phoneNumber.setup', { e164: number, purchase: false }, actor)).toMatchObject({
      body: { ok: false, error: 'this workspace is disabled' },
    })
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.e164, number))).toEqual([])
    // Enabled again: no flag.
    await db.update(organization).set({ disabledAt: null }).where(eq(organization.id, ws!.id))
    expect(await numberSetupActor(first.id, ws!.id)).not.toHaveProperty('workspaceDisabled')
  })

  test("the action's owner rules apply: a new address needs the owner's name, nothing made", async () => {
    const name = unique('Nameless Heating')
    await expect(provisionWorkspace({ name, owner: address('noname') })).rejects.toThrow(/has no account yet/)
    expect(await workspacesNamed(name)).toEqual([])
  })

  test('several server admins: --as is required and must name one of them', async () => {
    const second = await makeAdmin()
    const name = unique('Two Admins Electric')
    await expect(provisionWorkspace({ name, owner: address('o'), ownerName: 'O' })).rejects.toThrow(
      /2 server admins: name the one this runs as with --as/,
    )
    const plain = await signUp()
    await expect(
      provisionWorkspace({ name, owner: address('o'), ownerName: 'O', as: await emailOf(plain.userId) }),
    ).rejects.toThrow(/not an enabled server admin/)
    expect(await workspacesNamed(name)).toEqual([])
    const owner = address('o')
    await provisionWorkspace({ name, owner, ownerName: 'O', as: second.email })
    const [ws] = await workspacesNamed(name)
    expect(await db.select().from(invitation).where(eq(invitation.organizationId, ws!.id))).toMatchObject([
      { email: owner, inviterId: second.id },
    ])
  })

  test('a disabled server admin is not one: refused with --as', async () => {
    const third = await makeAdmin()
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, third.id))
    await expect(
      provisionWorkspace({ name: unique('Disabled'), owner: address('o'), ownerName: 'O', as: third.email }),
    ).rejects.toThrow(/not an enabled server admin/)
  })
})

describe('user:create makes server admins only', () => {
  const operator: Actor = {
    actorId: 'cli',
    role: 'member',
    workspaceId: null,
    permissions: ['instance:admin'],
    passkeyConfirmed: true,
  }
  test('the operator cannot make a bare account without a workspace any more; a new server admin still works', async () => {
    const bare = address('bare')
    expect(await runAction('user.invite', { email: bare, name: 'Bare' }, operator)).toMatchObject({
      status: 409,
      body: { ok: false, error: 'choose a workspace: only an instance admin can be added without one' },
    })
    expect(await db.select().from(user).where(eq(user.email, bare))).toEqual([])
    const admin = address('admin')
    expect((await runAction('user.invite', { email: admin, name: 'New Admin', admin: true }, operator)).status).toBe(
      200,
    )
    expect(await db.select().from(user).where(eq(user.email, admin))).toMatchObject([{ instanceAdmin: true }])
  })
})
