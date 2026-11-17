// Charging an auto-recharge (src/billing-recharge.ts, docs/billing.md §2.2 and §3.4): the job charges a pending
// attempt through the billing provider (a fake here; the Stripe adapter has its own contract tests), never credits
// it, and applies the failed-recharge rules: automatic collection off before the attempt is marked, a decline voided
// (`canceled`), 3DS kept open (`failed`), the bill waiting for a new card, and the owner emailed once per invoice.
import { type BillingProvider, BillingSetupError, type RechargeInvoiceInput } from '@linedesk/billing'
import { billing_accounts, billing_alerts, billing_recharges, instance_settings, ledger_entries } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { chargeRecharge, rechargeGaveUp, rechargeSetupAlertKey, sendBillingAlert } from '../src/billing-recharge.ts'
import { db } from '../src/db.ts'
import type { Email, EmailSender } from '../src/email.ts'
import { setJobQueue } from '../src/jobs.ts'
import { createWorkspace } from './helpers.ts'

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

let queued: { name: string; data: Record<string, unknown> }[] = []
beforeEach(() => {
  queued = []
  setJobQueue({
    send: async (name: string, data: Record<string, unknown>) => {
      queued.push({ name, data })
      return 'job'
    },
  } as never)
})
afterEach(() => setJobQueue(null))

/** A fake billing provider: answers `charge` and records every request. */
function fakeProvider(charge: (input: RechargeInvoiceInput) => Awaited<ReturnType<BillingProvider['chargeRecharge']>>) {
  const calls: { method: string; args: unknown[] }[] = []
  const provider: BillingProvider = {
    name: 'stripe',
    account: async () => null,
    chargeRecharge: async input => {
      calls.push({ method: 'chargeRecharge', args: [input] })
      return charge(input)
    },
    findRechargeInvoice: async id => {
      calls.push({ method: 'findRechargeInvoice', args: [id] })
      return 'in_found'
    },
    stopRechargeInvoice: async (id, options) => {
      calls.push({ method: 'stopRechargeInvoice', args: [id, options] })
    },
    rechargeInvoicePage: async id => `https://invoice.stripe.com/i/${id}`,
    // Settings › Billing's portal (PR 9) is not used here.
    portalSession: () => Promise.reject(new Error('not used')),
    rechargeCard: async () => null,
    checkoutPaymentMethodConfiguration: async () => null,
    // The lifecycle side (PR 10/11) is not used here.
    dispute: async () => null,
    earlyFraudWarning: async () => null,
    charge: async () => null,
    // The webhook side (PR 5) is not used here.
    webhookEvent: () => {
      throw new Error('not used')
    },
    invoice: async () => null,
    subscription: async () => null,
    recentEvents: async () => ({ events: [], truncated: false }),
    // Server admin's refunds and seats (PR 13) are not used here.
    refundBlockers: async () => [],
    refundInvoice: () => {
      throw new Error('not used')
    },
    findRefund: async () => null,
    checkoutInvoice: async () => null,
    setSeatQuantity: async () => 'unchanged',
    setExtraCallsQuantity: async () => 'unchanged',
    // Trial Checkout (PR 8) is not used here.
    createCustomer: async () => {
      throw new Error('not used')
    },
    startCheckout: async () => {
      throw new Error('not used')
    },
    syncCatalog: async () => {
      throw new Error('not used')
    },
    catalogWriteAccess: async () => ({ products: null, prices: null }),
    portalWriteAccess: async () => null,
    checkoutTermsReady: async () => null,
    syncPortal: async () => ({ configuration: 'bpc_test', changed: false }),
    expireOpenCheckouts: async () => {
      throw new Error('not used')
    },
    customerPurchases: async () => {
      throw new Error('not used')
    },
    deleteCustomer: async () => {
      throw new Error('not used')
    },
    checkoutSession: async () => null,
    cancelSubscription: async () => null,
    resumeSubscription: async () => null,
    addInvoiceItem: async () => {
      throw new Error('not used')
    },
  }
  return { provider, calls }
}

async function pendingRecharge(over: Partial<typeof billing_accounts.$inferInsert> = {}, createdAt?: string) {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const billId = rid('bill')
  await db.insert(billing_accounts).values({
    id: billId,
    kind: 'cloud',
    owner_user_id: ws.owner.userId,
    status: 'active',
    stripe_customer_id: rid('cus'),
    ...over,
  })
  const [attempt] = await db
    .insert(billing_recharges)
    .values({
      id: rid('rc'),
      billing_account_id: billId,
      amount_cents: 2000,
      ...(createdAt ? { created_at: createdAt } : {}),
    })
    .returning()
  return { ws, billId, attempt: attempt! }
}
const attemptOf = async (id: string) =>
  (await db.select().from(billing_recharges).where(eq(billing_recharges.id, id)))[0]!
