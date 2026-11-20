// Deleting a workspace ends the plan it alone paid for (src/workspace-delete-plan.ts, LIN-647): a server admin's delete
// and an owner's own, whatever happens to the accounts. Stripe is a fake provider (billing-settings.ts mocked); a
// refused delete never ends a plan. Makes server admins, so this file has a database of its own (INSTANCE_WIDE_FILES).
import type { BillingProvider } from '@linedesk/billing'
import { billing_accounts, organization, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { Reject } from '../src/handler-context.ts'
import { endPlanWithDelete } from '../src/workspace-delete-plan.ts'
import { setJobQueue } from '../src/jobs.ts'
import { act, asServerAdmin, createWorkspace, signUp, type User, type Workspace } from './helpers.ts'

/** The fake Stripe: subscription ids canceled (always at once), and whether it answers. */
const stripe = vi.hoisted(() => ({
  canceled: [] as { id: string; now: boolean }[],
  down: false,
  /** Billing in effect (the default), off with Stripe keys connected, or off with no keys at all. */
  billing: 'on' as 'on' | 'paused' | 'none',
}))
vi.mock('../src/billing-settings.ts', async original => {
  const real = await original<typeof import('../src/billing-settings.ts')>()
  const provider = {
    name: 'stripe',
    cancelSubscription: async (id: string, options: { now: boolean }) => {
      if (stripe.down) throw new Error('Stripe is not answering')
      stripe.canceled.push({ id, now: options.now })
      return { id, status: 'canceled' }
    },
  } as unknown as BillingProvider
  return {
    ...real,
    billingState: async (...args: Parameters<typeof real.billingState>) => ({
      ...(await real.billingState(...args)),
      inEffect: stripe.billing === 'on' ? ('stripe' as const) : ('none' as const),
      connected: stripe.billing !== 'none',
    }),
    billingProvider: async () => provider,
  }
})

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const NAME = 'Brightwater Plumbing & Heating'

beforeEach(() => {
  stripe.canceled.length = 0
  stripe.down = false
  stripe.billing = 'on'
  setJobQueue({ send: async () => 'job', insert: async () => [] } as never)
})
afterEach(() => setJobQueue(null))

/** A workspace on a Cloud bill with a running plan (`over`: the bill's columns), its owner the bill's owner. */
async function paid(over: Partial<typeof billing_accounts.$inferInsert> = {}, ws?: Workspace) {
  const workspace = ws ?? (await createWorkspace(NAME))
  const [bill] = await db
    .insert(billing_accounts)
    .values({
      id: rid('bill'),
      kind: 'cloud',
      owner_user_id: workspace.owner.userId,
      status: 'active',
      stripe_customer_id: rid('cus'),
      stripe_subscription_id: rid('sub'),
      ...over,
    })
    .returning()
  await db
    .update(organization)
    .set({ billingAccountId: bill!.id, billingState: 'active' })
    .where(eq(organization.id, workspace.id))
  return { ws: workspace, bill: bill! }
}
const billNow = async (id: string) => (await db.select().from(billing_accounts).where(eq(billing_accounts.id, id)))[0]!
const workspaceGone = async (id: string) =>
  (await db.select().from(organization).where(eq(organization.id, id))).length === 0
const adminDelete = (admin: User, workspaceId: string, name = NAME, keepAccounts = false) =>
  asServerAdmin(admin, () => act(admin, 'workspace.delete', { workspaceId, name, keepAccounts }))

describe("a server admin's delete", () => {
  test('with "Keep their accounts": the plan is canceled at once in Stripe and the bill closed', async () => {
    const admin = await signUp()
    const { ws, bill } = await paid()
    const res = await adminDelete(admin, ws.id, NAME, true)
    expect(res.status).toBe(200)
    expect(res.body.data.planCanceled).toBe(true)
    expect(stripe.canceled).toEqual([{ id: bill.stripe_subscription_id, now: true }])
    expect(await workspaceGone(ws.id)).toBe(true)
    expect(await billNow(bill.id)).toMatchObject({ status: 'canceled', cancel_at_period_end: false })
    expect((await billNow(bill.id)).canceled_at).not.toBeNull()
    // The owner's account was kept; it no longer owns a running bill.
    expect(await db.select().from(user).where(eq(user.id, ws.owner.userId))).toHaveLength(1)
  })

  test("deleting the accounts too: the bill owner's account goes once the plan ended (no refusal)", async () => {
    const admin = await signUp()
    const { ws, bill } = await paid({ status: 'trialing' })
    const res = await adminDelete(admin, ws.id)
    expect(res.status).toBe(200)
    expect(stripe.canceled.map(c => c.id)).toEqual([bill.stripe_subscription_id])
    expect(await db.select().from(user).where(eq(user.id, ws.owner.userId))).toEqual([])
    expect((await billNow(bill.id)).status).toBe('canceled')
  })

  test('a wrong name, or an account that owns another running bill, is refused before Stripe is asked', async () => {
    const admin = await signUp()
    const { ws, bill } = await paid()
    expect((await adminDelete(admin, ws.id, 'Not The Name')).status).toBe(409)
    // The owner pays for another plan too: deleting their account is refused, so the plan stays.
    await db.insert(billing_accounts).values({
      id: rid('bill'),
      kind: 'cloud',
      owner_user_id: ws.owner.userId,
      status: 'active',
      stripe_subscription_id: rid('sub'),
    })
    expect((await adminDelete(admin, ws.id)).body.error).toMatch(/hand the bill/)
    expect(stripe.canceled).toEqual([])
    expect(await workspaceGone(ws.id)).toBe(false)
    expect((await billNow(bill.id)).status).toBe('active')
  })

  test('Stripe not answering refuses the delete: the workspace and the plan stay', async () => {
    const admin = await signUp()
    const { ws, bill } = await paid()
    stripe.down = true
    const console_ = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await adminDelete(admin, ws.id, NAME, true)
    console_.mockRestore()
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/could not be ended in Stripe/)
    expect(await workspaceGone(ws.id)).toBe(false)
    expect((await billNow(bill.id)).status).toBe('active')
  })

  test('billing paused with Stripe keys connected refuses the delete; an install without Stripe closes the bill', async () => {
    const admin = await signUp()
    const paused = await paid()
    stripe.billing = 'paused'
    const res = await adminDelete(admin, paused.ws.id, NAME, true)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Billing is paused/)
    expect(await workspaceGone(paused.ws.id)).toBe(false)
    expect((await billNow(paused.bill.id)).status).toBe('active')
    // No Stripe keys at all: nothing to cancel there; the delete goes through and the bill is closed.
    stripe.billing = 'none'
    const unbilled = await paid()
    expect((await adminDelete(admin, unbilled.ws.id, NAME, true)).body.data.planCanceled).toBe(true)
    expect(stripe.canceled).toEqual([])
    expect((await billNow(unbilled.bill.id)).status).toBe('canceled')
  })

  test('the plan canceled before the transaction must still be the one that ends, or the delete is refused', async () => {
    const { ws, bill } = await paid()
    const prepared = { billId: bill.id, subscriptionId: bill.stripe_subscription_id! }
    const refusal = (run: Promise<unknown>) =>
      run.then(
        () => null,
        (e: unknown) => e,
      )
    // Another subscription on the bill now (a plan started meanwhile).
    const other = await refusal(
      db.transaction(tx =>
        endPlanWithDelete(tx, ws.id, { ...prepared, subscriptionId: rid('sub') }, new Date().toISOString()),
      ),
    )
    expect(other).toBeInstanceOf(Reject)
    expect(String((other as Reject).message)).toMatch(/plan changed/)
    // A workspace moved onto the bill between the preparer and the transaction (billing.moveWorkspace): no plan ends
    // now, but one was canceled, so the delete is refused instead of going through as if nothing had happened.
    const moved = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: bill.id }).where(eq(organization.id, moved.id))
    const race = await refusal(db.transaction(tx => endPlanWithDelete(tx, ws.id, prepared, new Date().toISOString())))
    expect(race).toBeInstanceOf(Reject)
    expect(String((race as Reject).message)).toMatch(/plan changed/)
    // Nothing prepared and nothing ending: the delete goes on as before.
    expect(await db.transaction(tx => endPlanWithDelete(tx, ws.id, null, new Date().toISOString()))).toBe(false)
    expect((await billNow(bill.id)).status).toBe('active')
  })

  test('a bill with another workspace, a partner bill and a canceled bill go on as they are', async () => {
    const admin = await signUp()
    const shared = await paid()
    const second = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: shared.bill.id }).where(eq(organization.id, second.id))
    expect((await adminDelete(admin, second.id, 'Brightwater North', true)).body.data.planCanceled).toBe(false)
    expect((await billNow(shared.bill.id)).status).toBe('active')
    const ended = await paid({ status: 'canceled', canceled_at: new Date().toISOString() })
    expect((await adminDelete(admin, ended.ws.id, NAME, true)).status).toBe(200)
    expect(stripe.canceled).toEqual([])
  })
})

describe("an owner's own delete", () => {
  test('the preview says the plan ends; the delete ends it, also when the owner keeps their account', async () => {
    const { ws, bill } = await paid()
    expect((await act(ws.owner, 'workspace.deletePreview', {})).body.data.planEnds).toBe(true)
    const res = await act(ws.owner, 'workspace.deleteOwn', { name: NAME, keepOwnAccount: true })
    expect(res.status).toBe(200)
    expect(res.body.data.planCanceled).toBe(true)
    expect(stripe.canceled).toEqual([{ id: bill.stripe_subscription_id, now: true }])
    expect((await billNow(bill.id)).status).toBe('canceled')
  })

  test('without a plan the preview says nothing about one and Stripe is not asked', async () => {
    const ws = await createWorkspace('No Plan Here')
    expect((await act(ws.owner, 'workspace.deletePreview', {})).body.data.planEnds).toBe(false)
    expect((await act(ws.owner, 'workspace.deleteOwn', { name: 'No Plan Here' })).status).toBe(200)
    expect(stripe.canceled).toEqual([])
  })
})
