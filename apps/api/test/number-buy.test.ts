// German numbers held in the install's name, bought through the US buy flow (LIN-619, docs/decisions.md 2026-11-19):
// the buy offers (numberBuyOffers), phoneNumber.setup for a German workspace with a carrier in memory, the calm
// fallback with an ALERT while the requirement group is missing or the carrier has none in stock, the forwarding
// path, the ALERT from 8 held numbers, and germanNumbers.get/set. Instance-wide (INSTANCE_WIDE_FILES): it writes the
// instance setting `number_buy.de`, inside transactions that are rolled back.
import { actions, BASE_BUY_OFFERS, HELD_NUMBERS_ALERT_AT, rolePermissions } from '@linedesk/actions'
import { instance_settings, number_purchases, phone_numbers, type Tx, workspace_settings } from '@linedesk/db'
import { devProvider, type TelephonyProvider } from '@linedesk/telephony'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AUDITED_ACTIONS } from '../src/audit.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { Reject, runHandler, type Undo } from '../src/handlers.ts'
import { NUMBERS_BEING_SET_UP, numberBuyOffers } from '../src/number-buy.ts'
import { BUY_COUNTRIES_ONLY } from '../src/number-purchases.ts'

const WORKSPACE = `ws_test_${crypto.randomUUID().slice(0, 8)}`
const owner: Actor = { actorId: 'user_test', role: 'owner', workspaceId: WORKSPACE, permissions: rolePermissions.owner }
const admin: Actor = { ...owner, permissions: [...rolePermissions.owner, 'instance:admin'] }

class Rollback extends Error {}

async function inRollback(body: (tx: Tx) => Promise<void>) {
  await db
    .transaction(async tx => {
      await body(tx)
      throw new Rollback()
    })
    .catch(e => {
      if (!(e instanceof Rollback)) throw e
    })
}

const germanNumbers = (tx: Tx, value: Record<string, unknown> | null) =>
  value === null
    ? tx.delete(instance_settings).where(eq(instance_settings.key, 'number_buy.de'))
    : tx
        .insert(instance_settings)
        .values({ key: 'number_buy.de', value: JSON.stringify(value), updated_at: new Date().toISOString() })
        .onConflictDoUpdate({ target: instance_settings.key, set: { value: JSON.stringify(value) } })

const inCountry = (tx: Tx, country: string) =>
  tx
    .insert(workspace_settings)
    .values({ workspace_id: WORKSPACE, timezone: 'Europe/Berlin', country })
    .onConflictDoUpdate({ target: workspace_settings.workspace_id, set: { country } })

/** A carrier in memory on the `dev` adapter whose account holds nothing yet, with spies on searching and buying. */
function carrier(overrides: Partial<TelephonyProvider> = {}) {
  const base: TelephonyProvider = { ...devProvider, findNumber: async () => null, ...overrides }
  return { ...base, searchNumbers: vi.fn(base.searchNumbers), buyNumber: vi.fn(base.buyNumber) }
}

async function setup(tx: Tx, input: unknown, telephony: TelephonyProvider, actor: Actor = owner) {
  const undos: Undo[] = []
  const def = actions.get('phoneNumber.setup')!
  try {
    return await runHandler(
      { tx, actor, now: new Date().toISOString(), telephony, onRollback: undo => undos.push(undo) },
      def,
      def.input.parse(input),
    )
  } catch (e) {
    await Promise.all(undos.map(undo => undo()))
    throw e
  }
}

const run = (tx: Tx, actor: Actor, name: string, input: unknown) =>
  runHandler({ tx, actor, now: new Date().toISOString() }, actions.get(name)!, actions.get(name)!.input.parse(input))

const ON = { on: true, requirementGroupId: 'rg_test_1' }

