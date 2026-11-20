// Charging an auto-recharge (src/billing-recharge.ts): the job charges a pending
// attempt through the billing provider (a fake here; the Stripe adapter has its own contract tests), never credits
// it, and applies the failed-recharge rules: automatic collection off before the attempt is marked, a decline voided
// (`canceled`), 3DS kept open (`failed`), the bill waiting for a new card, and the owner emailed once per invoice.
import { type BillingProvider, BillingSetupError, type RechargeInvoiceInput } from '@linedesk/billing'
import { billing_accounts, billing_alerts, billing_recharges, instance_settings, ledger_entries } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { chargeRecharge, rechargeGaveUp, rechargeSetupAlertKey, sendBillingAlert } from '../src/billing-recharge.ts'
import { BILLING_RULES_KEY } from '../src/billing-rules.ts'
import {
  customersWithoutTaxAddress,
  resetTaxAddressCount,
  TAX_ADDRESS_COUNT_MS,
  TAX_ADDRESS_FAILED_MS,
} from '../src/billing-tax.ts'
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

/** Whether the fake's customers have an address Stripe Tax can use (`customerTaxReady`). */
const fakeTax = { ready: true }
beforeEach(() => {
  fakeTax.ready = true
})

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
      return 'stopped'
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
    setPlanInterval: async () => 'unchanged',
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
    taxSetup: async () => null,
    customerTaxReady: async () => fakeTax.ready,
    customersWithoutTaxAddress: async () => 0,
    syncSubscriptionTax: async () => 'unchanged',
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
    // A bill whose owner turned auto-recharge on (it starts off since 2026-11-17).
    auto_recharge: true,
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
          // Stripe Tax on by default (a self-hoster turns it off): tax on top, the item carries our code.
          tax: { automatic: true, code: 'txcd_10103001' },
          // Stores the invoice's id on the attempt as soon as it exists (review #1110, R-1).
          onInvoice: expect.any(Function),
        },
      ],
    })
    expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'pending', stripe_invoice_id: 'in_paid', tax: 'on' })
    expect(await db.select().from(ledger_entries).where(eq(ledger_entries.billing_account_id, r.billId))).toEqual([])
    // A retry charges the invoice it already made, never a new one.
    await chargeRecharge(db, r.attempt.id, { provider })
    expect((calls[1]!.args[0] as RechargeInvoiceInput).invoiceId).toBe('in_paid')
  })

  test('the tax is decided at the first try and kept: a retry after the switch changed sends the same invoice (review #1105, L-1)', async () => {
    const r = await pendingRecharge()
    let tries = 0
    const { provider, calls } = fakeProvider(() => {
      if (++tries === 1) throw new Error('network')
      return { status: 'paid', invoiceId: rid('in') }
    })
    await expect(chargeRecharge(db, r.attempt.id, { provider })).rejects.toThrow('network')
    expect((await attemptOf(r.attempt.id)).tax).toBe('on')
    await db
      .insert(instance_settings)
      .values({ key: BILLING_RULES_KEY, value: JSON.stringify({ automaticTax: false }) })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value: JSON.stringify({ automaticTax: false }) } })
    try {
      await chargeRecharge(db, r.attempt.id, { provider })
      expect(calls.map(c => (c.args[0] as RechargeInvoiceInput).tax.automatic)).toEqual([true, true])
      // A new attempt follows the switch as it is now.
      const next = await pendingRecharge()
      await chargeRecharge(db, next.attempt.id, { provider })
      expect((calls[2]!.args[0] as RechargeInvoiceInput).tax.automatic).toBe(false)
      expect((await attemptOf(next.attempt.id)).tax).toBe('off')
    } finally {
      await db.delete(instance_settings).where(eq(instance_settings.key, BILLING_RULES_KEY))
    }
  })

  test('tax on, but the customer has no address: charged without tax rather than refused, never a stop (review #1105, M-1)', async () => {
    fakeTax.ready = false
    const r = await pendingRecharge()
    const { provider, calls } = fakeProvider(() => ({ status: 'paid', invoiceId: rid('in') }))
    expect(await chargeRecharge(db, r.attempt.id, { provider })).toMatchObject({ outcome: 'paid' })
    expect((calls[0]!.args[0] as RechargeInvoiceInput).tax).toEqual({ automatic: false, code: 'txcd_10103001' })
    expect(await attemptOf(r.attempt.id)).toMatchObject({ tax: 'no_address' })
    expect((await billOf(r.billId)).recharge_failed_at).toBeNull()
  })

  test('Stripe refuses the invoice itself (a 400 at create): the owner path once, nothing to stop (review #1105, L-3)', async () => {
    const r = await pendingRecharge()
    const { provider, calls } = fakeProvider(() => ({
      status: 'failed',
      invoiceId: null,
      failureCode: 'stripe_customer_tax_location_invalid',
    }))
    const now = '2026-11-16T12:00:00.000Z'
    expect(await chargeRecharge(db, r.attempt.id, { provider, now: () => now })).toEqual({
      outcome: 'failed',
      invoiceId: null,
    })
    expect(calls.map(c => c.method)).toEqual(['chargeRecharge'])
    expect(await attemptOf(r.attempt.id)).toMatchObject({
      status: 'canceled',
      failure_code: 'stripe_customer_tax_location_invalid',
      stripe_invoice_id: null,
    })
    // The bill waits for the owner (no new attempt per call), and the owner is emailed once, keyed by the attempt.
    expect(Date.parse((await billOf(r.billId)).recharge_failed_at!)).toBe(Date.parse(now))
    expect(await db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, r.billId))).toMatchObject(
      [{ kind: 'recharge_failed', ref: r.attempt.id }],
    )
    expect(queued).toEqual([
      {
        name: 'billing.alert',
        data: {
          kind: 'recharge_failed',
          bill: r.billId,
          ref: r.attempt.id,
          rechargeId: r.attempt.id,
          needsOwner: false,
        },
      },
    ])
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

  test('Stripe Tax not set up on our account: the admins hear of it once, the owner is neither emailed nor stopped (review #1105, N-2)', async () => {
    // The adapter turns an account-side 400 (stripe_tax_inactive) into a setup error (billing.test.ts); every bill's
    // recharge would fail alike, so none of them takes the owner's failed-recharge path.
    const code = `stripe_stripe_tax_inactive_${rid('t')}`
    const { provider } = fakeProvider(() => {
      throw new BillingSetupError(code)
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bills: string[] = []
    for (let i = 0; i < 2; i++) {
      const r = await pendingRecharge()
      bills.push(r.billId)
      // Each try throws, so the job tries again; the attempt stays pending meanwhile (no new attempt per call).
      await expect(chargeRecharge(db, r.attempt.id, { provider })).rejects.toBeInstanceOf(BillingSetupError)
      expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'pending' })
      // The job's last retry (jobs.ts): given up as a setup error.
      await rechargeGaveUp(db, r.attempt.id, { provider, setupError: new BillingSetupError(code) })
      expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'canceled', failure_code: code })
    }
    error.mockRestore()
    for (const bill of bills) {
      // Not stopped at the buffer waiting for a Retry, and no owner email: a later decision makes a new attempt.
      expect((await billOf(bill)).recharge_failed_at).toBeNull()
      expect(await db.select().from(billing_alerts).where(eq(billing_alerts.billing_account_id, bill))).toEqual([])
    }
    expect(queued.map(q => q.data.kind)).toEqual(['recharge_setup'])
    const sent: Email[] = []
    const sender: EmailSender = { send: async e => void sent.push(e) } as EmailSender
    expect(await sendBillingAlert(db, sender, queued[0]!.data as never)).toEqual({ sent: 'admins' })
  })
})

