// Dunning and the bill's ownership (src/billing-lifecycle.ts, src/billing-owner.ts; docs/billing.md §3.4, §8, decision
// 9; PR 11), step by step in time: past_due → suspended on day 7 (day 3 after a failed first payment) with the fixed
// line → reminders on day 14 and 21 → canceled on day 30 (our job cancels the subscription) → numbers released 30
// days later as the billing system. Then the owner's banner data, the port-out PINs behind the step-up, the hand-over
// rules and the account-deletion guard. Billing is switched on by replacing billingState, the three stages through the
// environment, and Stripe is a fake provider: this file is instance-wide.
import type { BillingProvider, BillingSubscription } from '@linedesk/billing'
import {
  billing_accounts,
  billing_alerts,
  billing_numbers,
  billing_periods,
  calls,
  commands,
  member,
  organization,
  phone_numbers,
  session,
  user,
} from '@linedesk/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { DUNNING, runDunning } from '../src/billing-lifecycle.ts'
import { auth } from '../src/auth.ts'
import { refuseDeletingBillOwners } from '../src/billing-owner.ts'
import { BILLING_LIFECYCLE_EMAIL } from '../src/billing-periods.ts'
import { db } from '../src/db.ts'
import { setJobQueue } from '../src/jobs.ts'
import {
  act,
  addMember,
  agent,
  asServerAdmin,
  createWorkspace,
  premiumAndUltraOf,
  randomNumber,
  type User,
  type Workspace,
  withPremiumAndUltra,
} from './helpers.ts'

const cloud = vi.hoisted(() => ({ on: true }))
vi.mock('../src/billing-settings.ts', async original => {
  const real = await original<typeof import('../src/billing-settings.ts')>()
  return {
    ...real,
    billingState: async (...args: Parameters<typeof real.billingState>) =>
      cloud.on ? { ...(await real.billingState(...args)), inEffect: 'stripe' as const } : real.billingState(...args),
  }
})

// Placeholder values, never sent anywhere: the three stages count as set up, so calls are Standard.
const ENV = {
  STT_PROVIDER: 'deepgram',
  DEEPGRAM_API_KEY: 'placeholder',
  LLM_PROVIDER: 'openai',
  OPENAI_API_KEY: 'placeholder',
  TTS_PROVIDER: 'elevenlabs',
  ELEVENLABS_API_KEY: 'placeholder',
}
const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

let queued: { name: string; data: Record<string, unknown> }[] = []
beforeEach(() => {
  queued = []
  cloud.on = true
  stripe.subscriptions.clear()
  stripe.canceled.length = 0
  setJobQueue({
    send: async (name: string, data: Record<string, unknown>) => {
      queued.push({ name, data })
      return 'job'
    },
    insert: async () => [],
  } as never)
})
afterEach(() => setJobQueue(null))
const emailsOf = (bill: string) =>
  queued
    .filter(j => j.name === BILLING_LIFECYCLE_EMAIL && j.data.bill === bill)
    .map(j => j.data.email as { kind: string } & Record<string, unknown>)

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const DAY = 86_400_000
const at = (ms: number) => new Date(ms).toISOString()

/** A fake Stripe: subscription statuses, and the subscriptions our job canceled. */
const stripe = { subscriptions: new Map<string, string>(), canceled: [] as string[] }
const provider = {
  name: 'stripe',
  subscription: async (id: string) =>
    stripe.subscriptions.has(id) ? ({ id, status: stripe.subscriptions.get(id)! } as BillingSubscription) : null,
  // Dunning ends the subscription at once (#960's cancelSubscription with now), never at the period end.
  cancelSubscription: async (id: string, options: { now: boolean }) => {
    if (!options?.now) throw new Error('dunning cancels now')
    stripe.canceled.push(id)
    stripe.subscriptions.set(id, 'canceled')
    return null
  },
} as unknown as BillingProvider
const dunning = (now: number) => runDunning(at(now), { provider })

type Billed = { ws: Workspace; billId: string; subscriptionId: string }

