// Billing for Linedesk Cloud (docs/billing.md). The instance switch: billing runs only when Stripe is connected under
// Server admin › Providers › Billing and an instance admin turned it on here. Off by default, so a self-hosted install
// never bills anyone, even with keys stored.
import { z } from 'zod'
import { defineAction } from './define.ts'

export const billingEnabledGet = defineAction({
  name: 'billingEnabled.get',
  description:
    'Whether this install bills workspaces through Stripe: the switch (off by default), whether Stripe keys are connected, and their mode (test or live).',
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})
export const billingEnabledSet = defineAction({
  name: 'billingEnabled.set',
  description:
    'Turn billing through Stripe on or off for this install. On needs Stripe keys under Providers › Billing and binds billing to their Stripe account and mode; live keys only where the server allows them. Off: nothing is billed and every billing path stays closed. `rebind`: turn on with keys of another account or mode than before (its customers are not there).',
  input: z.object({ on: z.boolean(), rebind: z.boolean().optional() }),
  permission: 'instance:admin',
})
/** A Stripe event id (`evt_…`), as the webhook inbox stores it. */
const stripeEventId = z.string().regex(/^evt_[A-Za-z0-9]{1,250}$/, 'a Stripe event id (evt_…)')

/**
 * Processes one stored Stripe event (docs/billing.md §5.1): fetches the object from Stripe and acts on it for the bill
 * it belongs to. Only the API's billing jobs run it (`billing:system`); nobody signed in can.
 */
export const billingProcessStripeEvent = defineAction({
  name: 'billing.processStripeEvent',
  description:
    'Process one Stripe event from the webhook inbox: fetch its object from Stripe and apply it to the bill it belongs to. Billing jobs only.',
  input: z.object({ eventId: stripeEventId }),
  permission: 'billing:system',
})

/**
 * Credits a paid recharge invoice from Stripe's current state (the nightly reconciliation, for an attempt pending more
 * than a day), like `invoice.paid`. `customerId` finds the bill when the attempt has not stored the invoice id. A failed
 * or voided invoice goes through the failed-recharge rules instead (not this action). Billing jobs only.
 */
export const billingSettleInvoice = defineAction({
  name: 'billing.settleInvoice',
  description:
    'Settle a paid recharge invoice from its state in Stripe: credit it once when it is really paid. Billing jobs only.',
  input: z.object({
    invoiceId: z.string().regex(/^in_[A-Za-z0-9]{1,250}$/, 'a Stripe invoice id (in_…)'),
    customerId: z
      .string()
      .regex(/^cus_[A-Za-z0-9]{1,250}$/, 'a Stripe customer id (cus_…)')
      .nullish(),
  }),
  permission: 'billing:system',
})

/**
 * Processes a stored Stripe event again (Server admin › Billing › Events): it is queued as if it had just arrived, and
 * everything it does happens once (the ledger's unique source keys). Like every billing write, only an instance admin
 * signed in as themselves with their passkey, and with a reason for the audit log (security review of #919, I3).
 */
export const billingReprocessEvent = defineAction({
  name: 'billing.reprocessEvent',
  description:
    'Process a stored Stripe event again, for example after it failed five times. Every effect it has (a credit, a status) happens once. Needs the reason, kept in the audit log.',
  input: z.object({
    eventId: stripeEventId,
    reason: z.string().trim().min(3, 'say why, in a few words').max(500),
  }),
  permission: 'instance:admin',
})

/**
 * `data` of `billingEnabled.get` and `.set`. `on`: the switch. `inEffect`: the provider billing runs with now (`stripe`
 * only when on, connected and allowed). `connected`: Stripe has both keys. `mode`: the secret key's mode, null without
 * one. `liveAllowed`: whether the server allows live keys (`BILLING_LIVE_KEYS=1`, production only; never with
 * `LINEDESK_MODE=dev`). `guardsOk`: the ledger's database guards were found intact (apps/api/src/ledger-guards.ts);
 * while false, billing is not in effect.
 */
export type BillingEnabledData = {
  on: boolean
  inEffect: 'none' | 'stripe'
  connected: boolean
  mode: 'test' | 'live' | null
  liveAllowed: boolean
  guardsOk: boolean
}
