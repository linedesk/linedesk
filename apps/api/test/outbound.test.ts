// Outbound destination policy (packages/actions/src/outbound.ts, apps/api/src/outbound-policy.ts): a workspace calls the
// countries of its own Linedesk numbers, per route: through the install's carrier account the install-account numbers'
// countries plus the install's list, through its own account its own numbers' countries only. Checked when contacts are
// saved, again when the agent dials (call.transfer `dialing`), and for the forwarding check. Plus the minute limits,
// the high-risk confirmation and the caller ID.
// Sets instance settings: in INSTANCE_WIDE_FILES (vitest.config.ts).
import { calls, instance_settings, phone_numbers, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import {
  installDestinations,
  outboundLimits,
  transferMinutesAllowed,
  workspaceDestinations,
} from '../src/outbound-policy.ts'
import { setWorkspaceCarrier } from '../src/workspace-carrier.ts'
import { act, agent, createWorkspace, getCall, randomNumber, type Workspace } from './helpers.ts'

const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')
/** A Berlin landline and a German mobile, as real businesses have them. */
const berlin = () => `+4930${digits(8)}`
const germanMobile = () => `+49151${digits(8)}`
const US_MOBILE = '+15035550199'
/** A London landline (020 7946: Ofcom's drama range, never a real line). */
const londonNumber = () => `+44207946${digits(4)}`

const contact = (number: string, over: Record<string, unknown> = {}) => ({
  id: 'oncall',
  name: 'Mike',
  number,
  condition: 'Urgent: a burst pipe',
  hours_only: false,
  ring_seconds: 25,
  if_no_answer: 'message',
  enabled: true,
  ...over,
})

/** A workspace whose only Linedesk number is German (createWorkspace gives a US one: replaced). */
async function germanWorkspace(name: string) {
  const ws = await createWorkspace(name)
  const number = berlin()
  await db.update(phone_numbers).set({ e164: number }).where(eq(phone_numbers.workspace_id, ws.id))
  return { ...ws, number }
}

const startCall = async (ws: Pick<Workspace, 'number'>) =>
  (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data.callId as string
const dial = (ws: Pick<Workspace, 'id'>, callId: string, to: string) =>
  act(agent(ws.id), 'call.transfer', { callId, to, result: 'dialing' })
const setInstall = (countries: string[], confirmHighRisk?: string[]) =>
  act(operator.owner, 'outboundCountries.set', { countries, ...(confirmHighRisk ? { confirmHighRisk } : {}) })
/** Adds a number in the workspace's own carrier account. */
const ownNumber = async (ws: Pick<Workspace, 'id'>, e164: string) => {
  await db
    .insert(phone_numbers)
    .values({ id: `pn_${digits(12)}`, workspace_id: ws.id, e164, provider: 'dev', carrier_account: 'workspace' })
  return { id: ws.id, number: e164 }
}

let operator: Workspace
beforeAll(async () => {
  operator = await createWorkspace('Linedesk Operations')
  await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.owner.userId))
})
afterEach(async () => {
  await db.delete(instance_settings).where(eq(instance_settings.key, 'outbound.countries'))
})

