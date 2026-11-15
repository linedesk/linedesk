// One meaning of "forwarding works" (verified_at on the number): a number callers dial directly needs no check, a
// number the business forwards to is verified only by a check or a forwarded call, and a new pick-up mode starts over.
import { phone_numbers } from '@linedesk/db'
import { devProvider } from '@linedesk/telephony'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { act, createWorkspace, randomNumber, type Workspace } from './helpers.ts'

// The carrier is the dev provider for this file, whatever another test file picks in the shared test database.
vi.mock('../src/provider-settings.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/provider-settings.ts')>()
  return { ...original, telephonyProvider: async () => devProvider }
})

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
})
afterEach(() => vi.restoreAllMocks())

/** Buys a number in the given mode (the dev account does not have it yet). */
async function buy(mode?: 'new' | 'forward_conditional' | 'forward_all') {
  vi.spyOn(devProvider, 'findNumber').mockResolvedValueOnce(null)
  const e164 = randomNumber()
  const res = await act(ws.owner, 'phoneNumber.setup', { e164, purchase: true, ...(mode ? { mode } : {}) })
  expect(res.status).toBe(200)
  return res.body.rows.phone_numbers[0] as { id: string; mode: string; verified_at: string | null }
}
const verifiedAt = async (id: string) =>
  (await db.select({ at: phone_numbers.verified_at }).from(phone_numbers).where(eq(phone_numbers.id, id)))[0]?.at

test('a bought number callers dial directly needs no check', async () => {
  const number = await buy()
  expect(number.mode).toBe('new')
  expect(number.verified_at).not.toBeNull()
})

test('a bought number the business forwards to is not verified until a check or a forwarded call', async () => {
  const conditional = await buy('forward_conditional')
  expect(conditional.verified_at).toBeNull()
  expect(await verifiedAt(conditional.id)).toBeNull()
  const all = await buy('forward_all')
  expect(all.verified_at).toBeNull()
})

test('a new pick-up mode resets the check; the same mode or the assistant alone keeps it', async () => {
  const number = await buy('forward_conditional')
  const verified = '2026-11-10T17:00:00.000Z'
  const verify = () => db.update(phone_numbers).set({ verified_at: verified }).where(eq(phone_numbers.id, number.id))
  const update = (input: Record<string, unknown>) =>
    act(ws.owner, 'phoneNumber.update', { phoneNumberId: number.id, ...input })

  await verify()
  // The same mode again, or only the assistant: still verified.
  expect((await update({ mode: 'forward_conditional' })).status).toBe(200)
  expect((await update({ assistantId: ws.assistant.id })).status).toBe(200)
  expect(await verifiedAt(number.id)).not.toBeNull()

  // Missed calls to every call: other codes, checked again. The answer carries the reset row.
  const res = await update({ mode: 'forward_all' })
  expect(res.status).toBe(200)
  expect(res.body.rows.phone_numbers[0]).toMatchObject({ mode: 'forward_all', verified_at: null })
  expect(await verifiedAt(number.id)).toBeNull()

  // A number callers dialled directly that becomes a forwarding target: also unverified.
  const direct = await buy()
  expect(direct.verified_at).not.toBeNull()
  expect(
    (await act(ws.owner, 'phoneNumber.update', { phoneNumberId: direct.id, mode: 'forward_conditional' })).status,
  ).toBe(200)
  expect(await verifiedAt(direct.id)).toBeNull()
})