/** `ws` on a bill with a current period and a Stripe subscription in `subscriptionStatus`. */
async function billed(
  over: Partial<typeof billing_accounts.$inferInsert> = {},
  subscriptionStatus = 'past_due',
): Promise<Billed> {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const billId = rid('bill')
  const subscriptionId = rid('sub')
  await db.insert(billing_accounts).values({
    id: billId,
    kind: 'cloud',
    owner_user_id: ws.owner.userId,
    status: 'active',
    stripe_customer_id: rid('cus'),
    stripe_subscription_id: subscriptionId,
    ...over,
  })
  await db.insert(billing_periods).values({
    id: rid('bp'),
    billing_account_id: billId,
    starts_at: at(Date.now() - 100 * DAY),
    ends_at: at(Date.now() + 100 * DAY),
    kind: 'month',
  })
  await db
    .update(organization)
    .set({
      billingAccountId: billId,
      billingState: over.status === 'past_due' || !over.status ? 'active' : 'suspended',
    })
    .where(eq(organization.id, ws.id))
  stripe.subscriptions.set(subscriptionId, subscriptionStatus)
  return { ws, billId, subscriptionId }
}
const billNow = async (id: string) => (await db.select().from(billing_accounts).where(eq(billing_accounts.id, id)))[0]!
const mirrorOf = async (wsId: string) =>
  (await db.select().from(organization).where(eq(organization.id, wsId)))[0]!.billingState