describe('a workspace with a US number (as before)', () => {
  test('may save and dial US numbers; Germany and Canada are refused when saved and when dialled', async () => {
    const ws = await createWorkspace('Brightwater Plumbing')
    const save = (number: string) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: [contact(number)] })
    expect((await save(US_MOBILE)).status).toBe(200)
    expect(await save(germanMobile())).toMatchObject({
      status: 409,
      body: {
        error:
          'Mike: Only numbers in the United States can take transferred calls. Ask your server admin to allow other countries.',
      },
    })
    expect((await save('+16135550123')).status).toBe(409) // Canada is a country of its own
    expect((await save('+18005550199')).status).toBe(422) // toll-free: refused by kind, in any country

    const callId = await startCall(ws)
    expect((await dial(ws, callId, germanMobile())).body.error).toMatch(
      /^transfer refused: Only numbers in the United States/,
    )
    const ok = await dial(ws, callId, US_MOBILE)
    expect(ok.status).toBe(200)
    expect(ok.body.data).toEqual({ callerId: null, maxMinutes: 30 })
  })

  test('the admin allows Canada: Canadian numbers are saved and dialled; the list is shown to members', async () => {
    const ws = await createWorkspace('Border Plumbing')
    expect((await act(ws.owner, 'outbound.countries', {})).body.data).toEqual({ countries: ['US'] })
    const set = await setInstall(['ca'])
    expect(set.status).toBe(200)
    expect(set.body.data).toMatchObject({
      countries: ['CA'],
      fromEnv: false,
      limits: { minutesPerWorkspaceDay: 120, minutesInstallDay: 2000, transferMaxMinutes: 30 },
    })
    expect((await act(ws.owner, 'outbound.countries', {})).body.data).toEqual({ countries: ['CA', 'US'] })
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: [contact('+16135550123')] }))
        .status,
    ).toBe(200)
    expect((await dial(ws, await startCall(ws), '+16135550123')).status).toBe(200)
    expect((await setInstall(['XX'])).body.error).toBe('not a country code: XX')
  })

  test('a frequent toll-fraud destination needs a second confirmation', async () => {
    expect((await setInstall(['CA', 'CU'])).body.error).toBe(
      'Cuba is a frequent toll-fraud destination. Confirm to allow calls there.',
    )
    expect((await setInstall(['CU', 'LV'], ['CU'])).body.error).toBe(
      'Latvia is a frequent toll-fraud destination. Confirm to allow calls there.',
    )
    const ok = await setInstall(['CA', 'CU'], ['CU'])
    expect(ok.status).toBe(200)
    expect(ok.body.data.highRisk).toContain('CU')
    // Already allowed: saving the list again needs no new confirmation.
    expect((await setInstall(['CU', 'MX'])).status).toBe(200)
  })
})

describe('routes: own-account numbers never widen the install trunk (security review H1)', () => {
  test('a US install number and a German own-account number: a German mobile only from the German number', async () => {
    const ws = await createWorkspace('Two Accounts Plumbing')
    const own = await ownNumber(ws, berlin())
    // Saved: the contact is used from every number, so any route's country passes here.
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: [contact(germanMobile())] }))
        .status,
    ).toBe(200)
    const fromUs = await dial(ws, await startCall(ws), germanMobile())
    expect(fromUs.status).toBe(409)
    expect(fromUs.body.error).toMatch(/^transfer refused: Only numbers in the United States/)
    const fromOwnCall = await startCall(own)
    expect((await dial(ws, fromOwnCall, germanMobile())).status).toBe(200)
    await act(agent(ws.id), 'call.transfer', { callId: fromOwnCall, to: germanMobile(), result: 'not_answered' })
    // The own account's route: its own numbers' countries only, not the US install number's nor the install's list.
    await setInstall(['MX'])
    expect((await dial(ws, await startCall(own), US_MOBILE)).body.error).toMatch(
      /^transfer refused: Only numbers in Germany/,
    )
    // And the install's Telnyx ceiling does not get Germany from the own-account number.
    expect(await db.transaction(tx => installDestinations(tx))).not.toContain('DE')
  })

  test('forwarding check: an own-account British number does not let the install check line call Britain', async () => {
    const ws = await createWorkspace('Own Account Checks')
    await ownNumber(ws, londonNumber())
    const [pn] = await db
      .select()
      .from(phone_numbers)
      .where(and(eq(phone_numbers.workspace_id, ws.id), eq(phone_numbers.carrier_account, 'install')))
    const refused = await act(ws.owner, 'phoneNumber.checkForwarding', {
      phoneNumberId: pn!.id,
      businessNumber: londonNumber(),
    })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/^Only numbers in .* can be checked\. Ask your server admin/)
    expect(await db.transaction(tx => installDestinations(tx))).not.toContain('GB')
  })
})

