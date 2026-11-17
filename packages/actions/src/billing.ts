// Billing of an install's workspaces through its own Stripe account (docs/billing.md). The instance switch: billing runs only when Stripe is connected under
// Server admin › Providers › Billing and an instance admin turned it on here. Off by default, so a self-hosted install
// never bills anyone, even with keys stored.
import { z } from 'zod'
import { billTarget } from './billing-checkout.ts'
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

// ---- The bill's life (docs/billing.md §3.4, §8; PR 11) ----

/**
 * What the in-app banner shows the bill owner: the bill's status and why it is suspended, the dunning dates, the dates
 * after a cancellation, and the extra numbers whose month is unpaid. Only the bill owner gets it; for everyone else
 * (and on an unbilled workspace) `data.bill` is null.
 */
export const billingState = defineAction({
  name: 'billing.state',
  description:
    "The workspace's bill as its owner sees it in the banner: status (active, past_due, suspended, canceled, …), why it is suspended, when it is suspended or canceled if the plan fee stays unpaid, when the numbers are released and until when the data can be exported after a cancellation, the extra numbers whose month is unpaid, whether a failed recharge waits for the owner to confirm the payment, and a low balance that no recharge will lift. Only the bill owner; null for anyone else.",
  input: z.object(billTarget),
  permission: 'billing:manage',
  readOnly: true,
})
/** `data` of `billing.state`: `bill` null for anyone but the bill owner. Dates are ISO strings; null where they do not apply. */
export type BillingStateData = { bill: BillingStateBill | null }
export type BillingStateBill = {
  status: 'pending_payment' | 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled' | 'comped'
  suspendedReason: 'admin' | 'payment' | 'dispute' | 'early_fraud_warning' | null
  pastDueSince: string | null
  suspendsAt: string | null
  cancelsAt: string | null
  canceledAt: string | null
  numbersReleaseAt: string | null
  dataUntil: string | null
  rechargeFailed: boolean
  /** Held for review (Radar flagged the card): no number can be bought until an instance admin approves it. */
  heldForReview: boolean
  /** The failed recharge waits for the owner to confirm the payment on its invoice page (3D Secure). */
  rechargeNeedsAction: boolean
  /**
   * In the trial or paid, the balance is below the auto-recharge threshold and nothing lifts it: auto-recharge is off
   * (`auto_recharge_off`), or this month's cap leaves less than one recharge (`cap_reached`). Null otherwise.
   */
  lowBalance: 'auto_recharge_off' | 'cap_reached' | null
  unpaidNumbers: { e164: string; releaseAt: string }[]
  /** "Keep calls answered" in the trial (docs/billing.md §3.2 step 7); null when it is not offered. */
  trialMinutes: TrialMinutesPrompt | null
}

/**
 * The trial prompt: a trial bill with auto-recharge on whose owner has not pressed "Keep calls answered", once a
 * workspace used `TRIAL_PROMPT_SHARE` of its included minutes. `stage`: `low` (minutes left, or a balance that still
 * covers calls), `grace` (minutes used up: new calls answered on the trial grace for a short time), `paused` (the grace
 * is used: new callers hear that the business calls back). The purchase (`amountCents` on `card`, null when it could
 * not be read), the automatic top-up after it (below `thresholdCents`, at most `capCents` a month), and the trial's end.
 */
export type TrialMinutesPrompt = {
  stage: 'low' | 'grace' | 'paused'
  usedMinutes: number
  includedMinutes: number
  amountCents: number
  thresholdCents: number
  capCents: number
  freeUntil: string | null
  standardMicrosPerMinute: number
  card: { id: string; brand: string | null; last4: string | null } | null
}

/**
 * The port-out details of the bill's numbers on Linedesk's carrier account (docs/billing.md §3.4): what another carrier
 * asks for to move a number away. The bill owner only, signed in as themselves in the app with the owner step-up (a
 * recent sign-in, the passkey when they have one); logged. Without the step-up `stepUp` says what is missing and no
 * code is returned.
 */
export const billingPortOutInfo = defineAction({
  name: 'billing.portOutInfo',
  description:
    "The port-out details (account number and PIN per number) of the bill's numbers bought through Linedesk, for moving a number to another carrier. Only the bill owner, signed in to the app, after confirming it is them (a recent sign-in, the passkey when they have one).",
  input: z.object({}),
  permission: 'billing:manage',
  // The PINs go to the owner once; the command log keeps that it was asked, never them.
  secretResult: true,
})
/** `data` of `billing.portOutInfo`. */
export type BillingPortOutData = {
  stepUp: 'passkey' | 'signIn' | null
  numbers: { phoneNumberId: string; e164: string; accountNumber: string; pin: string }[]
}

/**
 * An instance admin records that another carrier asked to port one of the bill's numbers away (Telnyx tells the
 * account by email or in its portal), and checks the PIN the request names against the owner's (`pinMatches`). The
 * bill owner and the workspace owner are emailed at once.
 */
export const billingRecordPortOut = defineAction({
  name: 'billing.recordPortOut',
  description:
    'Record that another carrier asked to port a number away, and check the PIN the request names: its bill owner and its workspace owner are emailed at once. Instance admins only.',
  input: z.object({ phoneNumberId: z.string().min(1).max(100), pin: z.string().max(20).optional() }),
  permission: 'instance:admin',
  sensitive: ['pin'],
})
/** `data` of `billing.recordPortOut`: whether the PIN matched (null without a PIN or before the owner ever saw one). */
export type BillingRecordPortOutData = { e164: string; billId: string; pinMatches: boolean | null }

/**
 * The bill owner hands the bill to a member of one of its workspaces (docs/billing.md §8, bill ownership), with the
 * owner step-up. The new owner must have a confirmed email address.
 */
export const billingHandOver = defineAction({
  name: 'billing.handOver',
  description:
    "Hand the bill (who pays for its workspaces) to another member of one of its workspaces. Only the bill owner, signed in to the app, after confirming it is them; the new owner's email address must be confirmed.",
  input: z.object({ userId: z.string().min(1).max(100) }),
  permission: 'billing:manage',
})

/** `data` of `billing.handOver`. An instance admin names another owner with #919's `billing.transferOwner`. */
export type BillingOwnerData = {
  billId: string
  ownerUserId: string
  previousOwnerUserId: string
  /** What the new owner did not choose and was switched off (LIN-438). */
  payerReset: BillPayerReset
}

/**
 * A workspace got another bill owner (`billing.handOver`, `billing.transferOwner`, `billing.moveWorkspace` to a bill
 * of someone else, `team.transferOwnership` moving the bill; LIN-438): Allow Premium and Allow Ultra were the old
 * payer's choice and are switched off. The workspaces that had one on, and the assistants moved back to Standard or off
 * Ultra.
 */
export type BillPayerReset = { workspaceIds: string[]; movedToStandard: string[]; movedOffUltra: string[] }