describe('an account refusal after the invoice exists (review #1110, R-1)', () => {
  test('the invoice id is kept as soon as it exists; the give-up voids that invoice, never leaves it for Stripe to charge', async () => {
    const r = await pendingRecharge()
    const invoiceId = rid('in')
    const code = `stripe_stripe_tax_inactive_${rid('t')}`
    // Like the adapter: the invoice is made (and reported), then finalize or pay is refused for our own account.
    const { provider, calls } = fakeProvider(() => {
      throw new Error('not used')
    })
    provider.chargeRecharge = async input => {
      calls.push({ method: 'chargeRecharge', args: [input] })
      await input.onInvoice?.(invoiceId)
      throw new BillingSetupError(code)
    }
    await expect(chargeRecharge(db, r.attempt.id, { provider })).rejects.toBeInstanceOf(BillingSetupError)
    expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'pending', stripe_invoice_id: invoiceId })
    // The job's next try charges that invoice again instead of making a new one.
    await expect(chargeRecharge(db, r.attempt.id, { provider })).rejects.toBeInstanceOf(BillingSetupError)
    expect((calls[1]!.args[0] as RechargeInvoiceInput).invoiceId).toBe(invoiceId)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await rechargeGaveUp(db, r.attempt.id, { provider, setupError: new BillingSetupError(code) })
    error.mockRestore()
    expect(calls.filter(c => c.method === 'stopRechargeInvoice').map(c => c.args)).toEqual([
      [invoiceId, { void: true }],
    ])
    expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'canceled', failure_code: code })
    expect((await billOf(r.billId)).recharge_failed_at).toBeNull()
  })

  test('an invoice the attempt does not name yet is looked up in Stripe and voided too', async () => {
    const r = await pendingRecharge()
    const { provider, calls } = fakeProvider(() => ({ status: 'paid', invoiceId: 'x' }))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await rechargeGaveUp(db, r.attempt.id, { provider, setupError: new BillingSetupError(`stripe_x_${rid('t')}`) })
    // Stripe not answering the lookup: the attempt is still given up (the stuck and not-credited alerts remain).
    const r2 = await pendingRecharge()
    const down: BillingProvider = {
      ...provider,
      findRechargeInvoice: async () => {
        throw new Error('ECONNRESET')
      },
    }
    await rechargeGaveUp(db, r2.attempt.id, { provider: down, setupError: new BillingSetupError('stripe_y') })
    error.mockRestore()
    expect(calls.map(c => [c.method, ...c.args])).toEqual([
      ['findRechargeInvoice', r.attempt.id],
      ['stopRechargeInvoice', 'in_found', { void: true }],
    ])
    expect(await attemptOf(r.attempt.id)).toMatchObject({ status: 'canceled' })
    expect(await attemptOf(r2.attempt.id)).toMatchObject({ status: 'canceled', failure_code: 'stripe_y' })
  })
})