const billOf = async (id: string) => (await db.select().from(billing_accounts).where(eq(billing_accounts.id, id)))[0]!

describe('the recharge job', () => {
  test('charges the attempt once with its id as the key, stores the invoice, and credits nothing (the webhook does)', async () => {
    const r = await pendingRecharge()
    const { provider, calls } = fakeProvider(() => ({ status: 'paid', invoiceId: 'in_paid' }))
    expect(await chargeRecharge(db, r.attempt.id, { provider })).toEqual({ outcome: 'paid', invoiceId: 'in_paid' })
    const [charge] = calls
    expect(charge).toEqual({
      method: 'chargeRecharge',
      args: [
        {
          customerId: (await billOf(r.billId)).stripe_customer_id,
          amountCents: 2000,
          rechargeId: r.attempt.id,
          description: 'Linedesk balance recharge',
          invoiceId: null,
          subscriptionId: null,
        },
      ],
    })
    expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'pending', stripe_invoice_id: 'in_paid' })
    expect(await db.select().from(ledger_entries).where(eq(ledger_entries.billing_account_id, r.billId))).toEqual([])
    // A retry charges the invoice it already made, never a new one.
    await chargeRecharge(db, r.attempt.id, { provider })
    expect((calls[1]!.args[0] as RechargeInvoiceInput).invoiceId).toBe('in_paid')
  })

  test('the bill’s subscription goes with the charge, so the card Checkout saved on it is charged (billing review B1)', async () => {
    const r = await pendingRecharge({ stripe_subscription_id: rid('sub') })
    const { provider, calls } = fakeProvider(() => ({ status: 'paid', invoiceId: rid('in') }))
    await chargeRecharge(db, r.attempt.id, { provider })
    expect((calls[0]!.args[0] as RechargeInvoiceInput).subscriptionId).toBe(
      (await billOf(r.billId)).stripe_subscription_id,
    )
  })

  test('a decline: collection off and the invoice voided before the attempt is canceled; the bill waits; the owner emailed once', async () => {
    const r = await pendingRecharge()
    const { provider, calls } = fakeProvider(() => ({
      status: 'failed',
      invoiceId: 'in_declined',
      failureCode: 'insufficient_funds',
    }))
    const now = '2026-11-16T12:00:00.000Z'
    expect(await chargeRecharge(db, r.attempt.id, { provider, now: () => now })).toEqual({
      outcome: 'failed',
      invoiceId: 'in_declined',
    })
    expect(calls.map(c => c.method)).toEqual(['chargeRecharge', 'stopRechargeInvoice'])
    expect(calls[1]!.args).toEqual(['in_declined', { void: true }])
    expect(await attemptOf(r.attempt.id)).toMatchObject({
      status: 'canceled',
      failure_code: 'insufficient_funds',
      stripe_invoice_id: 'in_declined',
    })
    expect(Date.parse((await attemptOf(r.attempt.id)).resolved_at!)).toBe(Date.parse(now))
    expect(Date.parse((await billOf(r.billId)).recharge_failed_at!)).toBe(Date.parse(now))
    expect(await db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, r.billId))).toMatchObject(
      [{ kind: 'recharge_failed', ref: 'in_declined' }],
    )
    expect(queued).toEqual([
      {
        name: 'billing.alert',
        data: {
          kind: 'recharge_failed',
          bill: r.billId,
          ref: 'in_declined',
          rechargeId: r.attempt.id,
          needsOwner: false,
        },
      },
    ])
    // Settled: a second run does nothing.
    expect(await chargeRecharge(db, r.attempt.id, { provider })).toEqual({ outcome: 'not_pending' })
  })

  test('3DS needed: collection off, the invoice stays open, the attempt is failed (still in the cap)', async () => {
    const r = await pendingRecharge()
    const { provider, calls } = fakeProvider(() => ({
      status: 'failed',
      invoiceId: 'in_3ds',
      failureCode: 'authentication_required',
    }))
    await chargeRecharge(db, r.attempt.id, { provider })
    expect(calls[1]!.args).toEqual(['in_3ds', { void: false }])
    expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'failed', failure_code: 'authentication_required' })
    expect(queued[0]!.data).toMatchObject({ kind: 'recharge_failed', needsOwner: true })
  })

  test('billing off, no Stripe customer, or auto-recharge turned off since: canceled before anything is charged', async () => {
    const none = await pendingRecharge()
    const off: BillingProvider = { ...fakeProvider(() => ({ status: 'paid', invoiceId: 'x' })).provider, name: 'none' }
    expect(await chargeRecharge(db, none.attempt.id, { provider: off })).toEqual({
      outcome: 'canceled',
      reason: 'billing_off',
    })
    expect(await attemptOf(none.attempt.id)).toMatchObject({ status: 'canceled', failure_code: 'billing_off' })
    const { provider, calls } = fakeProvider(() => ({ status: 'paid', invoiceId: 'x' }))
    const noCustomer = await pendingRecharge({ stripe_customer_id: null })
    expect(await chargeRecharge(db, noCustomer.attempt.id, { provider })).toMatchObject({ reason: 'no_customer' })
    const autoOff = await pendingRecharge({ auto_recharge: false })
    expect(await chargeRecharge(db, autoOff.attempt.id, { provider })).toMatchObject({ reason: 'bill_inactive' })
    expect(calls).toEqual([])
  })

  test('an attempt older than the idempotency keys looks for its invoice before charging', async () => {
    const r = await pendingRecharge({}, new Date(Date.now() - 30 * 3600_000).toISOString())
    const { provider, calls } = fakeProvider(() => ({ status: 'open', invoiceId: 'in_found' }))
    await chargeRecharge(db, r.attempt.id, { provider })
    expect(calls.map(c => c.method)).toEqual(['findRechargeInvoice', 'chargeRecharge'])
    expect((calls[1]!.args[0] as RechargeInvoiceInput).invoiceId).toBe('in_found')
  })

  test('a network failure throws, so the job tries again, and leaves the attempt pending', async () => {
    const r = await pendingRecharge()
    const { provider } = fakeProvider(() => {
      throw new Error('ECONNRESET')
    })
    await expect(chargeRecharge(db, r.attempt.id, { provider })).rejects.toThrow('ECONNRESET')
    expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'pending', stripe_invoice_id: null })
  })
})

