// Numbers in a workspace's own carrier account: set up, routed, released and un-routed with that
// workspace's credentials only, and the credentials cannot be switched away from numbers that need them.
// Twilio is a fake with several accounts, told apart by the credentials, like Twilio's own API.
import { commands, phone_numbers } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { lockWorkspaceCarrier } from '../src/workspace-carrier.ts'
import { act, agent, createWorkspace, randomNumber, type User, type Workspace } from './helpers.ts'

const SIP = 'sip.linedesk.test'
const sid = (prefix: string, digit: string) => `${prefix}${digit.repeat(32)}`

type Account = {
  sid: string
  authToken: string
  apiKey: { sid: string; secret: string }
  numbers: { sid: string; phone_number: string }[]
  trunks: { sid: string; friendly_name: string; domain_name?: string }[]
  originations: string[]
  attached: string[]
  /** Outbound: SIP credential lists and their users, and which lists are on which trunk. */
  credentialLists?: {
    sid: string
    friendly_name: string
    users: { sid: string; username: string; password: string }[]
  }[]
  trunkLists?: string[]
}
const account = (digit: string): Account => ({
  sid: sid('AC', digit),
  authToken: `auth-token-${digit.repeat(20)}`,
  apiKey: { sid: sid('SK', digit), secret: `api-key-secret-${digit.repeat(20)}` },
  numbers: [],
  trunks: [],
  originations: [],
  attached: [],
})

type Seen = { account: string | null; method: string; path: string }

/** LiveKit's SIP outbound trunks (Twirp), in memory. */
type LivekitTrunk = { sipTrunkId: string; name: string; numbers: string[]; address: string; authUsername: string }
let livekitTrunks: LivekitTrunk[] = []
/** The trunk changes, in order: "create <id>" and "delete <id>". */
let livekitOps: string[] = []
let trunkSeq = 0
const LIVEKIT = 'http://livekit.test'
function fakeLivekit(url: URL, init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body ?? '{}'))
  const method = url.pathname.split('/').at(-1)
  if (method === 'ListSIPOutboundTrunk') return Response.json({ items: livekitTrunks })
  if (method === 'CreateSIPOutboundTrunk') {
    const trunk = { sipTrunkId: `ST_${++trunkSeq}`, ...body.trunk }
    livekitTrunks.push(trunk)
    livekitOps.push(`create ${trunk.sipTrunkId}`)
    return Response.json(trunk)
  }
  if (method === 'DeleteSIPTrunk') {
    livekitTrunks = livekitTrunks.filter(t => t.sipTrunkId !== body.sipTrunkId)
    livekitOps.push(`delete ${body.sipTrunkId}`)
    return Response.json({})
  }
  return Response.json({ msg: 'no fake' }, { status: 404 })
}