describe('dunning, day by day', () => {
  test('past_due: answered for 7 days; suspended on day 7 with the fixed line; one email', async () => {
    const failedAt = Date.now() - 6.5 * DAY
    const b = await billed({ status: 'past_due', past_due_since: at(failedAt) })
    const call = () => act(agent(), 'call.start', { from: randomNumber(), to: b.ws.number })
    expect((await dunning(Date.now())).suspended).not.toContain(b.billId)
    expect((await call()).body.data).toMatchObject({ blocked: false })
    const day7 = failedAt + 7 * DAY + 60_000
    expect((await dunning(day7)).suspended).toContain(b.billId)
    expect(await billNow(b.billId)).toMatchObject({ status: 'suspended', suspend_reason: 'payment' })
    expect(await mirrorOf(b.ws.id)).toBe('suspended')
    expect(emailsOf(b.billId)).toEqual([{ kind: 'suspended', cancelAt: at(failedAt + 30 * DAY) }])
    // The refused-call path: the fixed line, filed as missed with the reason.
    expect((await call()).body.data).toMatchObject({ blocked: true, refused: 'billing_inactive' })
    queued = []
    await dunning(day7 + 3_600_000)
    expect(emailsOf(b.billId)).toEqual([])
  })

  test('the first payment after the trial: suspended on day 3', async () => {
    const failedAt = Date.now() - 3 * DAY - 60_000
    const first = await billed({ status: 'past_due', past_due_since: at(failedAt), past_due_first_payment: true })
    const renewal = await billed({ status: 'past_due', past_due_since: at(failedAt) })
    const run = await dunning(Date.now())
    expect(run.suspended).toContain(first.billId)
    expect(run.suspended).not.toContain(renewal.billId)
  })

  test('paid in Stripe since (the event still on its way): not suspended', async () => {
    const b = await billed({ status: 'past_due', past_due_since: at(Date.now() - 8 * DAY) }, 'active')
    expect((await dunning(Date.now())).suspended).not.toContain(b.billId)
    expect((await billNow(b.billId)).status).toBe('past_due')
  })

  test('reminders on day 14 and 21, each once; a job that was down for both sends only the latest', async () => {
    const failedAt = Date.now() - 40 * DAY
    const b = await billed({
      status: 'suspended',
      suspend_reason: 'payment',
      past_due_since: at(failedAt),
      suspended_at: at(failedAt + 7 * DAY),
    })
    await dunning(failedAt + 13 * DAY)
    expect(emailsOf(b.billId)).toEqual([])
    await dunning(failedAt + 14 * DAY + 1000)
    expect(emailsOf(b.billId).map(e => e.kind)).toEqual(['dunning_reminder'])
    await dunning(failedAt + 15 * DAY)
    await dunning(failedAt + 21 * DAY + 1000)
    expect(emailsOf(b.billId).map(e => e.kind)).toEqual(['dunning_reminder', 'dunning_reminder'])

    const down = await billed({ status: 'suspended', suspend_reason: 'payment', past_due_since: at(failedAt) })
    await dunning(failedAt + 22 * DAY)
    expect(emailsOf(down.billId)).toHaveLength(1)
    const rows = await db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, down.billId))
    const since = (await billNow(down.billId)).past_due_since
    expect(rows.map(r => r.ref).sort()).toEqual([`${since}:d14`, `${since}:d21`])
  })

  test('day 30: our job cancels the subscription; the bill is canceled; the email names the release date', async () => {
    const failedAt = Date.now() - 31 * DAY
    const b = await billed({ status: 'suspended', suspend_reason: 'payment', past_due_since: at(failedAt) })
    const now = Date.now()
    expect((await dunning(now)).canceled).toContain(b.billId)
    expect(stripe.canceled).toEqual([b.subscriptionId])
    expect(await billNow(b.billId)).toMatchObject({ status: 'canceled', canceled_at: expect.any(String) })
    expect(emailsOf(b.billId)).toEqual([
      { kind: 'canceled', releaseAt: at(now + 30 * DAY), dataUntil: at(now + 90 * DAY) },
    ])
    expect(await mirrorOf(b.ws.id)).toBe('suspended')
    // The workspace and its data stay (readable and exportable for 90 days); nothing is deleted.
    expect(await db.select().from(calls).where(eq(calls.id, b.ws.call.id))).toHaveLength(1)
    expect(await db.select().from(member).where(eq(member.organizationId, b.ws.id))).toHaveLength(1)
  })

  test('a dispute suspension is never canceled by dunning', async () => {
    const b = await billed({
      status: 'suspended',
      suspend_reason: 'dispute',
      past_due_since: at(Date.now() - 40 * DAY),
    })
    expect((await dunning(Date.now())).canceled).not.toContain(b.billId)
    expect(stripe.canceled).toEqual([])
  })

  test('30 days after the cancellation: every number released as the billing system, the final email once', async () => {
    const canceledAt = Date.now() - 31 * DAY
    const b = await billed({ status: 'canceled', canceled_at: at(canceledAt) }, 'canceled')
    const kept = await billed({ status: 'canceled', canceled_at: at(Date.now() - 29 * DAY) }, 'canceled')
    // Bought through Linedesk on its carrier account: the numbers a cancellation releases.
    await db
      .update(phone_numbers)
      .set({ purchased: true })
      .where(inArray(phone_numbers.e164, [b.ws.number, kept.ws.number]))
    const run = await dunning(Date.now())
    expect(run.released).toContain(b.ws.number)
    expect(run.released).not.toContain(kept.ws.number)
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, b.ws.id))).toEqual([])
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'phoneNumber.release'), eq(commands.workspace_id, b.ws.id)))
    expect(logged).toMatchObject({ actor_id: 'billing:system', rejected: false })
    expect(emailsOf(b.billId)).toEqual([
      { kind: 'numbers_released', numbers: [b.ws.number], dataUntil: at(canceledAt + DUNNING.dataDays * DAY) },
    ])
    queued = []
    await dunning(Date.now())
    expect(emailsOf(b.billId)).toEqual([])
  })

  test("after a cancellation only Linedesk's own numbers go: the customer's carrier account and attached numbers stay", async () => {
    const b = await billed({ status: 'canceled', canceled_at: at(Date.now() - 31 * DAY) }, 'canceled')
    // Bought through Linedesk on its carrier account: released.
    await db.update(phone_numbers).set({ purchased: true }).where(eq(phone_numbers.e164, b.ws.number))
    // Bought on the customer's own carrier account, and one the customer attached: theirs, never released by billing.
    const own = randomNumber()
    const attached = randomNumber()
    await db.insert(phone_numbers).values([
      {
        id: rid('pn'),
        workspace_id: b.ws.id,
        e164: own,
        provider: 'dev',
        purchased: true,
        carrier_account: 'workspace',
      },
      { id: rid('pn'), workspace_id: b.ws.id, e164: attached, provider: 'dev', purchased: false },
    ])
    const run = await dunning(Date.now())
    expect(run.released).toEqual([b.ws.number])
    const left = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, b.ws.id))
    expect(left.map(n => n.e164).sort()).toEqual([own, attached].sort())
    expect(emailsOf(b.billId)).toEqual([expect.objectContaining({ kind: 'numbers_released', numbers: [b.ws.number] })])
  })

  test('a number that cannot be released does not stop the others; the failure is reported, the email waits', async () => {
    const broken = await billed({ status: 'canceled', canceled_at: at(Date.now() - 31 * DAY) }, 'canceled')
    const fine = await billed({ status: 'canceled', canceled_at: at(Date.now() - 31 * DAY) }, 'canceled')
    await db
      .update(phone_numbers)
      .set({ purchased: true })
      .where(inArray(phone_numbers.e164, [broken.ws.number, fine.ws.number]))
    // At a carrier other than the one in use (tests run on `dev`): phoneNumber.release refuses it.
    await db
      .update(phone_numbers)
      .set({ provider: 'telnyx', provider_ref: 'ref-1' })
      .where(eq(phone_numbers.e164, broken.ws.number))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = await dunning(Date.now())
    error.mockRestore()
    expect(run.released).toContain(fine.ws.number)
    expect(run.released).not.toContain(broken.ws.number)
    expect(run.failed.some(f => f.startsWith('release of '))).toBe(true)
    expect(emailsOf(broken.billId)).toEqual([])
    expect(emailsOf(fine.billId).map(e => e.kind)).toEqual(['numbers_released'])
  })

  test('billing not in effect: nothing runs', async () => {
    cloud.on = false
    const b = await billed({ status: 'past_due', past_due_since: at(Date.now() - 10 * DAY) })
    expect((await dunning(Date.now())).billing).toBe('off')
    expect((await billNow(b.billId)).status).toBe('past_due')
  })
})

