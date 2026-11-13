// phoneNumber.setup through the API: a number bought by the command is released whenever the
// command does not commit, also when the failure comes after the handler has finished.
import { phone_numbers, setup_events } from '@linedesk/db'
import { devProvider } from '@linedesk/telephony'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { act, createWorkspace, randomNumber, type Workspace } from './helpers.ts'

// The carrier is the dev provider for this file, whatever another test file picks in the shared
// test database at the same time (admin tests set active providers).
vi.mock('../src/provider-settings.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/provider-settings.ts')>()
  return { ...original, telephonyProvider: async () => devProvider }
})

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
})
afterEach(() => vi.restoreAllMocks())

/** The dev provider as a carrier account that does not have the number yet. */
function emptyAccount() {
  vi.spyOn(devProvider, 'findNumber').mockResolvedValue(null)
  return { buy: vi.spyOn(devProvider, 'buyNumber'), release: vi.spyOn(devProvider, 'releaseNumber') }
}
const stored = async (e164: string) => (await db.select().from(phone_numbers).where(eq(phone_numbers.e164, e164))).length

test('attach is the default and buys nothing; a number that is not in the account is a rejection', async () => {
  const { buy } = emptyAccount()
  const e164 = randomNumber()
  const res = await act(ws.owner, 'phoneNumber.setup', { e164 })
  expect(res.status).toBe(409)
  expect(res.body.error).toContain(`${e164} is not in the dev account`)
  expect(buy).not.toHaveBeenCalled()
  expect(await stored(e164)).toBe(0)
})

test('with purchase: true the number is bought and stored', async () => {
  const { buy, release } = emptyAccount()
  const e164 = randomNumber()
  const res = await act(ws.owner, 'phoneNumber.setup', { e164, purchase: true })
  expect(res.status).toBe(200)
  expect(res.body.rows.phone_numbers).toMatchObject([{ e164, workspace_id: ws.id, mode: 'new' }])
  expect(buy).toHaveBeenCalledWith(e164)
  expect(release).not.toHaveBeenCalled()
  // The setup milestone the go-live checklist's first step and Admin › Onboarding read.
  const milestone = await db
    .select()
    .from(setup_events)
    .where(and(eq(setup_events.workspace_id, ws.id), eq(setup_events.event, 'number_connected')))
  expect(milestone).toHaveLength(1)
})

test('a bought number is released when routing fails unexpectedly', async () => {
  const { release } = emptyAccount()
  vi.spyOn(devProvider, 'routeToSip').mockRejectedValue(new Error('SIP endpoint unreachable'))
  const e164 = randomNumber()
  const res = await act(ws.owner, 'phoneNumber.setup', { e164, purchase: true })
  expect(res.status).toBe(500) // not a carrier rejection: an unexpected error, but the number is still given back
  expect(release).toHaveBeenCalledWith({ e164, providerRef: `dev_${e164}` })
  expect(await stored(e164)).toBe(0)
})

test('a bought number is released when the transaction fails to commit after the handler succeeded', async () => {
  const { buy, release } = emptyAccount()
  const e164 = randomNumber()
  const transaction = db.transaction.bind(db)
  vi.spyOn(db, 'transaction').mockImplementationOnce((async (run: Parameters<typeof db.transaction>[0]) => {
    await transaction(run)
    throw new Error('commit failed')
  }) as typeof db.transaction)

  const res = await act(ws.owner, 'phoneNumber.setup', { e164, purchase: true })
  expect(res.status).toBe(500)
  expect(buy).toHaveBeenCalledWith(e164)
  expect(release).toHaveBeenCalledWith({ e164, providerRef: `dev_${e164}` })
})