describe('the job’s last retry failed (review L3)', () => {
  test('with an invoice: the failed-recharge rules (collection off, voided, the owner emailed); then settled', async () => {
    const r = await pendingRecharge()
    await db
      .update(billing_recharges)
      .set({ stripe_invoice_id: 'in_stuck' })
      .where(eq(billing_recharges.id, r.attempt.id))
    const { provider, calls } = fakeProvider(() => ({ status: 'paid', invoiceId: 'x' }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await rechargeGaveUp(db, r.attempt.id, { provider })
    error.mockRestore()
    expect(calls.map(c => c.method)).toEqual(['stopRechargeInvoice'])
    expect(calls[0]!.args).toEqual(['in_stuck', { void: true }])
    expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'canceled', failure_code: 'stripe_error' })
    expect((await billOf(r.billId)).recharge_failed_at).not.toBeNull()
    expect(queued).toMatchObject([{ name: 'billing.alert', data: { kind: 'recharge_failed', ref: 'in_stuck' } }])
  })

  test('without an invoice it looks for one; none found: the attempt is canceled so a later decision may try again', async () => {
    const r = await pendingRecharge()
    const { provider, calls } = fakeProvider(() => ({ status: 'paid', invoiceId: 'x' }))
    const none: BillingProvider = {
      ...provider,
      findRechargeInvoice: async id => {
        calls.push({ method: 'find', args: [id] })
        return null
      },
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await rechargeGaveUp(db, r.attempt.id, { provider: none })
    error.mockRestore()
    expect(calls.map(c => c.method)).toEqual(['find'])
    expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'canceled', failure_code: 'stripe_error' })
    expect((await billOf(r.billId)).recharge_failed_at).toBeNull()
  })

  test('on our own setup error (401/403/404): canceled, the admins alerted, never the owner (recheck of #864, L2)', async () => {
    const r = await pendingRecharge()
    await db
      .update(billing_recharges)
      .set({ stripe_invoice_id: 'in_setup' })
      .where(eq(billing_recharges.id, r.attempt.id))
    const { provider, calls } = fakeProvider(() => ({ status: 'paid', invoiceId: 'x' }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await rechargeGaveUp(db, r.attempt.id, { provider, setupError: new BillingSetupError('stripe_403') })
    error.mockRestore()
    expect(calls.map(c => c.method)).toEqual(['stopRechargeInvoice'])
    expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'canceled', failure_code: 'stripe_403' })
    expect((await billOf(r.billId)).recharge_failed_at).toBeNull()
    expect(await db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, r.billId))).toEqual([])
    expect(queued).toMatchObject([
      {
        name: 'billing.alert',
        data: { kind: 'recharge_setup', bill: r.billId, rechargeId: r.attempt.id, code: 'stripe_403' },
      },
    ])
    // The alert goes to the instance admins, not the bill owner.
    const sent: Email[] = []
    const sender: EmailSender = { send: async e => void sent.push(e) } as EmailSender
    expect(await sendBillingAlert(db, sender, queued[0]!.data as never)).toEqual({ sent: 'admins' })
  })

  test('the setup alert goes out once per install and error code a day, not once per bill (recheck of #865, L-B)', async () => {
    const code = `stripe_${rid('t')}`
    const { provider } = fakeProvider(() => ({ status: 'paid', invoiceId: 'x' }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const giveUp = async (c: string) => {
      const r = await pendingRecharge()
      await rechargeGaveUp(db, r.attempt.id, { provider, setupError: new BillingSetupError(c) })
      expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'canceled', failure_code: c })
    }
    const alerts = () => queued.filter(q => q.data.kind === 'recharge_setup')
    await giveUp(code)
    await giveUp(code)
    await giveUp(code)
    expect(alerts().map(q => q.data.code)).toEqual([code])
    // Another code is its own alert.
    await giveUp(`${code}_other`)
    expect(alerts().map(q => q.data.code)).toEqual([code, `${code}_other`])
    // A day later the same code alerts again.
    await db
      .update(instance_settings)
      .set({ updated_at: new Date(Date.now() - 25 * 3_600_000).toISOString() })
      .where(eq(instance_settings.key, rechargeSetupAlertKey(code)))
    await giveUp(code)
    error.mockRestore()
    expect(alerts().map(q => q.data.code)).toEqual([code, `${code}_other`, code])
  })
})

