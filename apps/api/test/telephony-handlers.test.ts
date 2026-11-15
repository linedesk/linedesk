// Handlers whose outcome depends on the carrier or on time: they run directly, with the provider
// passed in, inside a transaction that is rolled back. Part of the Postgres-backed API suite.
import { actions, rolePermissions } from '@linedesk/actions'
import { calls, number_purchases, phone_numbers, type Tx, workspace_settings } from '@linedesk/db'
import { devProvider, TelephonyError, type TelephonyProvider } from '@linedesk/telephony'
import { eq, inArray, sql } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { Reject, runHandler, type Undo } from '../src/handlers.ts'
import { INSTALL_NUMBER_ADMIN_ONLY } from '../src/workspace-carrier.ts'
import {
  BUY_COUNTRIES_ONLY, BY_AREA_CODE_ONLY, INSTALL_CAP_REACHED, INSTALL_NUMBERS_PER_WORKSPACE, INSTALL_PURCHASES_PER_HOUR, INSTALL_PURCHASES_PER_USER_PER_DAY, installPurchaseCaps, NOT_WITH_API_KEY, NUMBER_NOT_ACTIVATED, NUMBER_SETUP_BUSY, NUMBERS_NEED_DOCUMENTS,
} from '../src/number-purchases.ts'

const WORKSPACE = `ws_test_${crypto.randomUUID().slice(0, 8)}`
const owner: Actor = { actorId: 'user_test', role: 'owner', workspaceId: WORKSPACE, permissions: rolePermissions.owner }
const agent: Actor = { actorId: 'agent', role: 'agent', workspaceId: null, permissions: rolePermissions.agent }

class Rollback extends Error {}

/** A carrier account in memory, with spies: `owned` are the numbers already in it. Overrides make a step fail. */
function carrier(owned: string[] = [], overrides: Partial<TelephonyProvider> = {}) {
  const account = new Set(owned)
  const base: TelephonyProvider = {
    ...devProvider,
    findNumber: async e164 => (account.has(e164) ? { e164, providerRef: `ref_${e164}` } : null),
    buyNumber: async e164 => {
      account.add(e164)
      return { e164, providerRef: `ref_${e164}` }
    },
    releaseNumber: async number => void account.delete(number.e164),
    ...overrides,
  }
  return {
    ...base, account,
    findNumber: vi.fn(base.findNumber), buyNumber: vi.fn(base.buyNumber), routeToSip: vi.fn(base.routeToSip), unrouteNumber: vi.fn(base.unrouteNumber), releaseNumber: vi.fn(base.releaseNumber),
  }
}