/** Twilio for several accounts; a request is in the account its credentials belong to, else 401. */
function fakeTwilio(accounts: Account[]) {
  const seen: Seen[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.origin === LIVEKIT) return fakeLivekit(url, init)
    const method = init?.method ?? 'GET'
    const auth = String(((init?.headers ?? {}) as Record<string, string>).authorization ?? '')
    const [user, password] = Buffer.from(auth.replace(/^Basic /, ''), 'base64')
      .toString()
      .split(':')
    const owner = accounts.find(
      a => (user === a.sid && password === a.authToken) || (user === a.apiKey.sid && password === a.apiKey.secret),
    )
    seen.push({ account: owner?.sid ?? null, method, path: url.pathname })
    if (!owner) return Response.json({ message: 'Authenticate' }, { status: 401 })
    const form = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {}
    const base = `/2010-04-01/Accounts/${owner.sid}`
    const path = url.pathname
    if (path.startsWith('/2010-04-01/Accounts/') && !path.startsWith(`${base}/`))
      return Response.json({ message: 'not your account' }, { status: 403 })
    if (method === 'GET' && path === `${base}/IncomingPhoneNumbers.json`) {
      const wanted = url.searchParams.get('PhoneNumber')
      return Response.json({ incoming_phone_numbers: owner.numbers.filter(n => !wanted || n.phone_number === wanted) })
    }
    if (method === 'DELETE' && path.startsWith(`${base}/IncomingPhoneNumbers/`)) {
      owner.numbers = owner.numbers.filter(n => !path.endsWith(`/${n.sid}.json`))
      return new Response(null, { status: 204 })
    }
    if (method === 'GET' && path === '/v1/Trunks') return Response.json({ trunks: owner.trunks })
    if (method === 'POST' && path === '/v1/Trunks') {
      owner.trunks.push({
        sid: `TK${owner.trunks.length}${owner.sid.slice(-4)}`,
        friendly_name: form.FriendlyName!,
        domain_name: form.DomainName,
      })
      return Response.json(owner.trunks.at(-1), { status: 201 })
    }
    owner.credentialLists ??= []
    const lists = owner.credentialLists
    if (method === 'GET' && path === `${base}/SIP/CredentialLists.json`)
      return Response.json({ credential_lists: lists.map(({ sid, friendly_name }) => ({ sid, friendly_name })) })
    if (method === 'POST' && path === `${base}/SIP/CredentialLists.json`) {
      lists.push({ sid: `CL${lists.length}`, friendly_name: form.FriendlyName!, users: [] })
      return Response.json(lists.at(-1), { status: 201 })
    }
    const list = lists.find(l => path.startsWith(`${base}/SIP/CredentialLists/${l.sid}/`))
    if (list && method === 'GET' && path.endsWith('/Credentials.json'))
      return Response.json({ credentials: list.users.map(({ sid, username }) => ({ sid, username })) })
    if (list && method === 'POST' && path.endsWith('/Credentials.json')) {
      list.users.push({ sid: `CR${list.users.length}`, username: form.Username!, password: form.Password! })
      return Response.json({}, { status: 201 })
    }
    if (list && method === 'POST' && path.includes('/Credentials/')) {
      list.users[0]!.password = form.Password!
      return Response.json({})
    }
    const outboundTrunk = owner.trunks.find(
      t => t.friendly_name.startsWith('linedesk-outbound') && path.startsWith(`/v1/Trunks/${t.sid}/`),
    )?.sid
    if (outboundTrunk && path === `/v1/Trunks/${outboundTrunk}/CredentialLists`) {
      owner.trunkLists ??= []
      if (method === 'POST') owner.trunkLists.push(form.CredentialListSid!)
      return Response.json({ credential_lists: owner.trunkLists.map(sid => ({ sid })) })
    }
    const trunk = owner.trunks[0]?.sid
    if (method === 'GET' && path === `/v1/Trunks/${trunk}/OriginationUrls`)
      return Response.json({ origination_urls: owner.originations.map((sip_url, i) => ({ sid: `OU${i}`, sip_url })) })
    if (method === 'POST' && path === `/v1/Trunks/${trunk}/OriginationUrls`) {
      owner.originations.push(form.SipUrl!)
      return Response.json({}, { status: 201 })
    }
    if (method === 'GET' && path === `/v1/Trunks/${trunk}/PhoneNumbers`)
      return Response.json({ phone_numbers: owner.attached.map(s => ({ sid: s })) })
    if (method === 'POST' && path === `/v1/Trunks/${trunk}/PhoneNumbers`) {
      owner.attached.push(form.PhoneNumberSid!)
      return Response.json({}, { status: 201 })
    }
    if (method === 'DELETE' && path.startsWith(`/v1/Trunks/${trunk}/PhoneNumbers/`)) {
      owner.attached = owner.attached.filter(s => !path.endsWith(`/${s}`))
      return new Response(null, { status: 204 })
    }
    return Response.json({ message: `no fake for ${method} ${path}` }, { status: 404 })
  })
  return seen
}

const inWs = (who: User, ws: Workspace) => ({ headers: { ...who.headers, 'x-workspace-id': ws.id } })
const useTwilio = (ws: Workspace, a: Account, auth: 'token' | 'key' = 'token') =>
  act(inWs(ws.owner, ws), 'carrier.set', {
    carrier: 'twilio',
    values:
      auth === 'token'
        ? { account_sid: a.sid, auth_token: a.authToken }
        : { account_sid: a.sid, api_key_sid: a.apiKey.sid, api_key_secret: a.apiKey.secret },
  })
