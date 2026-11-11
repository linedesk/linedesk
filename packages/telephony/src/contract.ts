// The contract every TelephonyProvider adapter has to meet, run by each adapter's test file
// against its own mocked HTTP.
import { describe, expect, test } from 'vitest'
import type { TelephonyProvider } from './provider.ts'

export function describeProviderContract(name: string, make: () => TelephonyProvider) {
  describe(`${name} provider contract`, () => {
    test('search, buy, route to SIP, release', async () => {
      const provider = make()
      const [found] = await provider.searchNumbers({ country: 'US', areaCode: '503', limit: 1 })
      expect(found!.e164).toMatch(/^\+1503\d{7}$/)
      const owned = await provider.buyNumber(found!.e164)
      expect(owned.e164).toBe(found!.e164)
      expect(owned.providerRef).toBeTruthy()
      await expect(provider.routeToSip(owned, 'sip.linedesk.test')).resolves.toBeUndefined()
      await expect(provider.unrouteNumber(owned)).resolves.toBeUndefined()
      await expect(provider.unrouteNumber(owned)).resolves.toBeUndefined() // safe to repeat
      await expect(provider.releaseNumber(owned)).resolves.toBeUndefined()
    })

    test('findNumber returns a number the account owns, with the same reference as buying it', async () => {
      const provider = make()
      const [found] = await provider.searchNumbers({ country: 'US', areaCode: '503', limit: 1 })
      const bought = await provider.buyNumber(found!.e164)
      expect(await provider.findNumber(found!.e164)).toEqual(bought)
    })

    // `dev` has no account: it owns nothing and lists nothing.
    test.skipIf(name === 'dev')('listNumbers lists the numbers of the account, with the same reference', async () => {
      const provider = make()
      expect(await provider.listNumbers(20)).toEqual([])
      const [found] = await provider.searchNumbers({ country: 'US', areaCode: '503', limit: 1 })
      const bought = await provider.buyNumber(found!.e164)
      expect(await provider.listNumbers(20)).toEqual([bought])
    })
  })
}