describe('what the owner sees (billing.state)', () => {
  test('the bill owner and the admins of its only workspace get the banner data; members and other workspaces nothing', async () => {
    const failedAt = Date.now() - 2 * DAY
    const b = await billed({ status: 'past_due', past_due_since: at(failedAt) })
    const state = (await act(b.ws.owner, 'billing.state', {})).body.data
    expect(state.bill).toMatchObject({
      status: 'past_due',
      suspendedReason: null,
      suspendsAt: at(failedAt + 7 * DAY),
      cancelsAt: at(failedAt + 30 * DAY),
      numbersReleaseAt: null,
      dataUntil: null,
      unpaidNumbers: [],
    })
    const admin = await addMember(b.ws.id, 'admin')
    expect((await act(admin, 'billing.state', {})).body.data.bill).toMatchObject({ status: 'past_due' })
    expect((await act(await addMember(b.ws.id, 'member'), 'billing.state', {})).status).toBe(403)
    // A second workspace on the bill: its owner, who does not own the bill, gets null, and so do the admins now.
    const other = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, other.id))
    expect((await act(other.owner, 'billing.state', {})).body.data).toEqual({ bill: null })
    expect((await act(admin, 'billing.state', {})).body.data).toEqual({ bill: null })
  })

  test("a workspace moved to another bill: its unpaid number shows on the new bill's banner, not the old one's", async () => {
    const a = await billed({ status: 'active' })
    const b = await billed({ status: 'active' })
    const [number] = await db.select().from(phone_numbers).where(eq(phone_numbers.e164, a.ws.number))
    const [period] = await db.select().from(billing_periods).where(eq(billing_periods.billing_account_id, a.billId))
    await db.insert(billing_numbers).values({
      phone_number_id: number!.id,
      billing_account_id: a.billId,
      unpaid_since: at(Date.now() - DAY),
      unpaid_period_id: period!.id,
    })
    expect((await act(a.ws.owner, 'billing.state', {})).body.data.bill.unpaidNumbers).toHaveLength(1)
    // The workspace moves to bill B (owned by B's owner, who is also a member there now).
    await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, a.ws.id))
    await db.update(billing_accounts).set({ owner_user_id: a.ws.owner.userId }).where(eq(billing_accounts.id, b.billId))
    const second = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: a.billId }).where(eq(organization.id, second.id))
    await db
      .update(billing_accounts)
      .set({ owner_user_id: second.owner.userId })
      .where(eq(billing_accounts.id, a.billId))
    expect((await act(second.owner, 'billing.state', {})).body.data.bill.unpaidNumbers).toEqual([])
    expect((await act(a.ws.owner, 'billing.state', {})).body.data.bill.unpaidNumbers).toEqual([
      expect.objectContaining({ e164: a.ws.number }),
    ])
  })

  test('after a cancellation: when the numbers go and until when the data can be exported', async () => {
    const canceledAt = Date.now() - 5 * DAY
    const b = await billed({ status: 'canceled', canceled_at: at(canceledAt) })
    expect((await act(b.ws.owner, 'billing.state', {})).body.data.bill).toMatchObject({
      status: 'canceled',
      numbersReleaseAt: at(canceledAt + 30 * DAY),
      dataUntil: at(canceledAt + 90 * DAY),
    })
  })
})

