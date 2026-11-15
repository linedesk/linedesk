// Outbound destination policy (packages/actions/src/outbound.ts, apps/api/src/outbound-policy.ts): a workspace calls the
// countries of its own Linedesk numbers, per route: through the install's carrier account the install-account numbers'
// countries plus the install's list, through its own account its own numbers' countries only. Checked when contacts are
// saved, again when the agent dials (call.transfer `dialing`), and for the forwarding check. Plus the minute limits,
// the high-risk confirmation and the caller ID.
// Sets instance settings: in INSTANCE_WIDE_FILES (vitest.config.ts).
import {
  assistants,
  availability_rules,
  calls,
  commands,
  instance_settings,
  phone_numbers,
  user,
  workspace_settings,
} from '@linedesk/db'
import { and, eq, like } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { listAudit } from '../src/audit.ts'
import {
  installDestinations,
  outboundLimits,
  syncTelnyxProfiles,
  transferMinutesAllowed,
  transferMinutesUsed,
  workspaceDestinations,
} from '../src/outbound-policy.ts'
import { setWorkspaceCarrier } from '../src/workspace-carrier.ts'
import { act, agent, createWorkspace, getCall, randomNumber, saveTransferContacts, type Workspace } from './helpers.ts'

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
/** Dials `to` as a saved transfer contact (saveTransferContacts), so only the destination policy decides. */
const dial = async (ws: Pick<Workspace, 'id' | 'assistant'>, callId: string, to: string) => {
  await saveTransferContacts(ws.assistant.id, [to])
  return act(agent(ws.id), 'call.transfer', { callId, to, result: 'dialing' })
}
const setInstall = (countries: string[], confirmHighRisk?: string[]) =>
  act(operator.owner, 'outboundCountries.set', { countries, ...(confirmHighRisk ? { confirmHighRisk } : {}) })
/** Adds a number in the workspace's own carrier account. */
const ownNumber = async (ws: Pick<Workspace, 'id' | 'assistant'>, e164: string) => {
  await db
    .insert(phone_numbers)
    .values({ id: `pn_${digits(12)}`, workspace_id: ws.id, e164, provider: 'dev', carrier_account: 'workspace' })
  return { id: ws.id, assistant: ws.assistant, number: e164 }
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

describe("only the assistant's saved transfer contacts are dialled", () => {
  const report = (ws: Pick<Workspace, 'id'>, callId: string, to: string, result: string) =>
    act(agent(ws.id), 'call.transfer', { callId, to, result })

  test('another number is refused and logged; a saved one is matched as E.164; a contact switched off is refused', async () => {
    const ws = await createWorkspace('Saved Contacts Plumbing')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(
        (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: [contact(US_MOBILE)] }))
          .status,
      ).toBe(200)
      const callId = await startCall(ws)
      const other = await report(ws, callId, '+15035550142', 'dialing')
      expect(other).toMatchObject({
        status: 409,
        body: { error: "transfer refused: the number is not one of the assistant's transfer contacts" },
      })
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/^transfer of call .* refused: the destination is not a saved transfer contact/),
      )
      expect((await getCall(callId))?.transfer_result).toBeNull()
      // The refusal is in the command log.
      const [logged] = await db
        .select()
        .from(commands)
        .where(and(eq(commands.action, 'call.transfer'), eq(commands.workspace_id, ws.id)))
      expect(logged).toMatchObject({ rejected: true })
      // The saved contact in another notation is the same number.
      await db
        .update(assistants)
        .set({ transfers: [contact('+1 (503) 555-0199')] as never })
        .where(eq(assistants.id, ws.assistant.id))
      expect((await report(ws, callId, US_MOBILE, 'dialing')).status).toBe(200)
      await report(ws, callId, US_MOBILE, 'not_answered')
      // Switched off, or without a number: not dialled.
      await saveTransferContacts(ws.assistant.id, [US_MOBILE])
      await db
        .update(assistants)
        .set({ transfers: [contact(US_MOBILE, { enabled: false })] as never })
        .where(eq(assistants.id, ws.assistant.id))
      expect((await report(ws, await startCall(ws), US_MOBILE, 'dialing')).status).toBe(409)
    } finally {
      warn.mockRestore()
    }
  })

  test("a contact of another assistant of the workspace is not the call's", async () => {
    const ws = await createWorkspace('Two Assistants Plumbing')
    const second = (await act(ws.owner, 'assistant.create', {})).body.data.assistantId as string
    await saveTransferContacts(second, [US_MOBILE])
    await saveTransferContacts(ws.assistant.id, ['+15035550187'])
    const callId = await startCall(ws) // answered by the first assistant (the number has none of its own)
    expect((await report(ws, callId, US_MOBILE, 'dialing')).status).toBe(409)
    expect((await report(ws, callId, '+15035550187', 'dialing')).status).toBe(200)
  })

  test("a test call dials no real phone: the call test's simulated contacts are not refused", async () => {
    const ws = await createWorkspace('Test Call Plumbing')
    const testCall = (await act(agent(ws.id), 'call.startTest', { room: `saved-contacts-${digits(6)}` })).body.data
      .callId as string
    expect((await report(ws, testCall, US_MOBILE, 'dialing')).status).toBe(200)
  })
})