describe('the owner’s billing emails', () => {
  const capture = () => {
    const sent: Email[] = []
    const sender: EmailSender = { kind: 'smtp', send: async email => void sent.push(email) } as EmailSender
    return { sent, sender }
  }

  test('a recharge that needs 3DS links to the invoice page, fetched when the email goes out', async () => {
    const r = await pendingRecharge()
    const { sent, sender } = capture()
    const { provider } = fakeProvider(() => ({ status: 'paid', invoiceId: 'x' }))
    await sendBillingAlert(
      db,
      sender,
      { kind: 'recharge_failed', bill: r.billId, ref: 'in_3ds', rechargeId: r.attempt.id, needsOwner: true },
      { provider },
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).toBe('Your Linedesk balance could not be recharged')
    expect(sent[0]!.text).toContain('$20.00')
    expect(sent[0]!.text).toContain('$5.00 below zero')
    expect(sent[0]!.text).toContain('https://invoice.stripe.com/i/in_3ds')
  })

  test('the cap and a low balance', async () => {
    const r = await pendingRecharge({ auto_recharge: false })
    const { sent, sender } = capture()
    await sendBillingAlert(db, sender, { kind: 'recharge_cap_reached', bill: r.billId, ref: '2026-11' })
    await sendBillingAlert(db, sender, { kind: 'low_balance', bill: r.billId, ref: 'start' })
    expect(sent.map(e => e.subject)).toEqual([
      'Your Linedesk balance reached its monthly recharge cap',
      'Your Linedesk balance is low',
    ])
    expect(sent[0]!.text).toContain('$50.00')
  })

  test('the cap email says what was recharged, not that the whole cap was (billing review B7)', async () => {
    // $40 recharged in November (two $20 attempts, paid and pending), one canceled and one from October not counted:
    // the $10 left is under the $20 minimum, so the cap counts as reached.
    const r = await pendingRecharge({}, '2026-11-05T10:00:00.000Z')
    await db
      .update(billing_recharges)
      .set({ status: 'paid', resolved_at: '2026-11-05T10:01:00.000Z' })
      .where(eq(billing_recharges.id, r.attempt.id))
    const add = (status: 'pending' | 'canceled' | 'paid', created_at: string) =>
      db.insert(billing_recharges).values({
        id: rid('rc'),
        billing_account_id: r.billId,
        amount_cents: 2000,
        status,
        created_at,
        resolved_at: status === 'pending' ? null : created_at,
      })
    await add('pending', '2026-11-20T10:00:00.000Z')
    await add('canceled', '2026-11-21T10:00:00.000Z')
    await add('paid', '2026-10-30T10:00:00.000Z')
    const { sent, sender } = capture()
    await sendBillingAlert(db, sender, { kind: 'recharge_cap_reached', bill: r.billId, ref: '2026-11' })
    expect(sent[0]!.text).toContain('Automatic recharges came to $40.00 this month')
    expect(sent[0]!.text).toContain('your monthly recharge cap of $50.00 is less than the smallest recharge')
    expect(sent[0]!.text).toContain('the smallest recharge is $20.00')
    expect(sent[0]!.text).not.toContain('recharged up to')
  })
})
