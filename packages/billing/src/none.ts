import type { BillingProvider } from './provider.ts'

/** The default: no payment service. Self-hosted installs bill nothing; every billing path stays off. */
export const noneBillingProvider: BillingProvider = {
  name: 'none',
  account: async () => null,
}