describe('results belong to the open leg', () => {
  const report = (ws: Pick<Workspace, 'id'>, callId: string, to: string, result: string) =>
    act(agent(ws.id), 'call.transfer', { callId, to, result })
  const MIKE = US_MOBILE
  const SARAH = '+15035550187'

  test("a late 'failed' of the try before does not end the next contact's leg", async () => {
    const ws = await createWorkspace('Late Report Plumbing')
    await saveTransferContacts(ws.assistant.id, [MIKE, SARAH])
    const callId = await startCall(ws)
    expect((await report(ws, callId, SARAH, 'dialing')).status).toBe(200)
    // Mike's 'failed' (sent before Sarah was dialled) arrives now.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await report(ws, callId, MIKE, 'failed')).status).toBe(200)
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/does not match the open leg; ignored$/))
    } finally {
      warn.mockRestore()
    }
    expect(await getCall(callId)).toMatchObject({ transfer_to: SARAH, transfer_result: 'dialing', transfer_seconds: 0 })
    // The open leg still holds the one slot: another call of the workspace waits.
    expect((await report(ws, await startCall(ws), MIKE, 'dialing')).body.error).toBe(
      'another transfer of this workspace is in progress',
    )
    // Sarah's own result is hers.
    expect((await report(ws, callId, SARAH, 'connected')).status).toBe(200)
    expect((await getCall(callId))?.transfer_result).toBe('connected')
  })

  test('connected without a dial changes nothing and takes no slot', async () => {
    const ws = await createWorkspace('No Dial Plumbing')
    await saveTransferContacts(ws.assistant.id, [MIKE])
    const callId = await startCall(ws)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await report(ws, callId, MIKE, 'connected')).status).toBe(200)
    } finally {
      warn.mockRestore()
    }
    expect(await getCall(callId)).toMatchObject({ transfer_to: null, transfer_result: null })
    expect((await report(ws, await startCall(ws), MIKE, 'dialing')).status).toBe(200)
  })
})