describe('port-out (billing.portOutInfo, billing.recordPortOut)', () => {
  async function bought(b: Billed) {
    await db.update(phone_numbers).set({ purchased: true }).where(eq(phone_numbers.e164, b.ws.number))
    return (await db.select().from(phone_numbers).where(eq(phone_numbers.e164, b.ws.number)))[0]!
  }

  test('the bill owner gets a PIN per bought number, the same each time, stored encrypted and never logged', async () => {
    const b = await billed()
    const number = await bought(b)
    const first = await act(b.ws.owner, 'billing.portOutInfo', {})
    expect(first.status).toBe(200)
    expect(first.body.data).toMatchObject({
      stepUp: null,
      numbers: [
        { phoneNumberId: number.id, e164: number.e164, accountNumber: b.billId, pin: expect.stringMatching(/^\d{8}$/) },
      ],
    })
    const pin = first.body.data.numbers[0].pin as string
    expect((await act(b.ws.owner, 'billing.portOutInfo', {})).body.data.numbers[0].pin).toBe(pin)
    const [row] = await db.select().from(billing_numbers).where(eq(billing_numbers.phone_number_id, number.id))
    expect(row!.port_out_code).not.toContain(pin)
    const logged = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'billing.portOutInfo'), eq(commands.actor_id, b.ws.owner.userId)))
    expect(logged.length).toBe(2)
    expect(JSON.stringify(logged)).not.toContain(pin)
  })

  test('only for the workspaces they are a member of now: removed from one, its PINs are gone (decision of 2026-11-18)', async () => {
    // A bill of two workspaces, owned by a plain member of both.
    const b = await billed()
    const second = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, second.id))
    const payer = await addMember(b.ws.id, 'member')
    await auth.api.addMember({ body: { userId: payer.userId, organizationId: second.id, role: 'member' } })
    await db.update(billing_accounts).set({ owner_user_id: payer.userId }).where(eq(billing_accounts.id, b.billId))
    await db
      .update(phone_numbers)
      .set({ purchased: true })
      .where(inArray(phone_numbers.e164, [b.ws.number, second.number]))
    const inSecond: User = { ...payer, headers: { ...payer.headers, 'x-workspace-id': second.id } }
    await db.update(session).set({ activeOrganizationId: second.id }).where(eq(session.userId, payer.userId))
    const both = await act(inSecond, 'billing.portOutInfo', {})
    expect(both.status).toBe(200)
    expect(both.body.data.numbers.map((n: { e164: string }) => n.e164).sort()).toEqual(
      [b.ws.number, second.number].sort(),
    )
    // Removed from the first workspace, still the bill's owner and a member of the second.
    await db.delete(member).where(and(eq(member.userId, payer.userId), eq(member.organizationId, b.ws.id)))
    const after = await act(inSecond, 'billing.portOutInfo', {})
    expect(after.status).toBe(200)
    expect(after.body.data.numbers).toEqual([expect.objectContaining({ e164: second.number })])
    expect(JSON.stringify(after.body)).not.toContain(b.ws.number)
  })

  test('an old sign-in gets the step-up and no PIN; an admin of the workspace gets nothing', async () => {
    const b = await billed()
    await bought(b)
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 2 * DAY) })
      .where(eq(session.userId, b.ws.owner.userId))
    expect((await act(b.ws.owner, 'billing.portOutInfo', {})).body.data).toEqual({ stepUp: 'signIn', numbers: [] })
    const admin = await addMember(b.ws.id, 'admin')
    expect((await act(admin, 'billing.portOutInfo', {})).status).toBe(403)
  })

  test('an instance admin records a port-out request: the PIN is checked, both owners are emailed', async () => {
    const b = await billed()
    const number = await bought(b)
    const pin = (await act(b.ws.owner, 'billing.portOutInfo', {})).body.data.numbers[0].pin as string
    const operator = (await createWorkspace('Linedesk Operations')).owner
    const wrong = await asServerAdmin(operator, () =>
      act(operator, 'billing.recordPortOut', {
        phoneNumberId: number.id,
        pin: '00000000' === pin ? '11111111' : '00000000',
      }),
    )
    expect(wrong.body.data).toMatchObject({ e164: number.e164, billId: b.billId, pinMatches: false })
    const right = await asServerAdmin(operator, () =>
      act(operator, 'billing.recordPortOut', { phoneNumberId: number.id, pin }),
    )
    expect(right.body.data.pinMatches).toBe(true)
    const sent = queued.filter(j => j.name === BILLING_LIFECYCLE_EMAIL && j.data.bill === b.billId)
    expect(sent.at(-1)!.data).toMatchObject({
      workspace: b.ws.id,
      email: { kind: 'port_out_requested', e164: number.e164 },
    })
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'billing.recordPortOut'), eq(commands.actor_id, operator.userId)))
    expect(JSON.stringify(logged!.input)).not.toContain(pin)
    // The bill owner cannot record one.
    expect((await act(b.ws.owner, 'billing.recordPortOut', { phoneNumberId: number.id })).status).toBe(403)
  })
})

