// Provider for local development and tests: no carrier, no network, nothing to pay.
import type { CallStatusEvent, TelephonyProvider } from './provider.ts'

export const devProvider: TelephonyProvider = {
  name: 'dev',
  async searchNumbers({ areaCode = '503', limit = 3 }) {
    return Array.from({ length: limit }, (_, i) => ({ e164: `+1${areaCode}55501${String(i).padStart(2, '0')}` }))
  },
  async buyNumber(e164) {
    return { e164, providerRef: `dev_${e164}`, purchased: true }
  },
  async routeToSip() {},
  async releaseNumber() {},
  parseWebhook({ rawBody }) {
    return JSON.parse(rawBody) as CallStatusEvent
  },
}