describe('business hours, as the agent keeps them', () => {
  const dialMike = (ws: Workspace, callId: string) =>
    act(agent(ws.id), 'call.transfer', { callId, to: US_MOBILE, result: 'dialing' })
  /** The workspace's hours on, open only on another weekday than today (in its time zone): closed all day. */
  const closedToday = async (ws: Workspace) => {
    const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, ws.id))
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: settings!.timezone }).format(new Date())
    const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day)
    await db.delete(availability_rules).where(eq(availability_rules.workspace_id, ws.id))
    await db.insert(availability_rules).values({
      id: `ar_${digits(10)}`,
      workspace_id: ws.id,
      weekday: (today + 3) % 7,
      start_time: '08:00',
      end_time: '17:00',
    })
    await db
      .update(workspace_settings)
      .set({ business_hours_on: true })
      .where(eq(workspace_settings.workspace_id, ws.id))
  }
  const saveMike = (ws: Workspace, hours_only: boolean) =>
    db
      .update(assistants)
      .set({ transfers: [contact(US_MOBILE, { hours_only })] as never })
      .where(eq(assistants.id, ws.assistant.id))

  test('a contact "only during business hours" is not dialled while closed; one for any time is', async () => {
    const ws = await createWorkspace('Closed Today Plumbing')
    await closedToday(ws)
    await saveMike(ws, true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await dialMike(ws, await startCall(ws))).body.error).toBe(
        'transfer refused: this transfer contact takes calls only while the business is open',
      )
    } finally {
      warn.mockRestore()
    }
    await saveMike(ws, false)
    expect((await dialMike(ws, await startCall(ws))).status).toBe(200)
  })

  test('nobody is dialled in closure mode', async () => {
    const ws = await createWorkspace('On Vacation Plumbing')
    await saveMike(ws, false)
    const shift = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
    await db
      .update(workspace_settings)
      .set({ closure: { from: shift(-2), until: shift(2), greeting: 'We are on vacation.' } })
      .where(eq(workspace_settings.workspace_id, ws.id))
    expect((await dialMike(ws, await startCall(ws))).status).toBe(409)
  })
})

describe('transfer minutes count every leg (rejected tries included)', () => {
  const report = (ws: Pick<Workspace, 'id'>, callId: string, to: string, result: string) =>
    act(agent(ws.id), 'call.transfer', { callId, to, result })
  /** Moves the open leg's dial back by `seconds`, as if it had rung that long. */
  const rang = (callId: string, seconds: number) =>
    db
      .update(calls)
      .set({ transfer_at: new Date(Date.now() - seconds * 1000).toISOString() })
      .where(eq(calls.id, callId))
  const used = (ws: Pick<Workspace, 'id'>) =>
    db.transaction(tx => transferMinutesUsed(tx, new Date().toISOString(), { workspaceId: ws.id }))
  const MIKE = US_MOBILE
  const SARAH = '+15035550187'

  test('a try that rang and was declined, then one put through: both legs count', async () => {
    const ws = await createWorkspace('Two Legs Plumbing')
    await saveTransferContacts(ws.assistant.id, [MIKE, SARAH])
    const callId = await startCall(ws)
    expect((await report(ws, callId, MIKE, 'dialing')).status).toBe(200)
    await rang(callId, 60)
    await report(ws, callId, MIKE, 'declined')
    expect((await getCall(callId))?.transfer_seconds).toBeGreaterThanOrEqual(60)
    expect(await used(ws)).toBeCloseTo(1, 1) // a declined try is not free: it rang and the person was briefed
    expect((await report(ws, callId, SARAH, 'dialing')).status).toBe(200)
    await rang(callId, 4 * 60)
    await report(ws, callId, SARAH, 'connected')
    // The second leg runs until the call ends.
    await db.update(calls).set({ status: 'completed', ended_at: new Date().toISOString() }).where(eq(calls.id, callId))
    expect(await used(ws)).toBeCloseTo(5, 1) // was 4: the declined try's minute was lost when the second dial came
  })

  test('tries nobody took count their ringing; a contact that could not be dialled adds nothing', async () => {
    const ws = await createWorkspace('Nobody Home Plumbing')
    await saveTransferContacts(ws.assistant.id, [MIKE, SARAH])
    const callId = await startCall(ws)
    await report(ws, callId, MIKE, 'failed') // no dial: no leg
    expect((await getCall(callId))?.transfer_seconds).toBe(0)
    await report(ws, callId, MIKE, 'dialing')
    await rang(callId, 30)
    await report(ws, callId, MIKE, 'not_answered')
    await report(ws, callId, SARAH, 'dialing')
    await rang(callId, 30)
    await report(ws, callId, SARAH, 'not_answered')
    await report(ws, callId, SARAH, 'not_answered') // the same result twice: the leg is counted once
    expect(await used(ws)).toBeCloseTo(1, 1) // was 0: the call's last result was not_answered
    // A leg whose result was never reported ends where the next dial starts.
    await report(ws, callId, MIKE, 'dialing')
    await rang(callId, 30)
    await report(ws, callId, SARAH, 'dialing')
    expect((await getCall(callId))?.transfer_seconds).toBeGreaterThanOrEqual(90)
    // A result after the call ended counts the leg only to the call's end.
    await rang(callId, 30)
    await db
      .update(calls)
      .set({ status: 'completed', ended_at: new Date(Date.now() - 15_000).toISOString() })
      .where(eq(calls.id, callId))
    await report(ws, callId, SARAH, 'not_answered')
    const seconds = (await getCall(callId))!.transfer_seconds
    expect(seconds).toBeGreaterThanOrEqual(105)
    expect(seconds).toBeLessThan(115)
  })
})