describe('bill ownership (docs/billing.md §8)', () => {
  const memberIdOf = async (workspaceId: string, who: User) =>
    (
      await db
        .select()
        .from(member)
        .where(and(eq(member.organizationId, workspaceId), eq(member.userId, who.userId)))
    )[0]!.id

  test('handing over the only workspace on a bill moves the bill with it', async () => {
    const b = await billed()
    const next = await addMember(b.ws.id, 'admin')
    expect(
      (await act(b.ws.owner, 'team.transferOwnership', { memberId: await memberIdOf(b.ws.id, next) })).status,
    ).toBe(200)
    expect((await billNow(b.billId)).owner_user_id).toBe(next.userId)
  })

  test('handing over the workspace with an old sign-in does not move the bill (the step-up of billing.handOver)', async () => {
    const b = await billed()
    const next = await addMember(b.ws.id, 'admin')
    // A session left open for two days: the step-up applies, as for billing.handOver.
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 2 * DAY) })
      .where(eq(session.userId, b.ws.owner.userId))
    const refused = await act(b.ws.owner, 'team.transferOwnership', { memberId: await memberIdOf(b.ws.id, next) })
    expect(refused.status).toBe(403)
    expect((await billNow(b.billId)).owner_user_id).toBe(b.ws.owner.userId)
    const [owner] = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, b.ws.id), eq(member.userId, b.ws.owner.userId)))
    expect(owner!.role).toBe('owner')
    expect((await act(b.ws.owner, 'billing.handOver', { userId: next.userId })).status).toBe(403)
  })

  test('with several workspaces the hand-over is refused until the bill has another owner', async () => {
    const b = await billed()
    const second = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, second.id))
    const next = await addMember(b.ws.id, 'admin')
    const refused = await act(b.ws.owner, 'team.transferOwnership', { memberId: await memberIdOf(b.ws.id, next) })
    expect(refused.status).toBe(409)
    expect((await billNow(b.billId)).owner_user_id).toBe(b.ws.owner.userId)
    // The bill first, then the workspace.
    expect((await act(b.ws.owner, 'billing.handOver', { userId: next.userId })).body.data).toMatchObject({
      billId: b.billId,
      ownerUserId: next.userId,
      previousOwnerUserId: b.ws.owner.userId,
    })
    expect(
      (await act(b.ws.owner, 'team.transferOwnership', { memberId: await memberIdOf(b.ws.id, next) })).status,
    ).toBe(200)
    expect((await billNow(b.billId)).owner_user_id).toBe(next.userId)
  })

  const SWITCHED_OFF = {
    level: 'standard',
    llmModel: null,
    realtimeModel: null,
  }

  test("the new bill owner of a hand-over gets the old payer's Premium and Ultra moved to Standard on every workspace (LIN-438)", async () => {
    const b = await billed()
    const second = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, second.id))
    await withPremiumAndUltra(b.ws)
    await withPremiumAndUltra(second)
    const next = await addMember(b.ws.id, 'admin')
    const done = await act(b.ws.owner, 'billing.handOver', { userId: next.userId })
    expect(done.status).toBe(200)
    expect([...done.body.data.payerReset.workspaceIds].sort()).toEqual([b.ws.id, second.id].sort())
    // The app gets its own workspace's assistant back at once, never another workspace's.
    expect(done.body.rows.assistants.map((a: { id: string }) => a.id)).toEqual([b.ws.assistant.id])
    for (const w of [b.ws, second]) expect(await premiumAndUltraOf(w)).toMatchObject(SWITCHED_OFF)
  })

  test("handing over the only workspace moves the bill and the old payer's Premium and Ultra to Standard (LIN-438)", async () => {
    const b = await billed()
    await withPremiumAndUltra(b.ws)
    const next = await addMember(b.ws.id, 'admin')
    const done = await act(b.ws.owner, 'team.transferOwnership', { memberId: await memberIdOf(b.ws.id, next) })
    expect(done.status).toBe(200)
    expect(done.body.data.payerReset.workspaceIds).toEqual([b.ws.id])
    expect((await billNow(b.billId)).owner_user_id).toBe(next.userId)
    expect(await premiumAndUltraOf(b.ws)).toMatchObject(SWITCHED_OFF)
  })

  test('the new bill owner is a member of one of its workspaces with a confirmed address', async () => {
    const b = await billed()
    const stranger = (await createWorkspace('Someone Else')).owner
    expect((await act(b.ws.owner, 'billing.handOver', { userId: stranger.userId })).status).toBe(409)
    const unconfirmed = await addMember(b.ws.id, 'member')
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, unconfirmed.userId))
    expect((await act(b.ws.owner, 'billing.handOver', { userId: unconfirmed.userId })).status).toBe(409)
    // A workspace owner who is not the bill owner cannot hand it over.
    const other = await createWorkspace('Brightwater North')
    await db.update(organization).set({ billingAccountId: b.billId }).where(eq(organization.id, other.id))
    expect((await act(other.owner, 'billing.handOver', { userId: other.owner.userId })).status).toBe(403)
  })

  test("deleting a running bill's owner is refused; a canceled bill's owner can go", async () => {
    const running = await billed()
    await expect(db.transaction(tx => refuseDeletingBillOwners(tx, [running.ws.owner.userId]))).rejects.toThrow(
      /hand the bill/,
    )
    const deleted = await act(running.ws.owner, 'workspace.deleteOwn', { name: 'Brightwater Plumbing & Heating' })
    expect(deleted.status).toBe(409)
    expect(await db.select().from(organization).where(eq(organization.id, running.ws.id))).toHaveLength(1)
    const canceled = await billed({ status: 'canceled', canceled_at: at(Date.now()) })
    await db.transaction(tx => refuseDeletingBillOwners(tx, [canceled.ws.owner.userId]))
  })
})
