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
/**
 * `data` of `billingEnabled.get` and `.set`. `on`: the switch. `inEffect`: the provider billing runs with now (`stripe`
 * only when on, connected and allowed). `connected`: Stripe has both keys. `mode`: the secret key's mode, null without
 * one. `liveAllowed`: whether the server allows live keys (`BILLING_LIVE_KEYS=1`, production only; never with
 * `LINEDESK_MODE=dev`).
 */
export type BillingEnabledData = {
  on: boolean
  inEffect: 'none' | 'stripe'
  connected: boolean
  mode: 'test' | 'live' | null
  liveAllowed: boolean
}