describe('a German workspace', () => {
  test('calls German landlines and mobiles, not the US unless the admin allows it', async () => {
    const ws = await germanWorkspace('Klempnerei Berlin')
    const save = (number: string) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: [contact(number)] })
    expect((await save(germanMobile())).status).toBe(200)
    expect((await save(berlin())).status).toBe(200)
    expect((await save(US_MOBILE)).body.error).toBe(
      'Mike: Only numbers in Germany can take transferred calls. Ask your server admin to allow other countries.',
    )
    expect((await save('+4918012345678')).status).toBe(422) // shared-cost 0180
    expect((await dial(ws, await startCall(ws), germanMobile())).status).toBe(200)
    await setInstall(['US'])
    expect((await save(US_MOBILE)).status).toBe(200)
  })

  test('the agent is checked again when it dials: a country taken off the list since the contact was saved is refused', async () => {
    const ws = await germanWorkspace('Klempnerei Hamburg')
    await setInstall(['US'])
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: [contact(US_MOBILE)] }))
        .status,
    ).toBe(200)
    await setInstall([])
    const refused = await dial(ws, await startCall(ws), US_MOBILE)
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/Only numbers in Germany/)
    // The refusal is in the command log (audit), and nothing is recorded as dialling.
    expect(
      (await getCall((await db.select().from(calls).where(eq(calls.workspace_id, ws.id)))[0]!.id))?.transfer_result,
    ).toBeNull()
  })
})

test('caller ID: a number of the workspace in the destination country, in the same carrier account', async () => {
  const ws = await createWorkspace('Two Countries Plumbing')
  const german = berlin()
  await db.insert(phone_numbers).values({ id: `pn_${digits(12)}`, workspace_id: ws.id, e164: german, provider: 'dev' })
  /** Dials and ends the leg at once (one leg at a time per workspace); the caller ID it got. */
  const callerIdFor = async (to: string) => {
    const callId = await startCall(ws)
    const { data } = (await dial(ws, callId, to)).body
    await act(agent(ws.id), 'call.transfer', { callId, to, result: 'not_answered' })
    return data.callerId
  }
  expect(await callerIdFor(germanMobile())).toBe(german)
  expect(await callerIdFor(US_MOBILE)).toBeNull()
  // With another carrier, or in another carrier account: never through this call's trunk.
  await db.update(phone_numbers).set({ provider: 'telnyx' }).where(eq(phone_numbers.e164, german))
  expect(await callerIdFor(germanMobile())).toBeNull()
  await db
    .update(phone_numbers)
    .set({ provider: 'dev', carrier_account: 'workspace' })
    .where(eq(phone_numbers.e164, german))
  await setInstall(['DE']) // the US number's route reaches Germany only through the install's list now
  expect(await callerIdFor(germanMobile())).toBeNull()
})

test('daily minutes: the leg gets what is left of the day, and a transfer is refused with less than two minutes', async () => {
  const ws = await createWorkspace('Busy Plumbing')
  const used = async (minutes: number) => {
    const at = new Date(Date.now() - minutes * 60_000).toISOString()
    await db.insert(calls).values({
      id: `call_${digits(12)}`,
      workspace_id: ws.id,
      from_number: randomNumber(),
      to_number: ws.number,
      source: 'phone',
      status: 'completed',
      ended_at: new Date().toISOString(),
      transfer_to: US_MOBILE,
      transfer_result: 'connected',
      transfer_at: at,
    })
  }
  await used(100)
  const callId = await startCall(ws)
  const { maxMinutes } = (await dial(ws, callId, US_MOBILE)).body.data
  expect(maxMinutes === 19 || maxMinutes === 20).toBe(true)
  await act(agent(ws.id), 'call.transfer', { callId, to: US_MOBILE, result: 'not_answered' })
  await used(19)
  expect(await dial(ws, await startCall(ws), US_MOBILE)).toMatchObject({
    status: 409,
    body: { error: 'transfer limit reached: 120 minutes of transferred calls a day' },
  })
})

test('limits: 0 turns transfers off, anything else that is not whole minutes too; empty is the default', () => {
  expect(outboundLimits({})).toEqual({ minutesPerWorkspaceDay: 120, minutesInstallDay: 2000, transferMaxMinutes: 30 })
  expect(outboundLimits({ OUTBOUND_MINUTES_PER_WORKSPACE_DAY: '0', TRANSFER_MAX_MINUTES: ' ' })).toMatchObject({
    minutesPerWorkspaceDay: 0,
    transferMaxMinutes: 30,
  })
  expect(outboundLimits({ OUTBOUND_MINUTES_INSTALL_DAY: 'lots', TRANSFER_MAX_MINUTES: '-5' })).toMatchObject({
    minutesInstallDay: 0,
    transferMaxMinutes: 0,
  })
})