describe('German numbers through the US buy flow (LIN-619)', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await db.delete(number_purchases).where(eq(number_purchases.workspace_id, WORKSPACE))
  })

  test('the buy offers: the US, Canada and Puerto Rico always; Germany on the install account, ready once set up', () =>
    inRollback(async tx => {
      // Off: Germany is offered but not ready, so German workspaces read that numbers are being set up.
      await germanNumbers(tx, null)
      expect(await numberBuyOffers(tx, { account: 'install', provider: 'telnyx' })).toEqual([
        ...BASE_BUY_OFFERS,
        { country: 'DE', numberType: 'local', areaCodes: ['6221'], ready: false },
      ])
      await germanNumbers(tx, { on: true })
      expect(await numberBuyOffers(tx, { account: 'install', provider: 'telnyx' })).toContainEqual({
        country: 'DE',
        numberType: 'local',
        areaCodes: ['6221'],
        ready: false,
      })
      await germanNumbers(tx, ON)
      expect(await numberBuyOffers(tx, { account: 'install', provider: 'telnyx' })).toContainEqual({
        country: 'DE',
        numberType: 'local',
        areaCodes: ['6221'],
        ready: true,
      })
      // A workspace on its own carrier account, or a carrier that orders without a requirement group: as before.
      expect(await numberBuyOffers(tx, { account: 'workspace', provider: 'telnyx' })).toEqual([...BASE_BUY_OFFERS])
      expect((await numberBuyOffers(tx, { account: 'install', provider: 'twilio' })).at(-1)?.ready).toBe(false)
      // 032 later is config only: a national number has no area codes.
      await germanNumbers(tx, { ...ON, numberType: 'national' })
      expect(await numberBuyOffers(tx, { account: 'install', provider: 'telnyx' })).toContainEqual({
        country: 'DE',
        numberType: 'national',
        areaCodes: [],
        ready: true,
      })
    }))

  test('a German workspace buys a 06221 number like a US one, ordered with the requirement group', () =>
    inRollback(async tx => {
      await germanNumbers(tx, ON)
      await inCountry(tx, 'DE')
      const account = carrier()
      const { rows } = await setup(tx, { areaCode: '6221', purchase: true }, account)
      expect(account.searchNumbers).toHaveBeenCalledWith({
        country: 'DE',
        areaCode: '6221',
        limit: 5,
        withRequirements: true,
      })
      expect(account.buyNumber).toHaveBeenCalledWith(expect.stringMatching(/^\+496221/), {
        requirementGroupRef: 'rg_test_1',
      })
      expect(rows.phone_numbers?.[0]).toMatchObject({ workspace_id: WORKSPACE, mode: 'new', purchased: true })
      expect(rows.phone_numbers?.[0]?.e164).toMatch(/^\+496221/)
    }))

  test('the forwarding path: the same purchase with a forwarding mode', () =>
    inRollback(async tx => {
      await germanNumbers(tx, ON)
      await inCountry(tx, 'DE')
      const { rows } = await setup(tx, { areaCode: '6221', purchase: true, mode: 'forward_conditional' }, carrier())
      expect(rows.phone_numbers?.[0]).toMatchObject({ mode: 'forward_conditional' })
      expect(rows.phone_numbers?.[0]?.e164).toMatch(/^\+496221/)
    }))

  test('German numbers off: the calm being-set-up refusal and an ALERT, nothing searched or bought', () =>
    inRollback(async tx => {
      await germanNumbers(tx, null)
      await inCountry(tx, 'DE')
      const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
      const account = carrier()
      const error = await setup(tx, { areaCode: '6221', purchase: true }, account).catch(e => e)
      expect(error).toBeInstanceOf(Reject)
      expect(error.message).toBe(NUMBERS_BEING_SET_UP)
      expect(alert).toHaveBeenCalledWith(
        expect.stringMatching(/^ALERT German number for workspace .*German numbers are off/),
      )
      expect(account.searchNumbers).not.toHaveBeenCalled()
      expect(account.buyNumber).not.toHaveBeenCalled()
    }))

  test('a country outside the offers (Austria) is still refused as before', () =>
    inRollback(async tx => {
      await inCountry(tx, 'AT')
      const account = carrier()
      await expect(setup(tx, { areaCode: '503', purchase: true }, account)).rejects.toThrow(BUY_COUNTRIES_ONLY)
      expect(account.searchNumbers).not.toHaveBeenCalled()
    }))

  test('on but no requirement group: the calm refusal and an ALERT, nothing searched or bought', () =>
    inRollback(async tx => {
      await germanNumbers(tx, { on: true })
      await inCountry(tx, 'DE')
      const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
      const account = carrier()
      const error = await setup(tx, { areaCode: '6221', purchase: true }, account).catch(e => e)
      expect(error).toBeInstanceOf(Reject)
      expect(error.message).toBe(NUMBERS_BEING_SET_UP)
      expect(alert).toHaveBeenCalledWith(
        expect.stringMatching(/^ALERT German number for workspace .*requirement group/),
      )
      expect(account.searchNumbers).not.toHaveBeenCalled()
      expect(account.buyNumber).not.toHaveBeenCalled()
    }))

  test('none in stock: the same calm refusal and an ALERT', () =>
    inRollback(async tx => {
      await germanNumbers(tx, ON)
      await inCountry(tx, 'DE')
      const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
      const account = carrier({ searchNumbers: async () => [] })
      const error = await setup(tx, { areaCode: '6221', purchase: true }, account).catch(e => e)
      expect(error.message).toBe(NUMBERS_BEING_SET_UP)
      expect(alert).toHaveBeenCalledWith(expect.stringMatching(/^ALERT German number .*no free number in 6221/))
      expect(account.buyNumber).not.toHaveBeenCalled()
    }))

  test('only the offered area codes: another German one, or one with the trunk 0, is refused', () =>
    inRollback(async tx => {
      await germanNumbers(tx, ON)
      await inCountry(tx, 'DE')
      const account = carrier()
      await expect(setup(tx, { areaCode: '30', purchase: true }, account)).rejects.toThrow(
        'Area code 30 is not offered in Germany on this server: pick one of 6221.',
      )
      expect(() => actions.get('phoneNumber.setup')!.input.parse({ areaCode: '06221', purchase: true })).toThrow(
        'The area code is its digits without the leading 0, such as 503 or 6221',
      )
      expect(account.searchNumbers).not.toHaveBeenCalled()
    }))

  test('in the US: toll-free, N11, 555 and unknown area codes are refused in a plain sentence', () =>
    inRollback(async tx => {
      await inCountry(tx, 'US')
      const account = carrier()
      for (const areaCode of ['800', '411', '555', '123', '999'])
        await expect(setup(tx, { areaCode, purchase: true }, account)).rejects.toThrow(
          `Area code ${areaCode} is not one a number can be bought in.`,
        )
      expect(account.searchNumbers).not.toHaveBeenCalled()
    }))

  test(`from ${HELD_NUMBERS_ALERT_AT} German numbers on the install account: an ALERT on each purchase, never a block`, () =>
    inRollback(async tx => {
      await germanNumbers(tx, ON)
      await inCountry(tx, 'DE')
      // Held already (other workspaces' numbers on the install account).
      for (let i = 0; i < HELD_NUMBERS_ALERT_AT - 1; i++)
        await tx.insert(phone_numbers).values({
          id: `pn_held_${i}_${crypto.randomUUID().slice(0, 6)}`,
          workspace_id: WORKSPACE,
          e164: `+4962219990${String(i).padStart(3, '0')}`,
          provider: 'dev',
          provider_ref: `ref_held_${i}`,
          carrier_account: 'install',
        })
      const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { rows } = await setup(tx, { areaCode: '6221', purchase: true }, carrier())
      expect(rows.phone_numbers?.[0]?.e164).toMatch(/^\+496221/)
      expect(alert).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^ALERT ${HELD_NUMBERS_ALERT_AT} German numbers are held`)),
      )
    }))

  test('below the threshold: no ALERT', () =>
    inRollback(async tx => {
      await germanNumbers(tx, ON)
      await inCountry(tx, 'DE')
      const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
      await setup(tx, { areaCode: '6221', purchase: true }, carrier())
      expect(alert).not.toHaveBeenCalledWith(expect.stringMatching(/German numbers are held/))
    }))

  test('germanNumbers.get and .set: instance admins only, audited, merged and checked', () =>
    inRollback(async tx => {
      await germanNumbers(tx, null)
      expect(actions.get('germanNumbers.get')!.permission).toBe('instance:admin')
      expect(actions.get('germanNumbers.set')!.permission).toBe('instance:admin')
      expect(AUDITED_ACTIONS['germanNumbers.set']).toBe('admin')
      expect((await run(tx, admin, 'germanNumbers.get', {})).data).toMatchObject({
        on: false,
        numberType: 'local',
        areaCodes: ['6221'],
        requirementGroupId: '',
        alertAt: HELD_NUMBERS_ALERT_AT,
      })
      await run(tx, admin, 'germanNumbers.set', { on: true })
      const set = await run(tx, admin, 'germanNumbers.set', {
        requirementGroupId: 'rg_1',
        areaCodes: ['6221', '6221', '30'],
      })
      expect(set.data).toMatchObject({ on: true, requirementGroupId: 'rg_1', areaCodes: ['6221', '30'] })
      const input = actions.get('germanNumbers.set')!.input
      expect(() => input.parse({ areaCodes: ['06221'] })).toThrow()
      expect(() => input.parse({ requirementGroupId: 'a b' })).toThrow()
      expect(() => input.parse({ other: 1 })).toThrow()
    }))
})