const numberRow = async (e164: string) => (await db.select().from(phone_numbers).where(eq(phone_numbers.e164, e164)))[0]

let wsA: Workspace
let wsB: Workspace
let accountA: Account
let accountB: Account
let seen: Seen[]

beforeAll(async () => {
  wsA = await createWorkspace('Brightwater Plumbing & Heating')
  wsB = await createWorkspace('Other Business')
})

beforeEach(async () => {
  vi.stubEnv('LIVEKIT_SIP_ENDPOINT', SIP)
  vi.stubEnv('LIVEKIT_URL', LIVEKIT.replace('http', 'ws'))
  vi.stubEnv('LIVEKIT_API_KEY', 'devkey')
  vi.stubEnv('LIVEKIT_API_SECRET', 'devsecret-for-tests-only-0123456789')
  livekitTrunks = []
  livekitOps = []
  accountA = account('a')
  accountB = account('b')
  seen = fakeTwilio([accountA, accountB])
  for (const ws of [wsA, wsB]) {
    await db.delete(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
    await act(inWs(ws.owner, ws), 'carrier.set', { carrier: 'default' })
  }
  await useTwilio(wsA, accountA)
  await useTwilio(wsB, accountB)
  seen.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('numbers in a workspace carrier account', () => {
  test("attaching uses the workspace's own account and routes the number there to LiveKit SIP", async () => {
    const e164 = randomNumber()
    accountA.numbers.push({ sid: 'PNa1', phone_number: e164 })
    const res = await act(inWs(wsA.owner, wsA), 'phoneNumber.setup', { e164 })
    expect(res.status).toBe(200)
    expect(await numberRow(e164)).toMatchObject({
      workspace_id: wsA.id,
      provider: 'twilio',
      provider_ref: 'PNa1',
      carrier_account: 'workspace',
      purchased: false,
    })
    // Inbound trunk, and the outbound trunk for warm transfers named after this workspace.
    expect(accountA.trunks.map(t => t.friendly_name)).toEqual(['linedesk-livekit', `linedesk-outbound-${wsA.id}`])
    expect(accountA.originations).toEqual([`sip:${SIP};transport=tcp`])
    expect(accountA.attached).toEqual(['PNa1'])
    expect(new Set(seen.map(s => s.account))).toEqual(new Set([accountA.sid]))
    expect(accountB.trunks).toEqual([])
  })

  test("a number in another workspace's account cannot be attached: it is looked up in your own", async () => {
    const e164 = randomNumber()
    accountA.numbers.push({ sid: 'PNa2', phone_number: e164 })
    const res = await act(inWs(wsB.owner, wsB), 'phoneNumber.setup', { e164 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(
      `${e164} is not in the twilio account. Check the number; to buy it, pass purchase: true`,
    )
    expect(seen.every(s => s.account === accountB.sid && s.method === 'GET')).toBe(true)
    expect(await numberRow(e164)).toBeUndefined()
  })

  test("releasing a number goes to the account it is in, with that workspace's credentials", async () => {
    const e164 = randomNumber()
    accountA.numbers.push({ sid: 'PNa3', phone_number: e164 })
    await act(inWs(wsA.owner, wsA), 'phoneNumber.setup', { e164 })
    const row = (await numberRow(e164))!
    seen.length = 0
    const res = await act(inWs(wsA.owner, wsA), 'phoneNumber.release', { phoneNumberId: row.id, confirm: e164 })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ releasedAtCarrier: false, unroutedAtCarrier: true })
    expect(accountA.attached).toEqual([])
    expect(accountA.numbers.map(n => n.phone_number)).toEqual([e164]) // attached: it stays the business's
    expect(new Set(seen.map(s => s.account))).toEqual(new Set([accountA.sid]))
    // Another workspace cannot release it at all.
    await act(inWs(wsA.owner, wsA), 'phoneNumber.setup', { e164 })
    const again = (await numberRow(e164))!
    expect(
      (await act(inWs(wsB.owner, wsB), 'phoneNumber.release', { phoneNumberId: again.id, confirm: e164 })).body.error,
    ).toBe('phone number not found')
  })

  test('the install carrier keeps its numbers: they stay `install` when the workspace brings its own', async () => {
    const [installNumber] = await db
      .insert(phone_numbers)
      .values({ id: `pn_${crypto.randomUUID()}`, workspace_id: wsA.id, e164: randomNumber(), provider: 'dev' })
      .returning()
    expect(installNumber!.carrier_account).toBe('install')
    // Releasing it does not reach the workspace's account.
    seen.length = 0
    const res = await act(inWs(wsA.owner, wsA), 'phoneNumber.release', {
      phoneNumberId: installNumber!.id,
      confirm: installNumber!.e164,
    })
    expect(res.status).toBe(200)
    expect(seen).toEqual([])
  })
})

describe('changing the carrier while numbers are in the account', () => {
  async function connectedNumber() {
    const e164 = randomNumber()
    accountA.numbers.push({ sid: 'PNa4', phone_number: e164 })
    await act(inWs(wsA.owner, wsA), 'phoneNumber.setup', { e164 })
    seen.length = 0
    return e164
  }

  test('switching carrier, or back to the default, is refused until the numbers are disconnected', async () => {
    const e164 = await connectedNumber()
    for (const input of [{ carrier: 'default' }, { carrier: 'telnyx', values: { api_key: 'KEY-0123456789abcdef' } }]) {
      const res = await act(inWs(wsA.owner, wsA), 'carrier.set', input)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe(`${e164} is in your own Twilio account. Disconnect it first.`)
    }
    expect((await act(inWs(wsA.owner, wsA), 'carrier.get', {})).body.data.carrier).toBe('twilio')
  })

  test('credentials of another account are refused; a new key of the same account is checked and kept', async () => {
    const e164 = await connectedNumber()
    const other = await useTwilio(wsA, accountB)
    expect(other.status).toBe(409)
    expect(other.body.error).toBe(
      `${e164} is not in the account of the new credentials. Use credentials of the account it is in.`,
    )

    const rotated = await useTwilio(wsA, accountA, 'key')
    expect(rotated.status).toBe(200)
    expect(rotated.body.data.fields.find((f: { field: string }) => f.field === 'api_key_sid').value).toBe(
      accountA.apiKey.sid,
    )
    // The numbers were only looked up to check them; afterwards the transfer trunk was set up again.
    expect(seen.filter(s => s.path.includes('IncomingPhoneNumbers')).every(s => s.method === 'GET')).toBe(true)
    expect(livekitTrunks.map(t => t.name)).toEqual([
      expect.stringMatching(new RegExp(`^linedesk-outbound-${wsA.id}-[0-9a-f]{12}$`)),
    ])

    accountA.authToken = 'revoked'
    const wrong = await act(inWs(wsA.owner, wsA), 'carrier.set', {
      carrier: 'twilio',
      values: { account_sid: accountA.sid, auth_token: 'not-the-token-0123456789' },
    })
    expect(wrong.body.error).toBe('Twilio rejected the new credentials (HTTP 401)')
  })
})

describe('carrier changes and number setup are serialised per workspace', () => {
  /** Holds the workspace's carrier lock in another transaction until `release` is called. */
  async function holdLock(workspaceId: string) {
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>(resolve => (locked = resolve))
    const tx = db.transaction(async t => {
      await lockWorkspaceCarrier(t, workspaceId)
      locked()
      await released
    })
    await isLocked
    return {
      release: async () => {
        release()
        await tx
      },
    }
  }

  const inputs: [string, () => Record<string, string>][] = [
    ['carrier.set', () => ({ carrier: 'default' })],
    ['phoneNumber.setup', () => ({ e164: randomNumber() })],
  ]
  for (const [name, makeInput] of inputs) {
    test(`${name} waits while the carrier is locked`, async () => {
      const input = makeInput()
      if (input.e164) accountA.numbers.push({ sid: 'PNa9', phone_number: input.e164 })
      const lock = await holdLock(wsA.id)
      let finished = false
      const pending = act(inWs(wsA.owner, wsA), name, input).then(res => {
        finished = true
        return res
      })
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(finished).toBe(false)
      await lock.release()
      expect((await pending).status).toBe(200)
    })
  }
})

describe('warm transfers dial out through the account the called number is in', () => {
  async function ownNumber(into: Account = accountA, e164 = randomNumber()) {
    into.numbers.push({ sid: `PN${into.numbers.length}`, phone_number: e164 })
    expect((await act(inWs(wsA.owner, wsA), 'phoneNumber.setup', { e164 })).status).toBe(200)
    return e164
  }
  const outboundUsers = (a: Account) =>
    (a.credentialLists ?? []).filter(l => l.friendly_name.startsWith('linedesk-outbound')).flatMap(l => l.users)

  test('connecting a number sets up linedesk-outbound-<workspace> in that account and a LiveKit trunk with the number', async () => {
    const from = await ownNumber()
    const list = accountA.credentialLists!.find(l => l.friendly_name === `linedesk-outbound-${wsA.id}`)!
    expect(list.users).toHaveLength(1)
    expect(accountA.trunks.find(t => t.friendly_name === `linedesk-outbound-${wsA.id}`)?.domain_name).toMatch(
      /^linedesk-outbound-[0-9a-f]{12}\.pstn\.twilio\.com$/,
    )
    expect(livekitTrunks).toHaveLength(1)
    expect(livekitTrunks[0]).toMatchObject({ numbers: [from], authUsername: list.users[0]!.username })
    expect(accountB.trunks).toEqual([])

    const route = await act(agent(wsA.id), 'carrier.transferTrunk', { from })
    expect(route.body.data).toEqual({ carrier: 'twilio', trunkName: livekitTrunks[0]!.name })
    // No credential goes to the agent.
    expect(JSON.stringify(route.body)).not.toContain(list.users[0]!.password)
  })

  test('two workspaces in one account get their own carrier-side objects and never rotate each other', async () => {
    await act(inWs(wsB.owner, wsB), 'carrier.set', {
      carrier: 'twilio',
      values: { account_sid: accountA.sid, auth_token: accountA.authToken },
    })
    await ownNumber()
    const passwordOfA = outboundUsers(accountA).find(u => u.username.includes(wsA.id.slice(0, 8)))?.password
    const e164 = randomNumber()
    accountA.numbers.push({ sid: 'PNb', phone_number: e164 })
    expect((await act(inWs(wsB.owner, wsB), 'phoneNumber.setup', { e164 })).status).toBe(200)
    expect(accountA.credentialLists!.map(l => l.friendly_name).sort()).toEqual(
      [`linedesk-outbound-${wsA.id}`, `linedesk-outbound-${wsB.id}`].sort(),
    )
    expect(outboundUsers(accountA).find(u => u.username.includes(wsA.id.slice(0, 8)))?.password).toBe(passwordOfA)
    expect(new Set(livekitTrunks.map(t => t.name.split('-').slice(0, 3).join('-')))).toEqual(
      new Set([`linedesk-outbound-${wsA.id}`, `linedesk-outbound-${wsB.id}`]),
    )
  })

  test('switching to another account removes the old trunk; the agent can set it up again (logged)', async () => {
    const from = await ownNumber()
    await act(inWs(wsA.owner, wsA), 'phoneNumber.release', {
      phoneNumberId: (await numberRow(from))!.id,
      confirm: from,
    })
    expect(livekitTrunks).toEqual([])
    await useTwilio(wsA, accountB)
    expect(livekitTrunks).toEqual([])

    const again = await ownNumber(accountB)
    const first = livekitTrunks[0]!.sipTrunkId
    const key = crypto.randomUUID()
    const res = await act(agent(wsA.id), 'carrier.provisionTransferTrunk', {}, key)
    expect(res.status).toBe(200)
    expect(res.body.data.trunkId).not.toBe(first)
    expect(livekitTrunks.map(t => t.sipTrunkId)).toEqual([res.body.data.trunkId])
    expect(livekitTrunks[0]!.numbers).toEqual([again])
    const [command] = await db.select().from(commands).where(eq(commands.id, key))
    expect(command).toBeDefined()
    expect(JSON.stringify(command)).not.toContain(outboundUsers(accountB)[0]?.password ?? 'none')
  })

  test("install numbers stay with the install; another workspace's number is refused; only the agent asks", async () => {
    const from = await ownNumber()
    const [install] = await db
      .insert(phone_numbers)
      .values({ id: `pn_${crypto.randomUUID()}`, workspace_id: wsA.id, e164: randomNumber(), provider: 'dev' })
      .returning()
    const installed = await act(agent(wsA.id), 'carrier.transferTrunk', { from: install!.e164 })
    expect(installed.body.data).toEqual({ carrier: 'default', trunkName: null })
    const other = await act(agent(wsB.id), 'carrier.transferTrunk', { from })
    expect(other.status).toBe(409)
    expect(other.body.error).toBe(`${from} is not a number of this workspace`)
    expect((await act(inWs(wsA.owner, wsA), 'carrier.transferTrunk', { from })).status).toBe(403)
    expect((await act(inWs(wsA.owner, wsA), 'carrier.provisionTransferTrunk', {})).status).toBe(403)
    expect((await act(agent(), 'carrier.transferTrunk', { from })).status).toBe(409)
  })

  test("the install's own account cannot be brought as a workspace account", async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', accountA.sid)
    vi.stubEnv('TWILIO_AUTH_TOKEN', accountA.authToken)
    await act(inWs(wsB.owner, wsB), 'carrier.set', { carrier: 'default' })
    const res = await useTwilio(wsB, accountA, 'key')
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(
      'That is the Twilio account this Linedesk runs on. Use your own account, or Linedesk default.',
    )
  })
})

describe('transfer trunk set-ups: order, audit, limits', () => {
  const connect = async (e164 = randomNumber()) => {
    accountA.numbers.push({ sid: `PN${accountA.numbers.length}`, phone_number: e164 })
    expect((await act(inWs(wsA.owner, wsA), 'phoneNumber.setup', { e164 })).status).toBe(200)
    return e164
  }
  const provisions = async () =>
    (await db.select().from(commands).where(eq(commands.workspace_id, wsA.id))).filter(
      c => c.action === 'carrier.provisionTransferTrunk',
    )

  test('a new trunk is created before the old one goes', async () => {
    await connect()
    livekitOps = []
    await connect()
    expect(livekitOps).toHaveLength(2)
    expect(livekitOps[0]).toMatch(/^create /)
    expect(livekitOps[1]).toMatch(/^delete /)
    expect(livekitTrunks).toHaveLength(1)
    expect(livekitTrunks[0]!.numbers).toHaveLength(2)
  })

  test('number setup and release record the password rotation they cause in the audit log', async () => {
    const before = (await provisions()).length
    const e164 = await connect()
    await act(inWs(wsA.owner, wsA), 'phoneNumber.release', {
      phoneNumberId: (await numberRow(e164))!.id,
      confirm: e164,
    })
    const after = (await provisions()).slice(before)
    // Release of the last number removes the trunk and rotates nothing: one entry, from the setup.
    expect(after.map(c => ({ actor: c.actor_id, input: c.input }))).toEqual([
      { actor: wsA.owner.userId, input: { trigger: 'phoneNumber.setup' } },
    ])
    await connect()
    const second = await connect()
    await act(inWs(wsA.owner, wsA), 'phoneNumber.release', {
      phoneNumberId: (await numberRow(second))!.id,
      confirm: second,
    })
    expect((await provisions()).slice(before).map(c => (c.input as { trigger: string }).trigger)).toEqual([
      'phoneNumber.setup',
      'phoneNumber.setup',
      'phoneNumber.setup',
      'phoneNumber.release',
    ])
    expect(JSON.stringify(await provisions())).not.toMatch(/password/i)
  })

  test('the agent may set the trunk up again 3 times in 10 minutes per workspace', async () => {
    for (let i = 0; i < 3; i++)
      expect((await act(agent(wsB.id), 'carrier.provisionTransferTrunk', {})).status).toBe(200)
    const refused = await act(agent(wsB.id), 'carrier.provisionTransferTrunk', {})
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('The transfer trunk was set up too often. Try again in a few minutes.')
  })
})