test('install-wide minutes: calls through the install account stop at the cap, own-account ones do not', async () => {
  const ws = await createWorkspace('Install Cap Plumbing')
  const now = new Date().toISOString()
  await db.insert(calls).values({
    id: `call_${digits(12)}`,
    workspace_id: ws.id,
    from_number: randomNumber(),
    to_number: ws.number,
    source: 'phone',
    status: 'completed',
    ended_at: now,
    transfer_to: US_MOBILE,
    transfer_result: 'connected',
    transfer_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  })
  const env = { OUTBOUND_MINUTES_INSTALL_DAY: '1' }
  await expect(db.transaction(tx => transferMinutesAllowed(tx, ws.id, now, 'install', env))).rejects.toThrow(
    "transfer limit reached: this server's minutes of transferred calls for today are used up",
  )
  expect(await db.transaction(tx => transferMinutesAllowed(tx, ws.id, now, 'workspace', env))).toBe(30)
  await expect(
    db.transaction(tx =>
      transferMinutesAllowed(tx, ws.id, now, 'workspace', { OUTBOUND_MINUTES_PER_WORKSPACE_DAY: '0' }),
    ),
  ).rejects.toThrow('transfers are off on this server')
})

describe("forwarding check: the install check line, so the install's ceiling", () => {
  test('a German business with a German Linedesk number can check its German line; a British line is refused', async () => {
    const ws = await germanWorkspace('Friseur Berlin')
    const [pn] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
    const check = (businessNumber: string) =>
      act(ws.owner, 'phoneNumber.checkForwarding', { phoneNumberId: pn!.id, businessNumber })
    expect((await check(berlin())).status).toBe(200)
    const refused = await check(londonNumber())
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/^Only numbers in .* can be checked\. Ask your server admin/)
    expect((await check('+4918012345678')).status).toBe(422) // shared-cost: refused by kind
  })

  /** A workspace whose only number is in its own carrier account (bring your own carrier). */
  const ownOnly = async (name: string, e164: string) => {
    const ws = await createWorkspace(name)
    await db
      .update(phone_numbers)
      .set({ e164, carrier_account: 'workspace' })
      .where(eq(phone_numbers.workspace_id, ws.id))
    const [pn] = await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
    return (businessNumber: string) =>
      act(ws.owner, 'phoneNumber.checkForwarding', { phoneNumberId: pn!.id, businessNumber })
  }

  test('a US workspace with only own-account numbers can check its US line (review N1)', async () => {
    const check = await ownOnly('Own Carrier Portland', randomNumber())
    expect((await check('+15035550142')).status).toBe(200)
  })

  test('a British workspace with only own-account numbers cannot check a British line on a US install', async () => {
    const check = await ownOnly('Own Carrier London', londonNumber())
    const refused = await check(londonNumber())
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/^Only numbers in .* can be checked\. Ask your server admin/)
    await setInstall(['GB'])
    expect((await check(londonNumber())).status).toBe(200)
  })
})

describe("the carriers' destination lists", () => {
  test("a workspace's own Telnyx profile gets its own numbers' countries only, never the install's list", async () => {
    const ws = await createWorkspace('Own Telnyx Business')
    await ownNumber(ws, berlin())
    await db.transaction(tx =>
      setWorkspaceCarrier(
        tx,
        ws.id,
        'telnyx',
        { api_key: 'KEY-own-0123456789' },
        ws.owner.userId,
        new Date().toISOString(),
      ),
    )
    expect(await db.transaction(tx => workspaceDestinations(tx, ws.id))).toEqual(['DE'])

    const requests: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${String(url)}`)
      return Response.json({ data: [] })
    })
    try {
      expect((await setInstall(['MX'])).status).toBe(200)
      expect(requests.filter(r => r.includes('telnyx'))).toEqual([])
      expect(await db.transaction(tx => workspaceDestinations(tx, ws.id))).toEqual(['DE'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('the install profiles may call every install-account number’s country plus the install list', async () => {
    await setInstall(['MX'])
    const countries = await db.transaction(tx => installDestinations(tx))
    expect(countries).toContain('MX')
    expect(countries).toContain('US')
  })
})
