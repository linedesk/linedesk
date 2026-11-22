// Server admin › Overview › Funnel (admin-funnel.ts): sign-ups per week and how far they got, from our own tables.
// Counts across workspaces and makes an instance admin, so this file has a database of its own (INSTANCE_WIDE_FILES).
import {
  billing_accounts,
  billing_invoices,
  calls,
  organization,
  phone_numbers,
  setup_events,
  user,
} from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { adminFunnel, funnelWeeks } from '../src/admin-funnel.ts'
import { db } from '../src/db.ts'
import { createWorkspace, randomNumber, request, type Workspace } from './helpers.ts'

const DAY = 86_400_000
const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/** A workspace with no call yet (the helper files one). */
async function fresh(name: string) {
  const ws = await createWorkspace(name)
  await db.delete(calls).where(eq(calls.workspace_id, ws.id))
  return ws
}
const signedUpDaysAgo = (ws: Workspace, days: number) =>
  db
    .update(setup_events)
    .set({ at: new Date(Date.now() - days * DAY).toISOString() })
    .where(and(eq(setup_events.workspace_id, ws.id), eq(setup_events.event, 'signup')))
const callFrom = (ws: Workspace, values: Partial<typeof calls.$inferInsert> = {}) =>
  db
    .insert(calls)
    .values({ id: rid('call'), workspace_id: ws.id, from_number: randomNumber(), to_number: ws.number, ...values })
async function bill(ws: Workspace, status: 'trialing' | 'active', paidCents?: number) {
  const id = rid('bill')
  await db.insert(billing_accounts).values({ id, kind: 'cloud', owner_user_id: ws.owner.userId, status })
  await db.update(organization).set({ billingAccountId: id }).where(eq(organization.id, ws.id))
  if (paidCents !== undefined)
    await db.insert(billing_invoices).values({
      stripe_invoice_id: rid('in'),
      billing_account_id: id,
      kind: 'subscription',
      status: 'paid',
      total_cents: paidCents,
    })
}

describe('admin funnel', () => {
  beforeAll(async () => {
    // Nothing else in this database: every count below is ours.
    await fresh('Signed Up Only Plumbing')
    const verified = await fresh('Verified Forwarding Plumbing')
    await db
      .update(phone_numbers)
      .set({ verified_at: new Date().toISOString() })
      .where(eq(phone_numbers.workspace_id, verified.id))
    const called = await fresh('Real Call Plumbing')
    await callFrom(called)
    const ownPhone = await fresh('Own Phone Plumbing')
    await callFrom(ownPhone, { from_own_number: true })
    const tested = await fresh('Test Call Plumbing')
    await callFrom(tested, { source: 'test' })
    const paying = await fresh('Paying Plumbing')
    await callFrom(paying)
    await bill(paying, 'active', 1100)
    const trial = await fresh('Trial Plumbing')
    await bill(trial, 'trialing', 0)
    const disabled = await fresh('Disabled Plumbing')
    await db.update(organization).set({ disabledAt: new Date() }).where(eq(organization.id, disabled.id))
    const admin = await fresh('Operator Plumbing')
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, admin.owner.userId))
    const older = await fresh('Ten Weeks Ago Plumbing')
    await signedUpDaysAgo(older, 70)
  })

  test('counts each step per sign-up week; leaves out disabled and server-admin workspaces', async () => {
    const funnel = await adminFunnel(db, 8)
    expect(funnel.rows).toHaveLength(8)
    expect(funnel.rows[0]).toMatchObject({ signed_up: 7, set_up: 3, first_call: 2, paid: 1 })
    expect(funnel.rows.slice(1).every(r => r.signed_up === 0)).toBe(true)
    expect(funnel.total).toEqual({ signed_up: 7, set_up: 3, first_call: 2, paid: 1 })
    // Weeks start on Monday, newest first.
    const days = funnel.rows.map(r => new Date(`${r.week_start}T00:00:00Z`))
    expect(days.every(d => d.getUTCDay() === 1)).toBe(true)
    expect(days[0]! > days[1]!).toBe(true)
  })

  test('a longer range reaches older sign-ups', async () => {
    const funnel = await adminFunnel(db, 12)
    expect(funnel.rows).toHaveLength(12)
    expect(funnel.total.signed_up).toBe(8)
  })

  test('the range is one of the offered ones, else 8 weeks', () => {
    expect(funnelWeeks('26')).toBe(26)
    expect(funnelWeeks('5')).toBe(8)
    expect(funnelWeeks(undefined)).toBe(8)
    expect(funnelWeeks('abc')).toBe(8)
  })

  test('only an instance admin reads it', async () => {
    const someone = await createWorkspace('Curious Owner Plumbing')
    expect((await request(someone.owner, 'GET', '/v1/admin/funnel')).status).toBe(403)
  })
})
