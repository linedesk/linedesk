// Server admin actions on an account name whom they were about (E4), and workspace.delete's keep option,
// keepAccounts (E14). Makes and removes instance admins,
// so it has a database of its own (INSTANCE_WIDE_FILES in vitest.config.ts).
import { REDACTED } from '@linedesk/actions'
import { commands, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { listAudit } from '../src/audit.ts'
import { db } from '../src/db.ts'
import { act, addMember, createWorkspace, signUp, type User } from './helpers.ts'

let operator: User
const secondFactor = process.env.ADMIN_SECOND_FACTOR

const emailOf = async (who: User) => (await db.select().from(user).where(eq(user.id, who.userId)))[0]!.email
const exists = async (who: User) => (await db.select().from(user).where(eq(user.id, who.userId))).length === 1

beforeAll(async () => {
  // The passkey check for admin actions is its own test (admin.test.ts): here the operator has passed it.
  process.env.ADMIN_SECOND_FACTOR = 'off'
  operator = (await createWorkspace('Linedesk Operations')).owner
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
})

afterAll(() => {
  if (secondFactor === undefined) delete process.env.ADMIN_SECOND_FACTOR
  else process.env.ADMIN_SECOND_FACTOR = secondFactor
})

describe('account actions keep whom they were about (E4)', () => {
  test.each(['user.disable', 'user.enable', 'instanceAdmin.grant', 'instanceAdmin.revoke'])(
    '%s returns the address as its subject, filed under no workspace',
    async action => {
      const ws = await createWorkspace('Brightwater Plumbing & Heating')
      const target = await addMember(ws.id, 'member')
      const email = await emailOf(target)
      if (action === 'user.enable') await act(operator, 'user.disable', { userId: target.userId })
      if (action === 'instanceAdmin.revoke') await act(operator, 'instanceAdmin.grant', { userId: target.userId })

      const res = await act(operator, action, { userId: target.userId })
      expect(res.status).toBe(200)
      expect(res.body.data.subject).toEqual({ email, workspaceId: null })
      // A grant to someone without a passkey hands out their enrolment code: shown once, never in the command log.
      if (action === 'instanceAdmin.grant') {
        const code: string = res.body.data.enrolmentCode
        expect(code).toEqual(expect.any(String))
        const logged = await db.select().from(commands).where(eq(commands.action, action))
        expect(JSON.stringify(logged)).not.toContain(code)
        expect(logged.some(c => JSON.stringify(c.result).includes(REDACTED))).toBe(true)
      }

      // The audit log names them, and lists the entry under no workspace (not the operator's own).
      const { entries } = await listAudit(db, { limit: 200 })
      const entry = entries.find(e => e.what === action && e.subject?.email === email)
      expect(entry).toMatchObject({ subject: { email }, workspace: null, refused: false })
    },
  )
})

describe('workspace.delete: keepAccounts (E14)', () => {
  /** A workspace whose owner and member are in no other workspace: their accounts go with it unless kept. */
  async function doomed(name: string) {
    const ws = await createWorkspace(name)
    return { ws, owner: ws.owner, member: await addMember(ws.id, 'member') }
  }
  const remove = (workspaceId: string, name: string, keep: Record<string, boolean>) =>
    act(operator, 'workspace.delete', { workspaceId, name, ...keep })

  test('keepAccounts keeps every account that would go', async () => {
    const { ws, owner, member } = await doomed('Harbor Lane Dental')
    const res = await remove(ws.id, 'Harbor Lane Dental', { keepAccounts: true })
    expect(res).toMatchObject({ status: 200, body: { data: { usersDeleted: [] } } })
    expect(await exists(owner)).toBe(true)
    expect(await exists(member)).toBe(true)
  })


  test('without it, the accounts that belong nowhere else go, as before', async () => {
    const { ws, owner, member } = await doomed('Zeta Roofing')
    const emails = [await emailOf(owner), await emailOf(member)].sort()
    const res = await remove(ws.id, 'Zeta Roofing', {})
    expect(res.status).toBe(200)
    expect([...res.body.data.usersDeleted].sort()).toEqual(emails)
    expect(await exists(owner)).toBe(false)
    expect(await exists(member)).toBe(false)
  })

  test('keepAccounts false, as the web sends an unticked box, deletes them as before', async () => {
    const { ws, member } = await doomed('Oak Street Pharmacy')
    const email = await emailOf(member)
    const res = await remove(ws.id, 'Oak Street Pharmacy', { keepAccounts: false })
    expect(res.status).toBe(200)
    expect(res.body.data.usersDeleted).toContain(email)
  })

  test('a member in another workspace keeps their account either way', async () => {
    const { ws } = await doomed('Pine Street Bakery')
    const elsewhere = await signUp()
    const stays = await createWorkspace('Maple Auto Repair')
    const { auth } = await import('../src/auth.ts')
    for (const id of [ws.id, stays.id])
      await auth.api.addMember({ body: { userId: elsewhere.userId, organizationId: id, role: 'member' } })
    expect((await remove(ws.id, 'Pine Street Bakery', {})).status).toBe(200)
    expect(await exists(elsewhere)).toBe(true)
  })
})
