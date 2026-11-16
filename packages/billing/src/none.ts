import type { BillingProvider } from './provider.ts'

/** The default: no payment service. Self-hosted installs bill nothing; every billing path stays off. */
const off = async (): Promise<never> => {
  throw new Error('billing is off on this install: nothing is charged')
}

export const noneBillingProvider: BillingProvider = {
  name: 'none',
  account: async () => null,
  chargeRecharge: off,
  findRechargeInvoice: off,
  stopRechargeInvoice: off,
  rechargeInvoicePage: off,
}
