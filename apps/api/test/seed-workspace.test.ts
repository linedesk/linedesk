import { calls, member, organization, user, workspace_settings } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { seedTag, seedUserWorkspace } from '../src/seed-workspace.ts'
import { createWorkspace, getCall } from './helpers.ts'

const emailOf = async (userId: string) => (await db.select().from(user).where(eq(user.id, userId)))[0]!.email
const callsIn = async (workspaceId: string) => db.select().from(calls).where(eq(calls.workspace_id, workspaceId))

describe('seed for one account (db:seed --user)', { timeout: 20_000 }, () => {
  test("fills the account's workspace: onboarding done, calls in every view, team; other workspaces untouched", async () => {
    const ws = await createWorkspace('Seed Target')
    const other = await createWorkspace('Seed Bystander')
    const otherBefore = await callsIn(other.id)

    const result = await seedUserWorkspace({
      email: await emailOf(ws.owner.userId),
      business: 'Brightwater Plumbing & Heating',
    })

    expect(result).toMatchObject({ workspaceId: ws.id, skipped: false })
    expect(result.counts.calls).toBeGreaterThan(15)
    expect(result.counts).toMatchObject({ bookings: 3, appointment_types: 4, teammates: 2, invitations: 1 })
    const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, ws.id))
    expect(settings).toMatchObject({ onboarding_step: 'done', business_hours_on: true })
    const [org] = await db.select().from(organization).where(eq(organization.id, ws.id))
    expect(org!.name).toBe('Brightwater Plumbing & Heating')
    const seeded = (await callsIn(ws.id)).filter(c => c.id.includes(seedTag(ws.id)))
    expect(new Set(seeded.map(c => c.outcome))).toEqual(
      new Set(['callback', 'message', 'hangup', 'answered', 'spam', 'booked', 'rescheduled', 'transferred']),
    )
    expect(seeded.some(c => c.urgency === 'urgent' && c.inbox_state === 'open')).toBe(true)
    expect(seeded.some(c => c.inbox_state === 'done')).toBe(true)
    expect(seeded.some(c => c.reminder_at)).toBe(true)
    expect(seeded.some(c => c.assignee_id === ws.owner.userId)).toBe(true)
    expect(seeded.every(c => c.to_number === ws.number)).toBe(true)
    const members = await db.select().from(member).where(eq(member.organizationId, ws.id))
    expect(members.map(m => m.role).sort()).toEqual(['admin', 'member', 'owner'])
    expect(await callsIn(other.id)).toEqual(otherBefore)
  })

  test('runs again without changes; --reset replaces only its own rows', async () => {
    const ws = await createWorkspace('Seed Twice')
    const email = await emailOf(ws.owner.userId)
    const first = await seedUserWorkspace({ email })

    const again = await seedUserWorkspace({ email })
    expect(again).toMatchObject({ skipped: true, counts: first.counts })

    const reset = await seedUserWorkspace({ email, reset: true })
    expect(reset).toMatchObject({ skipped: false, counts: first.counts })
    // The member's own call (from createWorkspace) is still there.
    expect(await getCall(ws.call.id)).toBeDefined()
    const own = await db
      .select()
      .from(calls)
      .where(and(eq(calls.workspace_id, ws.id), eq(calls.id, ws.call.id)))
    expect(own).toHaveLength(1)
  })

  test('refuses an unknown account', async () => {
    await expect(seedUserWorkspace({ email: 'nobody@linedesk.test' })).rejects.toThrow('No user nobody@linedesk.test')
  })
})
