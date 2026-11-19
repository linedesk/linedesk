// Provider for local development and tests: no carrier, no network, nothing to pay.
import type { CallStatusEvent, NumberLookup, TelephonyProvider } from './provider.ts'

/** Country calling codes of the countries `dev` hands out numbers in outside the NANP (Germany; GB and IE for tests). */
const DEV_CALLING_CODES: Record<string, string> = { DE: '49', GB: '44', IE: '353' }

/** What `dev` says every number is: a Verizon mobile, so the carrier chips have something to preselect. */
export const DEV_LOOKUP: Omit<NumberLookup, 'e164'> = { lineType: 'mobile', carrier: 'Verizon Wireless' }

/**
 * The area codes `dev` has no free number in (LINEDESK_DEV_NO_FREE_AREA_CODES, comma-separated; none by default), so the
 * "no number free" message and the nearby area codes can be tried without a carrier.
 */
export const devNoFreeAreaCodes = (setting = process.env.LINEDESK_DEV_NO_FREE_AREA_CODES ?? ''): string[] =>
  setting
    .split(',')
    .map(code => code.trim())
    .filter(Boolean)

export const devProvider: TelephonyProvider = {
  name: 'dev',
  async searchNumbers({ country, areaCode = '503', limit = 3, numberType }) {
    // A national number (Germany 032) has no area code; LINEDESK_DEV_NO_FREE_AREA_CODES=32 tries "none in stock".
    if (numberType === 'national') areaCode = '32'
    if (devNoFreeAreaCodes().includes(areaCode)) return []
    const callingCode = DEV_CALLING_CODES[country]
    if (callingCode)
      return Array.from({ length: limit }, (_, i) => ({ e164: `+${callingCode}${areaCode}5550${String(i).padStart(3, '0')}` }))
    return Array.from({ length: limit }, (_, i) => ({ e164: `+1${areaCode}55501${String(i).padStart(2, '0')}` }))
  },
  async listNumbers() {
    return []
  },
  // There is no account: every number can be attached, and "buying" one is free.
  async findNumber(e164) {
    return { e164, providerRef: `dev_${e164}` }
  },
  async buyNumber(e164) {
    return { e164, providerRef: `dev_${e164}` }
  },
  async routeToSip() {},
  async unrouteNumber() {},
  async releaseNumber() {},
  async lookupNumber(e164) {
    return { e164, ...DEV_LOOKUP }
  },
  parseWebhook({ rawBody }) {
    return JSON.parse(rawBody) as CallStatusEvent
  },
}

/**
 * What a simulated forwarding check does with the business number under `dev`, so every result can be
 * tried without a phone: the number's last digit picks it. 2: rings out, never forwarded; 3: answered before
 * forwarding (voicemail); 4: busy; 5: unreachable; 6: reached Linedesk but no assistant took it; anything else:
 * forwarded to the Linedesk number.
 */
export type DevForwardingOutcome = 'forwarded' | 'no_answer' | 'answered' | 'busy' | 'unreachable' | 'no_assistant'
export function devForwardingOutcome(businessNumber: string): DevForwardingOutcome {
  const last = businessNumber.at(-1)
  if (last === '6') return 'no_assistant'
  if (last === '2') return 'no_answer'
  if (last === '3') return 'answered'
  if (last === '4') return 'busy'
  if (last === '5') return 'unreachable'
  return 'forwarded'
}