describe('the count of paying customers without a tax address (review #1105, N-1)', () => {
  beforeEach(() => resetTaxAddressCount())

  test('asks Stripe for the running bills’ customers only, keeps the answer for some minutes, and says null when Stripe fails', async () => {
    const running = await pendingRecharge({ stripe_customer_id: rid('cus') })
    const ended = await pendingRecharge({ status: 'canceled', stripe_customer_id: rid('cus') })
    const asked: string[][] = []
    const { provider } = fakeProvider(() => ({ status: 'paid', invoiceId: 'x' }))
    provider.customersWithoutTaxAddress = async ids => {
      asked.push(ids)
      return 3
    }
    const now = Date.parse('2026-11-17T12:00:00.000Z')
    expect(await customersWithoutTaxAddress(db, { provider, now })).toBe(3)
    const runningCustomer = (await billOf(running.billId)).stripe_customer_id!
    const endedCustomer = (await billOf(ended.billId)).stripe_customer_id!
    expect(asked[0]).toContain(runningCustomer)
    expect(asked[0]).not.toContain(endedCustomer)
    // Opened again within the 5 minutes: the same answer, Stripe not asked again.
    expect(await customersWithoutTaxAddress(db, { provider, now: now + TAX_ADDRESS_COUNT_MS - 1 })).toBe(3)
    expect(asked).toHaveLength(1)
    // Later, or once the paying customers changed: asked again.
    expect(await customersWithoutTaxAddress(db, { provider, now: now + TAX_ADDRESS_COUNT_MS })).toBe(3)
    expect(asked).toHaveLength(2)
    await pendingRecharge({ stripe_customer_id: rid('cus') })
    expect(await customersWithoutTaxAddress(db, { provider, now: now + TAX_ADDRESS_COUNT_MS })).toBe(3)
    expect(asked).toHaveLength(3)
    // Stripe not answering: not known (null). Kept for a minute too, so an admin key asking in a loop does not send a
    // read per customer on every call (review #1110, R-3); asked again after that.
    let failures = 0
    provider.customersWithoutTaxAddress = async () => {
      failures++
      throw new Error('ECONNRESET')
    }
    resetTaxAddressCount()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await customersWithoutTaxAddress(db, { provider, now })).toBeNull()
    expect(await customersWithoutTaxAddress(db, { provider, now: now + TAX_ADDRESS_FAILED_MS - 1 })).toBeNull()
    expect(failures).toBe(1)
    expect(await customersWithoutTaxAddress(db, { provider, now: now + TAX_ADDRESS_FAILED_MS })).toBeNull()
    expect(failures).toBe(2)
    error.mockRestore()
  })

  test('calls at the same time share one count: Stripe is asked once (review #1110, R-3)', async () => {
    await pendingRecharge({ stripe_customer_id: rid('cus') })
    const { provider } = fakeProvider(() => ({ status: 'paid', invoiceId: 'x' }))
    let asked = 0
    let answer!: (n: number) => void
    provider.customersWithoutTaxAddress = () => {
      asked++
      return new Promise<number>(resolve => {
        answer = resolve
      })
    }
    const now = Date.parse('2026-11-17T12:00:00.000Z')
    const first = customersWithoutTaxAddress(db, { provider, now })
    await vi.waitFor(() => expect(asked).toBe(1))
    // A second call while the first is still asking Stripe: given time to reach the shared count, then answered.
    const second = customersWithoutTaxAddress(db, { provider, now })
    await new Promise(resolve => setTimeout(resolve, 50))
    answer(4)
    expect(await Promise.all([first, second])).toEqual([4, 4])
    expect(asked).toBe(1)
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