test('the audit log lists who changed the countries, with the list before', async () => {
  await setInstall(['CA'])
  await setInstall(['MX', 'CA'])
  const { entries } = await listAudit(db, { kind: 'admin', workspaceId: operator.id, limit: 50 })
  const changes = entries.filter(e => e.what === 'outboundCountries.set')
  expect(changes[0]).toMatchObject({
    kind: 'admin',
    actor: { id: operator.owner.userId },
    input: { countries: ['MX', 'CA'] },
  })
  const [logged] = await db.select().from(commands).where(eq(commands.id, changes[0]!.id))
  expect(logged?.result).toMatchObject({ data: { previous: { countries: ['CA'] }, countries: ['CA', 'MX'] } })
})

describe('Telnyx spend limits at start (syncTelnyxProfiles)', () => {
  type Request = { method: string; path: string; body?: Record<string, unknown> }
  /** A Telnyx account holding these voice profiles; a PATCH of a profile in `failing` answers 503. */
  function telnyxAccount(profiles: string[], failing: Set<string> = new Set()) {
    const requests: Request[] = []
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const path = decodeURIComponent(String(url).replace('https://api.telnyx.com/v2', ''))
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ method: init?.method ?? 'GET', path, body })
      if (path.startsWith('/outbound_voice_profiles?'))
        return Response.json({
          data: profiles.filter(name => path.endsWith(`=${name}`)).map(name => ({ id: `ovp_${name}`, name })),
        })
      const patched = path.match(/^\/outbound_voice_profiles\/ovp_(.+)$/)?.[1]
      if (init?.method === 'PATCH' && patched) {
        if (failing.has(patched)) return Response.json({ errors: [{ detail: 'Telnyx is down' }] }, { status: 503 })
        return Response.json({ data: { id: `ovp_${patched}`, ...body } })
      }
      return Response.json({ errors: [{ detail: 'no mock' }] }, { status: 404 })
    }
    return { fetch, requests, patches: () => requests.filter(r => r.method === 'PATCH') }
  }
  const SPEND = { max_destination_rate: 0.1, daily_spend_limit: '50.00', daily_spend_limit_enabled: true }
  const INSTALL_ENV = { TELEPHONY_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEY-install-0123456789' }
  const noWait = { retryMs: [] as number[], sleep: async () => {} }
  const ownTelnyx = (ws: Workspace, key: string) =>
    db.transaction(tx =>
      setWorkspaceCarrier(tx, ws.id, 'telnyx', { api_key: key }, ws.owner.userId, new Date().toISOString()),
    )
  const unconfirmed = async () =>
    (await act(operator.owner, 'outboundCountries.get', {})).body.data.spendCapsUnconfirmed as { profile: string }[]
  const spendRows = () => db.select().from(instance_settings).where(like(instance_settings.key, 'telnyx.spendCaps:%'))

  beforeEach(async () => {
    // Each test starts without workspaces on their own Telnyx account (earlier tests leave some) and without records.
    await db.update(workspace_settings).set({ carrier: 'default' }).where(eq(workspace_settings.carrier, 'telnyx'))
    await db.delete(instance_settings).where(like(instance_settings.key, 'telnyx.spendCaps:%'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("a workspace's existing own profile gets its countries and the limits, with its name, no new password", async () => {
    const ws = await createWorkspace('Older Telnyx Business')
    await ownNumber(ws, berlin())
    await ownTelnyx(ws, 'KEY-older-0123456789')
    const profile = `linedesk-outbound-${ws.id}`
    const telnyx = telnyxAccount([profile])
    expect(await syncTelnyxProfiles({ fetch: telnyx.fetch, env: { TELNYX_DAILY_SPEND_LIMIT: '40' }, ...noWait })).toBe(
      true,
    )
    expect(telnyx.patches()).toEqual([
      {
        method: 'PATCH',
        path: `/outbound_voice_profiles/ovp_${profile}`,
        body: { name: profile, whitelisted_destinations: ['DE'], ...SPEND, daily_spend_limit: '40.00' },
      },
    ])
    expect(telnyx.requests.some(r => r.path.startsWith('/credential_connections'))).toBe(false)
    expect(await unconfirmed()).toEqual([])
  })

  test('the install profiles: each gets the limits on its own, and a failing one does not skip the other', async () => {
    const telnyx = telnyxAccount(['linedesk-outbound', 'linedesk-forwarding-check'], new Set(['linedesk-outbound']))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await syncTelnyxProfiles({ fetch: telnyx.fetch, env: INSTALL_ENV, ...noWait })).toBe(false)
    expect(telnyx.patches().map(p => p.path)).toEqual([
      '/outbound_voice_profiles/ovp_linedesk-outbound',
      '/outbound_voice_profiles/ovp_linedesk-forwarding-check',
    ])
    expect(telnyx.patches()[1]?.body).toMatchObject({ name: 'linedesk-forwarding-check', ...SPEND })
    expect(telnyx.patches()[1]?.body?.whitelisted_destinations).toContain('US')
    expect(errors.mock.calls.map(c => String(c[0]))).toContainEqual(
      expect.stringMatching(/^ALERT outbound: the install's Telnyx voice profile "linedesk-outbound" was not updated/),
    )
    expect((await unconfirmed()).map(p => p.profile)).toEqual(['linedesk-outbound'])
  })

  test('a Telnyx error: ALERT, never throws, retried after each wait; the warning stays until a try confirms', async () => {
    const failing = new Set(['linedesk-outbound'])
    const telnyx = telnyxAccount(['linedesk-outbound'], failing)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const waits: number[] = []
    const sleep = async (ms: number) => {
      waits.push(ms)
      // Telnyx answers again before the second retry.
      if (waits.length === 2) failing.clear()
      expect((await unconfirmed()).map(p => p.profile)).toEqual(['linedesk-outbound'])
    }
    expect(await syncTelnyxProfiles({ fetch: telnyx.fetch, env: INSTALL_ENV, retryMs: [5, 10, 20], sleep })).toBe(true)
    expect(waits).toEqual([5, 10])
    expect(telnyx.patches()).toHaveLength(3)
    expect(errors.mock.calls.filter(c => String(c[0]).startsWith('ALERT outbound'))).toHaveLength(2)
    expect(await unconfirmed()).toEqual([])
  })

  test('gives up after the last wait, says so, and leaves the warning', async () => {
    const telnyx = telnyxAccount(['linedesk-outbound'], new Set(['linedesk-outbound']))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const waits: number[] = []
    const result = await syncTelnyxProfiles({
      fetch: telnyx.fetch,
      env: INSTALL_ENV,
      retryMs: [1, 2],
      sleep: async ms => {
        waits.push(ms)
      },
    })
    expect(result).toBe(false)
    expect(waits).toEqual([1, 2])
    expect(errors.mock.calls.map(c => String(c[0]))).toContainEqual(
      expect.stringMatching(/Telnyx spend limits not confirmed after 3 tries/),
    )
    expect((await unconfirmed()).map(p => p.profile)).toEqual(['linedesk-outbound'])
  })

  test('a bad env value: ALERT, never throws, retried, nothing sent to Telnyx, every profile warned', async () => {
    const ws = await createWorkspace('Bad Env Business')
    await ownNumber(ws, berlin())
    await ownTelnyx(ws, 'KEY-badenv-0123456789')
    const telnyx = telnyxAccount(['linedesk-outbound', `linedesk-outbound-${ws.id}`])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const waits: number[] = []
    const result = await syncTelnyxProfiles({
      fetch: telnyx.fetch,
      env: { ...INSTALL_ENV, TELNYX_DAILY_SPEND_LIMIT: 'fifty' },
      retryMs: [1],
      sleep: async ms => {
        waits.push(ms)
      },
    })
    expect(result).toBe(false)
    expect(waits).toEqual([1])
    expect(telnyx.requests).toEqual([])
    expect(errors.mock.calls.map(c => String(c[0]))).toContainEqual(
      expect.stringMatching(/ALERT outbound: .* TELNYX_DAILY_SPEND_LIMIT=fifty is not a positive amount/),
    )
    expect((await unconfirmed()).map(p => p.profile).sort()).toEqual(
      [`linedesk-forwarding-check`, 'linedesk-outbound', `linedesk-outbound-${ws.id}`].sort(),
    )
  })

  test('warns at start about limits so high they barely limit', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await syncTelnyxProfiles({ env: { TELNYX_MAX_DESTINATION_RATE: '3' }, ...noWait })
    expect(warnings.mock.calls.map(c => String(c[0]))).toContainEqual(
      expect.stringMatching(/TELNYX_MAX_DESTINATION_RATE is \$3\/min, above \$1\/min/),
    )
  })

  test('without countries to give, an existing profile still gets the limits (its countries left as they are)', async () => {
    // A workspace on its own Telnyx account without own-account numbers.
    const ws = await createWorkspace('No Own Numbers Business')
    await ownTelnyx(ws, 'KEY-nonumbers-0123456789')
    const profile = `linedesk-outbound-${ws.id}`
    const telnyx = telnyxAccount([profile])
    expect(await syncTelnyxProfiles({ fetch: telnyx.fetch, ...noWait })).toBe(true)
    expect(telnyx.patches()).toEqual([
      { method: 'PATCH', path: `/outbound_voice_profiles/ovp_${profile}`, body: { name: profile, ...SPEND } },
    ])
  })

  test('reading the install carrier or the workspace list fails: ALERT, no throw, and Server admin warns', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('database is down'))
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('database is down')
    })
    expect(await syncTelnyxProfiles({ env: INSTALL_ENV, ...noWait })).toBe(false)
    vi.restoreAllMocks()
    expect((await unconfirmed()).map(p => p.profile).sort()).toEqual(
      ['linedesk-forwarding-check', 'linedesk-outbound', 'linedesk-outbound-<workspace id>'].sort(),
    )
    expect(errors.mock.calls.map(c => String(c[0]))).toContainEqual(
      expect.stringMatching(/ALERT outbound: workspaces' Telnyx voice profiles were not updated: database is down/),
    )
    // A sync that can read everything again clears them.
    expect(await syncTelnyxProfiles({ fetch: telnyxAccount([]).fetch, env: INSTALL_ENV, ...noWait })).toBe(true)
    expect(await unconfirmed()).toEqual([])
  })

  test('a malformed record is skipped and logged, never breaks Server admin', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await db.insert(instance_settings).values([
      { key: 'telnyx.spendCaps:linedesk-broken', value: 'not json' },
      { key: 'telnyx.spendCaps:linedesk-outbound', value: JSON.stringify({ problem: 'x', at: new Date().toISOString() }) },
    ])
    expect((await unconfirmed()).map(p => p.profile)).toEqual(['linedesk-outbound'])
    expect(errors.mock.calls.map(c => String(c[0]))).toContainEqual(
      expect.stringMatching(/"linedesk-broken" is not valid JSON; skipped/),
    )
  })

  test('a profile that does not exist is left alone (the next set-up creates it with the limits)', async () => {
    const telnyx = telnyxAccount([])
    expect(await syncTelnyxProfiles({ fetch: telnyx.fetch, env: INSTALL_ENV, ...noWait })).toBe(true)
    expect(telnyx.patches()).toEqual([])
    expect(await spendRows()).toEqual([])
  })
})