describe('telephony handlers', () => {
  // Purchases are logged outside the test's transaction (committed before the carrier is asked): cleared after each test.
  afterEach(async () => {
    await db.delete(number_purchases).where(eq(number_purchases.workspace_id, WORKSPACE))
  })

  const run = (tx: Tx, actor: Actor, name: string, input: unknown, telephony: TelephonyProvider = devProvider) =>
    runHandler({ tx, actor, now: new Date().toISOString(), telephony }, actions.get(name)!, actions.get(name)!.input.parse(input))

  async function inRollback(body: (tx: Tx) => Promise<void>) {
    await db.transaction(async tx => {
      await body(tx)
      throw new Rollback()
    }).catch(e => {
      if (!(e instanceof Rollback)) throw e
    })
  }

  /** Runs phoneNumber.setup like the API does: undos registered by the handler run when it fails. */
  async function setup(tx: Tx, input: unknown, telephony: TelephonyProvider, actor: Actor = owner) {
    const undos: Undo[] = []
    const def = actions.get('phoneNumber.setup')!
    try {
      return await runHandler({ tx, actor, now: new Date().toISOString(), telephony, onRollback: undo => undos.push(undo) }, def, def.input.parse(input))
    } catch (e) {
      const notes = await Promise.all(undos.map(undo => undo()))
      throw Object.assign(e as Error, { notes })
    }
  }

  test('attaches a number that is in the carrier account, and never buys', () => inRollback(async tx => {
    const twilio = carrier(['+15035550999'])
    const { rows } = await setup(tx, { e164: '+15035550999' }, twilio)
    expect(rows.phone_numbers).toMatchObject([{ workspace_id: WORKSPACE, e164: '+15035550999', provider: 'dev', mode: 'forward_conditional', provider_ref: 'ref_+15035550999', verified_at: null }])
    expect(twilio.routeToSip).toHaveBeenCalledWith({ e164: '+15035550999', providerRef: 'ref_+15035550999' }, expect.any(String))
    expect(twilio.buyNumber).not.toHaveBeenCalled()

    await expect(setup(tx, { e164: '+15035550999' }, twilio)).rejects.toThrow('already set up')
    expect((await setup(tx, { e164: '+15035550990', mode: 'ported' }, carrier(['+15035550990']))).rows.phone_numbers?.[0]?.mode).toBe('ported')
  }))

  test("a number already in the install's account is attached by instance admins only", () => inRollback(async tx => {
    vi.stubEnv('LIVEKIT_SIP_ENDPOINT', 'sip.linedesk.test')
    try {
      const install = { ...carrier(['+15035550977', '+15035550978']), name: 'telnyx' as const }
      for (const input of [{ e164: '+15035550977' }, { e164: '+15035550977', purchase: true }]) {
        const error = await setup(tx, input, install).catch(e => e)
        expect(error.message).toBe(INSTALL_NUMBER_ADMIN_ONLY)
      }
      expect(install.routeToSip).not.toHaveBeenCalled()
      const admin: Actor = { ...owner, permissions: [...rolePermissions.owner, 'instance:admin'] }
      expect((await setup(tx, { e164: '+15035550978' }, install, admin)).rows.phone_numbers?.[0]?.e164).toBe('+15035550978')
      // Buying a new number stays open to owners, by US area code.
      expect((await setup(tx, { areaCode: '503', purchase: true }, install)).rows.phone_numbers?.[0]?.purchased).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  }))

  describe("buying on the install's carrier account", () => {
    const admin: Actor = { ...owner, permissions: [...rolePermissions.owner, 'instance:admin'] }
    const installCarrier = () => ({ ...carrier(), name: 'telnyx' as const })
    const logged = (tx: Tx) => tx.select().from(number_purchases).where(eq(number_purchases.workspace_id, WORKSPACE)).orderBy(number_purchases.created_at)
    const pastPurchases = (tx: Tx, rows: { workspace_id?: string; actor_id?: string; minutesAgo: number; by_admin?: boolean }[]) =>
      tx.insert(number_purchases).values(rows.map((r, i) => ({ by_admin: r.by_admin ?? false,
        id: `np_test_${crypto.randomUUID().slice(0, 8)}_${i}`, workspace_id: r.workspace_id ?? WORKSPACE, actor_id: r.actor_id ?? owner.actorId,
        e164: `+1503555${String(1000 + i)}`, provider: 'telnyx', carrier_account: 'install' as const, created_at: new Date(Date.now() - r.minutesAgo * 60_000).toISOString(),
      })))

    const withSipEndpoint = (body: (tx: Tx) => Promise<void>) => inRollback(async tx => {
      vi.stubEnv('LIVEKIT_SIP_ENDPOINT', 'sip.linedesk.test')
      try {
        await body(tx)
      } finally {
        vi.unstubAllEnvs()
      }
    })

    test('only by area code for owners; instance admins may name a number; every purchase is logged', () => withSipEndpoint(async tx => {
      const install = installCarrier()
      await expect(setup(tx, { e164: '+442071234567', purchase: true }, install)).rejects.toThrow(BY_AREA_CODE_ONLY)
      await expect(setup(tx, { e164: '+15035550979', purchase: true }, install)).rejects.toThrow(BY_AREA_CODE_ONLY)
      expect(install.buyNumber).not.toHaveBeenCalled()
      await setup(tx, { areaCode: '503', purchase: true }, install)
      await setup(tx, { e164: '+15035550979', purchase: true }, install, admin)
      expect(await logged(tx)).toMatchObject([
        { actor_id: owner.actorId, provider: 'telnyx', carrier_account: 'install' },
        { e164: '+15035550979', carrier_account: 'install' },
      ])
    }))

    test(`a workspace gets ${INSTALL_NUMBERS_PER_WORKSPACE} numbers; releasing one does not make room within 30 days; admins are not limited`, () => withSipEndpoint(async tx => {
      const install = installCarrier()
      const first = await setup(tx, { areaCode: '503', purchase: true }, install)
      await setup(tx, { areaCode: '971', purchase: true }, { ...install, searchNumbers: async () => [{ e164: '+19715550111' }] })
      await expect(setup(tx, { areaCode: '541', purchase: true }, install)).rejects.toThrow(`A workspace can get ${INSTALL_NUMBERS_PER_WORKSPACE} numbers`)
      const id = (first.rows.phone_numbers as { id: string; e164: string }[])[0]!
      await run(tx, owner, 'phoneNumber.release', { phoneNumberId: id.id, confirm: id.e164 }, install)
      await expect(setup(tx, { areaCode: '541', purchase: true }, install)).rejects.toThrow(`A workspace can get ${INSTALL_NUMBERS_PER_WORKSPACE} numbers`)
      expect((await setup(tx, { areaCode: '541', purchase: true }, { ...install, searchNumbers: async () => [{ e164: '+15415550111' }] }, admin)).rows.phone_numbers?.[0]?.purchased).toBe(true)
    }))

    test('a purchase over a limit is refused before the carrier is searched or asked anything', () => withSipEndpoint(async tx => {
      await pastPurchases(tx, Array.from({ length: INSTALL_PURCHASES_PER_USER_PER_DAY }, () => ({ workspace_id: 'ws_elsewhere', minutesAgo: 60 })))
      const searchNumbers = vi.fn(async () => [{ e164: '+15035550123' }])
      const install = { ...installCarrier(), searchNumbers }
      await expect(setup(tx, { areaCode: '503', purchase: true }, install)).rejects.toThrow('numbers today')
      await expect(setup(tx, { areaCode: '503', purchase: true, assistantId: 'as_bogus' }, install)).rejects.toThrow()
      expect(searchNumbers).not.toHaveBeenCalled()
      expect(install.findNumber).not.toHaveBeenCalled()
      expect(install.buyNumber).not.toHaveBeenCalled()
    }))

    test('a purchase older than 30 days no longer counts', () => withSipEndpoint(async tx => {
      await pastPurchases(tx, [{ minutesAgo: 31 * 24 * 60 }, { minutesAgo: 31 * 24 * 60 }])
      expect((await setup(tx, { areaCode: '503', purchase: true }, installCarrier())).rows.phone_numbers?.[0]?.purchased).toBe(true)
    }))

    test(`a user buys at most ${INSTALL_PURCHASES_PER_USER_PER_DAY} a day over all workspaces, and the install at most ${INSTALL_PURCHASES_PER_HOUR} an hour`, () => withSipEndpoint(async tx => {
      await pastPurchases(tx, Array.from({ length: INSTALL_PURCHASES_PER_USER_PER_DAY }, () => ({ workspace_id: 'ws_elsewhere', minutesAgo: 60 })))
      await expect(setup(tx, { areaCode: '503', purchase: true }, installCarrier())).rejects.toThrow('numbers today')
      const someoneElse: Actor = { ...owner, actorId: 'user_other' }
      await pastPurchases(tx, Array.from({ length: INSTALL_PURCHASES_PER_HOUR }, (_, i) => ({ workspace_id: `ws_many_${i}`, actor_id: `user_many_${i}`, minutesAgo: 5 })))
      await expect(setup(tx, { areaCode: '503', purchase: true }, installCarrier(), someoneElse)).rejects.toThrow('in the last hour')
    }))

    test('a purchase that fails after the carrier sold the number still counts, and nothing is bought for a request that is refused anyway', () => withSipEndpoint(async tx => {
      // A bogus assistant is refused before the carrier is asked: nothing bought, nothing to count.
      const install = installCarrier()
      await expect(setup(tx, { areaCode: '503', purchase: true, assistantId: 'as_bogus' }, install)).rejects.toThrow()
      expect(install.buyNumber).not.toHaveBeenCalled()
      expect(await logged(tx)).toEqual([])
      // Routing fails after the purchase: the action rolls back and the number is released, but the attempt stays logged.
      for (const areaCode of ['503', '971']) {
        const failing = { ...installCarrier(), searchNumbers: async () => [{ e164: `+1${areaCode}5550123` }], routeToSip: async () => { throw new TelephonyError('telnyx', 'routing failed') } }
        await expect(setup(tx, { areaCode, purchase: true }, failing)).rejects.toThrow('routing failed')
      }
      expect(await logged(tx)).toHaveLength(2)
      await expect(setup(tx, { areaCode: '541', purchase: true }, installCarrier())).rejects.toThrow(`A workspace can get ${INSTALL_NUMBERS_PER_WORKSPACE} numbers`)
    }))

    test('the install as a whole: at most 20 a day and 100 in 30 days for everyone but instance admins, then an alert', () => withSipEndpoint(async tx => {
      expect(installPurchaseCaps({})).toEqual({ perDay: 20, per30Days: 100 })
      expect(installPurchaseCaps({ NUMBER_PURCHASES_PER_DAY: '5', NUMBER_PURCHASES_PER_30_DAYS: 'x' })).toEqual({ perDay: 5, per30Days: 100 })
      const alert = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        // Spread out so the hourly limit is not what refuses; admins' purchases do not count.
        await pastPurchases(tx, Array.from({ length: 30 }, (_, i) => ({ workspace_id: `ws_admin_${i}`, actor_id: 'user_admin', minutesAgo: 90, by_admin: true })))
        await pastPurchases(tx, Array.from({ length: 19 }, (_, i) => ({ workspace_id: `ws_day_${i}`, actor_id: `user_day_${i}`, minutesAgo: 120 + i })))
        expect((await setup(tx, { areaCode: '503', purchase: true }, installCarrier())).rows.phone_numbers?.[0]?.purchased).toBe(true)
        const someoneElse: Actor = { ...owner, actorId: 'user_other', workspaceId: WORKSPACE }
        await expect(setup(tx, { areaCode: '971', purchase: true }, { ...installCarrier(), searchNumbers: async () => [{ e164: '+19715550123' }] }, someoneElse)).rejects.toThrow(INSTALL_CAP_REACHED)
        expect(alert).toHaveBeenCalledWith(expect.stringMatching(/^ALERT number purchases: the install-wide cap is reached \(20\/20 today/))
      } finally {
        alert.mockRestore()
      }
    }))

    test('an API key cannot buy on the install account; an instance admin is not limited', () => withSipEndpoint(async tx => {
      const viaKey: Actor = { ...owner, apiKeyId: 'key_1' }
      const install = installCarrier()
      await expect(setup(tx, { areaCode: '503', purchase: true }, install, viaKey)).rejects.toThrow(NOT_WITH_API_KEY)
      expect(install.buyNumber).not.toHaveBeenCalled()
      await setup(tx, { areaCode: '503', purchase: true }, install, admin)
      expect(await logged(tx)).toMatchObject([{ by_admin: true }])
    }))

    test('15 purchases at once: none waits for a lock holding a connection, every request is answered, and the database keeps answering', async () => {
      vi.stubEnv('LIVEKIT_SIP_ENDPOINT', 'sip.linedesk.test')
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
      const workspaces = Array.from({ length: 15 }, (_, i) => `ws_burst_${crypto.randomUUID().slice(0, 8)}_${i}`)
      // A carrier that takes its time to sell a number, each request its own number.
      const slowCarrier = (i: number) => ({
        ...carrier(), name: 'telnyx' as const,
        searchNumbers: async () => [{ e164: `+1503556${String(1000 + i)}` }],
        buyNumber: async (e164: string) => {
          await sleep(300)
          return { e164, providerRef: `ref_${e164}` }
        },
      })
      try {
        // Five in one workspace, ten in workspaces of their own: more than the 10 connections of the pool.
        const answers = workspaces.map((own, i) => {
          const actor: Actor = { ...owner, actorId: `user_burst_${i}`, workspaceId: i < 5 ? workspaces[0]! : own }
          return db.transaction(tx => run(tx, actor, 'phoneNumber.setup', { areaCode: '503', purchase: true }, slowCarrier(i)))
            .then(() => 'set up', (e: Error) => e.message)
        })
        await sleep(100)
        const asked = Date.now()
        await db.execute(sql`select 1`)
        expect(Date.now() - asked).toBeLessThan(2_000)
        const all = await Promise.race([Promise.all(answers), sleep(10_000).then(() => 'hung' as const)])
        expect(all).not.toBe('hung')
        expect(all).toContain('set up')
        for (const answer of all as string[]) expect(answer).toMatch(/^set up$|in the last hour|A workspace can get|Another number is being set up/)
        expect(all).toContain(NUMBER_SETUP_BUSY)
      } finally {
        vi.unstubAllEnvs()
        await db.delete(phone_numbers).where(inArray(phone_numbers.workspace_id, workspaces))
        await db.delete(number_purchases).where(inArray(number_purchases.workspace_id, workspaces))
      }
    }, 20_000)

    test('attaching a number, and the dev carrier, are not limited', () => withSipEndpoint(async tx => {
      await pastPurchases(tx, Array.from({ length: INSTALL_PURCHASES_PER_HOUR }, (_, i) => ({ workspace_id: `ws_many_${i}`, actor_id: `user_many_${i}`, minutesAgo: 5 })))
      expect((await setup(tx, { e164: '+15035550961', purchase: true }, carrier())).rows.phone_numbers?.[0]?.purchased).toBe(true)
      const attach = { ...carrier(['+15035550962']), name: 'telnyx' as const }
      expect((await setup(tx, { e164: '+15035550962' }, attach, admin)).rows.phone_numbers?.[0]?.purchased).toBe(false)
    }))
  })

  test('a number that is not in the account is rejected, not bought: a typo costs nothing', () => inRollback(async tx => {
    const twilio = carrier(['+15035550999'])
    const error = await setup(tx, { e164: '+15035550998' }, twilio).catch(e => e)
    expect(error).toBeInstanceOf(Reject)
    expect(error.message).toBe('+15035550998 is not in the dev account. Check the number; to buy it, pass purchase: true')
    expect(twilio.buyNumber).not.toHaveBeenCalled()
    expect(twilio.routeToSip).not.toHaveBeenCalled()
  }))

  test('buys only with purchase: true, by number or by area code', () => inRollback(async tx => {
    const twilio = carrier()
    const bought = await setup(tx, { e164: '+15035550997', purchase: true }, twilio)
    expect(bought.rows.phone_numbers).toMatchObject([{ e164: '+15035550997', mode: 'new', provider_ref: 'ref_+15035550997' }])
    expect(bought.rows.phone_numbers?.[0]?.verified_at).toBeTruthy()
    expect(twilio.buyNumber).toHaveBeenCalledWith('+15035550997')

    const byArea = await setup(tx, { areaCode: '971', purchase: true }, twilio)
    expect(byArea.rows.phone_numbers?.[0]?.e164).toMatch(/^\+1971/)
    expect(twilio.buyNumber).toHaveBeenCalledTimes(2)

    const owned = carrier(['+15035550996'])
    await setup(tx, { e164: '+15035550996', purchase: true }, owned) // already ours: attach, do not buy again
    expect(owned.buyNumber).not.toHaveBeenCalled()

    const def = actions.get('phoneNumber.setup')!
    expect(def.input.safeParse({ areaCode: '971' }).success).toBe(false) // an area code alone would mean buying
    expect(def.input.safeParse({}).success).toBe(false)
    await expect(setup(tx, { areaCode: '971', purchase: true }, carrier([], { searchNumbers: async () => [] }))).rejects.toThrow('no number available in area code 971')
    await expect(setup(tx, { e164: '+15035550995' }, carrier(['+15035550995']), agent)).rejects.toThrow('no workspace')
  }))

  test('a bought number is released when a later step fails; an attached one is left alone', () => inRollback(async tx => {
    const routeFails = async () => { throw new TelephonyError('dev', 'SIP connection refused') }
    const buying = carrier([], { routeToSip: routeFails })
    const error = await setup(tx, { e164: '+15035550994', purchase: true }, buying).catch(e => e)
    expect(error).toBeInstanceOf(Reject)
    expect(error.message).toBe('dev: SIP connection refused')
    expect(error.notes).toEqual(['+15035550994 was released'])
    expect(buying.releaseNumber).toHaveBeenCalledWith({ e164: '+15035550994', providerRef: 'ref_+15035550994' })
    expect(buying.account.has('+15035550994')).toBe(false)

    const attaching = carrier(['+15035550993'], { routeToSip: routeFails })
    const attachError = await setup(tx, { e164: '+15035550993' }, attaching).catch(e => e)
    expect(attachError.notes).toEqual([])
    expect(attaching.releaseNumber).not.toHaveBeenCalled()

    const stuck = carrier([], { routeToSip: routeFails, releaseNumber: async () => { throw new TelephonyError('dev', 'release refused') } })
    const stuckError = await setup(tx, { e164: '+15035550992', purchase: true }, stuck).catch(e => e)
    expect(stuckError.notes).toEqual(['releasing +15035550992 failed (dev: release refused): release it at the carrier, or set it up again'])
  }))

  test('a failed purchase is a rejection, stores nothing and has nothing to release', () => inRollback(async tx => {
    const failing = carrier([], { buyNumber: async () => { throw new TelephonyError('dev', 'number order o1 failed') } })
    const error = await setup(tx, { e164: '+15035550991', purchase: true }, failing).catch(e => e)
    expect(error).toBeInstanceOf(Reject)
    expect(error.notes).toEqual([])
    expect(failing.routeToSip).not.toHaveBeenCalled()
  }))

  describe('buying outside the US, Canada and Puerto Rico (NUMBER_BUY_COUNTRIES)', () => {
    const inCountry = (tx: Tx, country: string | null) =>
      tx.insert(workspace_settings).values({ workspace_id: WORKSPACE, timezone: 'Europe/Berlin', country })
        .onConflictDoUpdate({ target: workspace_settings.workspace_id, set: { country } })
    const admin: Actor = { ...owner, permissions: [...rolePermissions.owner, 'instance:admin'] }

    test('a workspace in another country cannot buy, by area code or by number, but attaches what it has', () => inRollback(async tx => {
      await inCountry(tx, 'DE')
      const account = carrier(['+493012345678'])
      const search = vi.spyOn(account, 'searchNumbers')
      for (const [input, actor] of [[{ areaCode: '503', purchase: true }, owner], [{ e164: '+15035550901', purchase: true }, owner], [{ areaCode: '503', purchase: true }, admin]] as const) {
        const error = await setup(tx, input, account, actor).catch(e => e)
        expect(error).toBeInstanceOf(Reject)
        expect(error.message).toMatch(new RegExp(`^${BUY_COUNTRIES_ONLY}; this workspace is in DE`))
      }
      expect(search).not.toHaveBeenCalled()
      expect(account.buyNumber).not.toHaveBeenCalled()
      expect(await tx.select().from(number_purchases).where(eq(number_purchases.workspace_id, WORKSPACE))).toEqual([])
      // A number already in the carrier account: attached, also when the caller passed purchase: true.
      const { rows } = await setup(tx, { e164: '+493012345678', purchase: true }, account)
      expect(rows.phone_numbers?.[0]).toMatchObject({ e164: '+493012345678', purchased: false })
    }))

    test('no country set: worked out from the workspace, so a German number it answers counts as Germany', () => inRollback(async tx => {
      await tx.insert(phone_numbers).values({ id: `pn_${crypto.randomUUID().slice(0, 12)}`, workspace_id: WORKSPACE, e164: '+493012345679', provider: 'dev', provider_ref: 'ref_de' })
      await expect(setup(tx, { areaCode: '503', purchase: true }, carrier())).rejects.toThrow(BUY_COUNTRIES_ONLY)
    }))

    test('a workspace in Canada or Puerto Rico buys by its own area codes, searched in its own country (LIN-300)', () => inRollback(async tx => {
      for (const [country, areaCode] of [['CA', '416'], ['PR', '787'], ['PR', '939'], ['US', '503']] as const) {
        await inCountry(tx, country)
        const account = carrier()
        const search = vi.spyOn(account, 'searchNumbers')
        const { rows } = await setup(tx, { areaCode, purchase: true }, account)
        expect(search).toHaveBeenCalledWith({ country, areaCode, limit: 5 })
        expect(rows.phone_numbers?.[0]).toMatchObject({ e164: `+1${areaCode}5550100`, purchased: true, mode: 'new' })
        expect(account.buyNumber).toHaveBeenCalledWith(`+1${areaCode}5550100`)
      }
    }))

    test("an area code of another buying country than the workspace's is refused before the carrier is asked", () => inRollback(async tx => {
      for (const [country, areaCode, message] of [
        ['US', '416', 'Area code 416 is in Canada, but this workspace is in the United States'],
        ['CA', '503', 'Area code 503 is in the United States, but this workspace is in Canada'],
        ['CA', '787', 'Area code 787 is in Puerto Rico, but this workspace is in Canada'],
        ['PR', '212', 'Area code 212 is in the United States, but this workspace is in Puerto Rico'],
      ] as const) {
        await inCountry(tx, country)
        const account = carrier()
        const search = vi.spyOn(account, 'searchNumbers')
        const error = await setup(tx, { areaCode, purchase: true }, account).catch(e => e)
        expect(error).toBeInstanceOf(Reject)
        expect(error.message).toMatch(new RegExp(`^${message}`))
        expect(search).not.toHaveBeenCalled()
        expect(account.buyNumber).not.toHaveBeenCalled()
      }
      expect(await tx.select().from(number_purchases).where(eq(number_purchases.workspace_id, WORKSPACE))).toEqual([])
    }))

    test('a Caribbean or other territory area code is no input at all', () => {
      for (const areaCode of ['876', '809', '242', '340', '671'])
        expect(actions.get('phoneNumber.setup')!.input.safeParse({ areaCode, purchase: true }).success, areaCode).toBe(false)
    })

    test('a workspace in Canada attaches a number it already has, as anywhere', () => inRollback(async tx => {
      await inCountry(tx, 'CA')
      const { rows } = await setup(tx, { e164: '+16135550177', purchase: false }, carrier(['+16135550177']))
      expect(rows.phone_numbers?.[0]).toMatchObject({ e164: '+16135550177', purchased: false })
    }))

    test('the country is worked out from a Puerto Rican number the workspace answers', () => inRollback(async tx => {
      await tx.insert(phone_numbers).values({ id: `pn_${crypto.randomUUID().slice(0, 12)}`, workspace_id: WORKSPACE, e164: '+17875550190', provider: 'dev', provider_ref: 'ref_pr' })
      const account = carrier()
      const search = vi.spyOn(account, 'searchNumbers')
      await expect(setup(tx, { areaCode: '503', purchase: true }, account)).rejects.toThrow(/^Area code 503 is in the United States, but this workspace is in Puerto Rico/)
      await setup(tx, { areaCode: '939', purchase: true }, account)
      expect(search).toHaveBeenCalledWith({ country: 'PR', areaCode: '939', limit: 5 })
    }))

    test('a typed number is bought only in the workspace\'s own country too (LIN-300)', () => inRollback(async tx => {
      await inCountry(tx, 'CA')
      const account = carrier()
      for (const [e164, message] of [
        ['+18765550100', "Number +18765550100 is in Jamaica, but this workspace is in Canada: buy a number there, or change the workspace's country first."],
        ['+15035550904', "Number +15035550904 is in the United States, but this workspace is in Canada: buy a number there, or change the workspace's country first."],
        ['+17875550104', "Number +17875550104 is in Puerto Rico, but this workspace is in Canada: buy a number there, or change the workspace's country first."],
      ] as const) {
        const error = await setup(tx, { e164, purchase: true }, account).catch(e => e)
        expect(error).toBeInstanceOf(Reject)
        expect(error.message).toBe(message)
      }
      expect(account.buyNumber).not.toHaveBeenCalled()
      expect(await tx.select().from(number_purchases).where(eq(number_purchases.workspace_id, WORKSPACE))).toEqual([])
      expect((await setup(tx, { e164: '+14165550104', purchase: true }, account)).rows.phone_numbers?.[0]).toMatchObject({ e164: '+14165550104', purchased: true })
    }))

    test('nothing names the country yet: the area code does, and the number bought then sets it (not a US default)', () => inRollback(async tx => {
      const account = carrier()
      const search = vi.spyOn(account, 'searchNumbers')
      expect((await setup(tx, { areaCode: '787', purchase: true }, account)).rows.phone_numbers?.[0]).toMatchObject({ e164: '+17875550100', purchased: true })
      expect(search).toHaveBeenCalledWith({ country: 'PR', areaCode: '787', limit: 5 })
      // Now a Puerto Rico workspace: a US code is refused like for any workspace there.
      await expect(setup(tx, { areaCode: '503', purchase: true }, account)).rejects.toThrow(/^Area code 503 is in the United States, but this workspace is in Puerto Rico/)
    }))

    test('nothing names the country yet: a typed Puerto Rican number is bought; one outside the buying countries is refused', () => inRollback(async tx => {
      const account = carrier()
      await expect(setup(tx, { e164: '+18765550101', purchase: true }, account)).rejects.toThrow(
        "Number +18765550101 is in Jamaica, but this workspace is in the United States: buy a number there, or change the workspace's country first.",
      )
      expect(account.buyNumber).not.toHaveBeenCalled()
      expect((await setup(tx, { e164: '+17875550105', purchase: true }, account)).rows.phone_numbers?.[0]).toMatchObject({ e164: '+17875550105', purchased: true })
    }))

    test('a workspace in the US, or with nothing known (the US), buys as before', () => inRollback(async tx => {
      const account = carrier()
      expect((await setup(tx, { areaCode: '503', purchase: true }, account)).rows.phone_numbers?.[0]?.purchased).toBe(true)
      await inCountry(tx, 'US')
      expect((await setup(tx, { e164: '+15035550902', purchase: true }, account)).rows.phone_numbers?.[0]?.purchased).toBe(true)
      expect(account.buyNumber).toHaveBeenCalledTimes(2)
    }))
  })

  describe('carrier refusals in the app\'s own words (LIN-300)', () => {
    const purchases = (tx: Tx) => tx.select().from(number_purchases).where(eq(number_purchases.workspace_id, WORKSPACE))
    afterEach(() => vi.restoreAllMocks())

    test('an order that did not complete (cancelled by the adapter): a neutral refusal, no number row, the purchase counts', () => inRollback(async tx => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const account = carrier([], {
        buyNumber: async e164 => {
          throw new TelephonyError('telnyx', `number order order_9 for ${e164} waits for regulatory requirements (address or documents)`, undefined, 'not_activated')
        },
      })
      const error = await setup(tx, { areaCode: '416', purchase: true }, account).catch(e => e)
      expect(error).toBeInstanceOf(Reject)
      expect(error.message).toBe(NUMBER_NOT_ACTIVATED)
      expect(error.message).not.toMatch(/order_9|telnyx|portal/i)
      expect(account.routeToSip).not.toHaveBeenCalled()
      expect(await tx.select().from(phone_numbers).where(eq(phone_numbers.e164, '+14165550100'))).toEqual([])
      // Logged before the carrier was asked: a failed attempt still counts toward the purchase limits.
      expect(await purchases(tx)).toMatchObject([{ e164: '+14165550100' }])
      // The carrier's words stay in the server log.
      expect(logged).toHaveBeenCalledWith('phone setup: telnyx: number order order_9 for +14165550100 waits for regulatory requirements (address or documents)')
    }))

    test('a country whose numbers need documents: a refusal that says so, without the requirement names, before any purchase', () => inRollback(async tx => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await tx.insert(workspace_settings).values({ workspace_id: WORKSPACE, timezone: 'America/Puerto_Rico', country: 'PR' })
      const account = carrier([], {
        searchNumbers: async () => {
          throw new TelephonyError('telnyx', 'local numbers in PR need Address, document_id at Telnyx, which Linedesk cannot submit yet', undefined, 'country_requirements')
        },
      })
      const error = await setup(tx, { areaCode: '787', purchase: true }, account).catch(e => e)
      expect(error.message).toBe(NUMBERS_NEED_DOCUMENTS)
      expect(account.buyNumber).not.toHaveBeenCalled()
      expect(await purchases(tx)).toEqual([])
    }))

    test('other carrier failures keep their text and HTTP status, so the app can say what they mean', () => inRollback(async tx => {
      const account = carrier([], {
        buyNumber: async () => {
          throw new TelephonyError('telnyx', 'POST /number_orders: Insufficient balance', 402)
        },
      })
      await expect(setup(tx, { areaCode: '503', purchase: true }, account)).rejects.toThrow('telnyx: POST /number_orders: Insufficient balance (HTTP 402)')
    }))
  })

  /** A number row as phoneNumber.setup leaves it; `purchased` says whether Linedesk bought it. */
  async function numberRow(tx: Tx, e164: string, values: Partial<typeof phone_numbers.$inferInsert> = {}) {
    const [row] = await tx.insert(phone_numbers).values({ id: `pn_${crypto.randomUUID().slice(0, 12)}`, workspace_id: WORKSPACE, e164, provider: 'telnyx', provider_ref: `ref_${e164}`, ...values }).returning()
    return row!
  }
  const telnyx = (owned: string[] = [], overrides: Partial<TelephonyProvider> = {}) => Object.assign(carrier(owned, overrides), { name: 'telnyx' as const })
  const stillThere = async (tx: Tx, id: string) => (await tx.select().from(phone_numbers).where(eq(phone_numbers.id, id))).length === 1

  test('release: an attached number stays with the business but is taken off Linedesk\'s routing', () => inRollback(async tx => {
    const row = await numberRow(tx, '+15035550881')
    const account = telnyx(['+15035550881'])
    const { data, deleted } = await run(tx, owner, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '(503) 555-0881' }, account)
    expect(data).toEqual({ releasedAtCarrier: false, unroutedAtCarrier: true })
    expect(deleted).toEqual({ phone_numbers: [row.id] }) // browsers drop it at once
    expect(account.releaseNumber).not.toHaveBeenCalled()
    expect(account.unrouteNumber).toHaveBeenCalledWith({ e164: '+15035550881', providerRef: 'ref_+15035550881' })
    expect(account.account.has('+15035550881')).toBe(true)
    // At another carrier than the one in use: only detached here, never touched at the wrong carrier.
    const elsewhere = await numberRow(tx, '+15035550886', { provider: 'twilio' })
    const other = await run(tx, owner, 'phoneNumber.release', { phoneNumberId: elsewhere.id, confirm: '5035550886' }, account)
    expect(other.data).toEqual({ releasedAtCarrier: false, unroutedAtCarrier: false })
    expect(account.unrouteNumber).toHaveBeenCalledOnce()
    expect(await stillThere(tx, row.id)).toBe(false)
  }))

  test('release: a number Linedesk bought goes back to the carrier', () => inRollback(async tx => {
    const row = await numberRow(tx, '+15035550882', { purchased: true, mode: 'new' })
    const account = telnyx(['+15035550882'])
    const { data } = await run(tx, owner, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '+1 503 555 0882' }, account)
    expect(data).toEqual({ releasedAtCarrier: true, unroutedAtCarrier: false })
    expect(account.unrouteNumber).not.toHaveBeenCalled()
    expect(account.releaseNumber).toHaveBeenCalledWith({ e164: '+15035550882', providerRef: 'ref_+15035550882' })
    expect(account.account.has('+15035550882')).toBe(false)
    expect(await stillThere(tx, row.id)).toBe(false)
  }))

  test('release: the typed number must match; other workspaces, the agent and another carrier are refused', () => inRollback(async tx => {
    const row = await numberRow(tx, '+15035550883', { purchased: true })
    const account = telnyx(['+15035550883'])
    await expect(run(tx, owner, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '503 555 0884' }, account)).rejects.toThrow('type the number +15035550883 to confirm')
    const stranger: Actor = { ...owner, workspaceId: `ws_other_${crypto.randomUUID().slice(0, 8)}` }
    await expect(run(tx, stranger, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '5035550883' }, account)).rejects.toThrow('phone number not found')
    await expect(run(tx, agent, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '5035550883' }, account)).rejects.toThrow('no workspace')
    // Bought at Telnyx while Twilio is in use: never released at the wrong carrier.
    const twilio = Object.assign(carrier(['+15035550883']), { name: 'twilio' as const })
    await expect(run(tx, owner, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '5035550883' }, twilio)).rejects.toThrow('telnyx, but twilio is the carrier in use')
    expect(twilio.releaseNumber).not.toHaveBeenCalled()
    expect(account.releaseNumber).not.toHaveBeenCalled()
    expect(rolePermissions.member).not.toContain(actions.get('phoneNumber.release')!.permission)
  }))

  test('release: when the carrier refuses, the release is rejected (and the transaction keeps the number)', () => inRollback(async tx => {
    const row = await numberRow(tx, '+15035550885', { purchased: true })
    const refusing = telnyx(['+15035550885'], { releaseNumber: async () => { throw new TelephonyError('telnyx', 'number has an open port request') } })
    const error = await run(tx, owner, 'phoneNumber.release', { phoneNumberId: row.id, confirm: '5035550885' }, refusing).catch(e => e)
    expect(error).toBeInstanceOf(Reject)
    expect(error.message).toBe('telnyx: number has an open port request')
  }))

  test('setup marks bought numbers as purchased and attached ones not', () => inRollback(async tx => {
    expect((await setup(tx, { e164: '+15035550886', purchase: true }, carrier())).rows.phone_numbers?.[0]?.purchased).toBe(true)
    expect((await setup(tx, { e164: '+15035550887' }, carrier(['+15035550887']))).rows.phone_numbers?.[0]?.purchased).toBe(false)
  }))

  test('a carrier that is selected but not configured is a rejection naming what is missing', () => inRollback(async tx => {
    const saved = { ...process.env }
    const unconfigured = () => runHandler({ tx, actor: owner, now: new Date().toISOString() }, actions.get('phoneNumber.setup')!, { e164: '+15035550993', purchase: false })
    try {
      Object.assign(process.env, { TELEPHONY_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '' })
      await expect(unconfigured()).rejects.toThrow('phone setup is not configured: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN not set')
      Object.assign(process.env, { TELEPHONY_PROVIDER: 'nobody' })
      await expect(unconfigured()).rejects.toThrow(Reject)
    } finally {
      Object.assign(process.env, saved)
    }
  }))

  test('a call on the new number: takeMessage appends action items, flagUrgent sets urgency', () => inRollback(async tx => {
    await run(tx, owner, 'phoneNumber.setup', { e164: '+15035550998' })
    const { data } = await run(tx, agent, 'call.start', { from: '+15035550111', to: '+15035550998' })
    const scoped = { ...agent, workspaceId: data!.workspaceId as string }
    const callId = data!.callId as string

    await run(tx, scoped, 'call.takeMessage', { callId, message: 'Call back about the quote' })
    const taken = await run(tx, scoped, 'call.takeMessage', { callId, message: 'Prefers mornings' })
    expect(taken.rows.calls?.[0]?.action_items).toEqual([{ text: 'Call back about the quote', kind: 'message' }, { text: 'Prefers mornings', kind: 'message' }])

    const flagged = await run(tx, scoped, 'call.flagUrgent', { callId })
    expect(flagged.rows.calls?.[0]?.urgency).toBe('urgent')
  }))

  test('agent calls need the workspace of the call, except call.start', () => inRollback(async tx => {
    await run(tx, owner, 'phoneNumber.setup', { e164: '+15035550998' })
    const { data } = await run(tx, agent, 'call.start', { from: '+15035550111', to: '+15035550998' })
    const callId = data!.callId as string
    const other = { ...agent, workspaceId: 'ws_other' }

    for (const actor of [agent, other]) {
      await expect(run(tx, actor, 'call.appendTranscript', { callId, speaker: 'caller', text: 'Hi', atMs: 0 })).rejects.toThrow(Reject)
      await expect(run(tx, actor, 'call.takeMessage', { callId, message: 'Hi' })).rejects.toThrow(Reject)
      await expect(run(tx, actor, 'call.flagUrgent', { callId })).rejects.toThrow(Reject)
      await expect(run(tx, actor, 'call.finish', { callId })).rejects.toThrow(Reject)
    }
    await expect(run(tx, agent, 'call.finish', { callId })).rejects.toThrow('send x-workspace-id')
  }))

  test('call.start only opens its own call: old live calls are left to the stale call sweep', () => inRollback(async tx => {
    await run(tx, owner, 'phoneNumber.setup', { e164: '+15035550998' })
    const start = () => run(tx, agent, 'call.start', { from: '+15035550111', to: '+15035550998' })
    const lost = (await start()).data!.callId as string
    await tx.update(calls).set({ started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }).where(eq(calls.id, lost))

    const { rows, data } = await start()
    expect(rows.calls?.map(c => c.id)).toEqual([data!.callId])
    const [untouched] = await tx.select().from(calls).where(eq(calls.id, lost))
    expect(untouched?.status).toBe('live')
  }))
})
