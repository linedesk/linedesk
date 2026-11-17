import { type BillingProvider, WebhookRefused } from './provider.ts'

/** The default: no payment service. Self-hosted installs bill nothing; every billing path stays off. */
const off = async (): Promise<never> => {
  throw new Error('billing is off on this install: nothing is charged')
}

export const noneBillingProvider: BillingProvider = {
  name: 'none',
  account: async () => null,
  chargeRecharge: off,
  rechargeCard: async () => null,
  checkoutPaymentMethodConfiguration: async () => null,
  createCustomer: off,
  startCheckout: off,
  syncCatalog: off,
  catalogWriteAccess: async () => ({ products: null, prices: null }),
  portalWriteAccess: async () => null,
  checkoutTermsReady: async () => null,
  taxSetup: async () => null,
  customerTaxReady: off,
  customersWithoutTaxAddress: off,
  syncSubscriptionTax: off,
  syncPortal: off,
  checkoutSession: async () => null,
  expireOpenCheckouts: off,
  customerPurchases: off,
  deleteCustomer: off,
  cancelSubscription: off,
  resumeSubscription: off,
  addInvoiceItem: off,
  findRechargeInvoice: off,
  stopRechargeInvoice: off,
  rechargeInvoicePage: off,
  portalSession: off,
  webhookEvent() {
    throw new WebhookRefused('signature')
  },
  invoice: async () => null,
  subscription: async () => null,
  recentEvents: async () => ({ events: [], truncated: false }),
  refundBlockers: off,
  refundInvoice: off,
  findRefund: off,
  checkoutInvoice: off,
  setSeatQuantity: off,
  setExtraCallsQuantity: off,
  dispute: async () => null,
  earlyFraudWarning: async () => null,
  charge: async () => null,
}
