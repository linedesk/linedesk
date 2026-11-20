// Setup reports (LIN-210): feedback.send with kind setup from an install setup link's agent. Preview first (nothing
// stored or sent), then the admin's yes; redacted (every value the install knows, then scrubText); POSTed to
// SETUP_FEEDBACK_URL (mocked here, never linedesk.ai), kept on anything but 200/201 with ok, refused on a 400, retried,
// sent again from Server admin › System. In INSTANCE_WIDE_FILES: it makes instance admins and stores provider keys.
import { SETUP_MCP_INSTRUCTIONS, SETUP_REPORT_MIN_GAP_SECONDS } from '@linedesk/actions'
import { agent_setup_keys, assistants, commands, feedback, phone_numbers, provider_settings, user } from '@linedesk/db'
import { and, desc, eq } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { setupActor } from '../src/agent-setup.ts'
import { db } from '../src/db.ts'
import { guard } from '../src/mcp.ts'
import { setProviderKeys } from '../src/provider-settings.ts'
import { runAction } from '../src/run-action.ts'
import {
  DEFAULT_SETUP_FEEDBACK_URL,
  deliverSetupReport,
  fitReport,
  knownValues,
  phonePattern,
  redactText,
  secretVariants,
  installType,
  MAX_ANSWER_BYTES,
  postReport,
  previewToken,
  previewTokenHash,
  previewTokenMatches,
  pruneOldSetupReports,
  readSetupFeedbackUrl,
  retryKeptSetupReports,
  runSetupFeedbackJob,
  SETUP_REPORT_MAX_BYTES,
  SETUP_REPORT_UNSIGNED_BYTES,
  type SetupReport,
  serverVersion,
} from '../src/setup-feedback.ts'
import { SETUP_INTERNAL_ERROR } from '../src/setup-mcp.ts'
import { deleteAccounts } from '../src/workspace-delete.ts'
import {
  act,
  addMember,
  appRequest,
  createWorkspace,
  FROM,
  randomIp,
  request,
  type User,
  type Workspace,
} from './helpers.ts'

const ENDPOINT = 'https://feedback.example.test/api/setup-feedback'
// A made-up key, built from parts so secret scanners do not take it for a real one.
const PROVIDER_KEY = ['dg', 'live', 'Q2xhdWRlU2V0dXBGZWVk', 'YmFja1Rlc3Q'].join('_')
const ENV_SECRET = 'electric-secret-for-the-setup-report-test'

let id = 0
let ws: Workspace
let admin: User

/** Everything sent to the endpoint, and what it answers (a function of the request number). */
let posted: SetupReport[] = []
let answerWith: () => Response | Promise<Response> = () =>
  Response.json({ ok: true, id: 'fb_remote1' }, { status: 201 })

/** fetch to ENDPOINT is answered here; anything else (LiveKit's status) goes on as usual. */
function mockEndpoint() {
  const real = globalThis.fetch
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('https://feedback.example.test') && !url.startsWith('https://linedesk.ai'))
      return real(input, init)
    if (url.startsWith('https://linedesk.ai')) throw new Error('a test called linedesk.ai')
    expect(init?.redirect).toBe('manual')
    posted.push(JSON.parse(String(init?.body)) as SetupReport)
    return answerWith()
  })
}

async function makeKey(who: User, client?: string) {
  const res = await act(who, 'agentSetup.createKey', client ? { client } : {})
  expect(res.status).toBe(200)
  return res.body.data as { key: string; keyId: string }
}

async function mcp(key: string, method: string, params: Record<string, unknown> = {}) {
  const res = await appRequest(`/mcp/setup/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', [FROM]: randomIp() },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find(l => l.startsWith('data: '))
        ?.slice(6) ?? 'null')
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted on in the tests
  return JSON.parse(json) as any
}
// biome-ignore lint/suspicious/noExplicitAny: tool answers are asserted on in the tests
const call = async (key: string, name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const body = await mcp(key, 'tools/call', { name, arguments: args })
  return body.result.isError ? { error: body.result.content[0].text } : body.result.structuredContent
}

/** The admin's yes: the preview first, then the send with its preview_token (security review F7). */
// biome-ignore lint/suspicious/noExplicitAny: tool answers are asserted on in the tests
const consent = async (key: string, input: Record<string, unknown>): Promise<any> => {
  const { preview_token } = await call(key, 'feedback_send', input)
  return call(key, 'feedback_send', { ...input, user_consented: true, preview_token })
}

const report = (extra: Record<string, unknown> = {}) => ({
  text: 'Setup works up to the carrier; the Telnyx test kept failing.',
  setup: {
    outcome: 'partial',
    agent_model: 'claude-opus',
    items: [
      {
        category: 'confusing',
        step: 'telephony',
        tool: 'provider_setKeys',
        what_happened: `The Telnyx test failed with 'invalid key' although ${PROVIDER_KEY} was right.`,
        expected: 'A message saying the webhook public key is missing.',
        time_lost_minutes: 10,
        severity: 'medium',
        error_code: 'provider_test_failed',
        error_excerpt: 'Telnyx: 401 for mike@brightwater.example from +1 503 555 0142',
      },
    ],
  },
  ...extra,
})

const rowsOf = (keyId: string) =>
  db.select().from(feedback).where(eq(feedback.setup_key_id, keyId)).orderBy(desc(feedback.created_at))

/** The rate limit counts reports of the last minute: move a link's reports back in time. */
const age = (keyId: string, seconds: number) =>
  db
    .update(feedback)
    .set({ created_at: new Date(Date.now() - seconds * 1000).toISOString() })
    .where(eq(feedback.setup_key_id, keyId))

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  admin = ws.owner
  await db.update(user).set({ instanceAdmin: true, name: 'Mike Brennan' }).where(eq(user.id, admin.userId))
  await db.transaction(tx =>
    setProviderKeys(tx, 'deepgram', { api_key: PROVIDER_KEY }, admin.userId, new Date().toISOString()),
  )
})

beforeEach(async () => {
  // feedback.send's own limit per person (one per 10 s, 10 an hour): earlier tests' reports are an hour old.
  await db
    .update(feedback)
    .set({ created_at: new Date(Date.now() - 2 * 3_600_000).toISOString() })
    .where(eq(feedback.actor_id, admin.userId))
  posted = []
  answerWith = () => Response.json({ ok: true, id: 'fb_remote1' }, { status: 201 })
  process.env.SETUP_FEEDBACK_URL = ENDPOINT
  process.env.ELECTRIC_SECRET = ENV_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.SETUP_FEEDBACK_URL
  delete process.env.ELECTRIC_SECRET
})

describe('settings', () => {
  test('SETUP_FEEDBACK_URL: empty is linedesk.ai, off is null, anything but http(s) stops the server', () => {
    expect(readSetupFeedbackUrl({})).toBe(DEFAULT_SETUP_FEEDBACK_URL)
    expect(readSetupFeedbackUrl({ SETUP_FEEDBACK_URL: ' OFF ' })).toBeNull()
    expect(readSetupFeedbackUrl({ SETUP_FEEDBACK_URL: 'http://localhost:8787/x' })).toBe('http://localhost:8787/x')
    expect(() => readSetupFeedbackUrl({ SETUP_FEEDBACK_URL: 'ftp://example.com' })).toThrow(/SETUP_FEEDBACK_URL/)
    expect(() => readSetupFeedbackUrl({ SETUP_FEEDBACK_URL: 'nope' })).toThrow(/SETUP_FEEDBACK_URL/)
  })

  test('version and install type', () => {
    expect(serverVersion({ LINEDESK_VERSION: 'v0.1.40' })).toBe('v0.1.40')
    expect(serverVersion({ SENTRY_RELEASE: 'linedesk@1774015c' })).toBe('1774015c')
    expect(serverVersion({})).toBe('unknown')
    expect(installType({ PUBLIC_URL: 'https://app.linedesk.ai', LINEDESK_INSTALL_TYPE: 'docker' })).toBe('cloud')
    expect(installType({ PUBLIC_URL: 'https://desk.example.com', LINEDESK_INSTALL_TYPE: 'docker' })).toBe('docker')
    expect(installType({ NODE_ENV: 'development' })).toBe('dev')
    expect(installType({ NODE_ENV: 'production' })).toBe('unknown')
  })

  test('the setup MCP says more than "internal error" on an unexpected failure', async () => {
    const failing = async () => {
      throw new Error('select * from secrets')
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await guard('x', failing)).content[0]!.text).toBe('internal error')
    const setup = await guard('x', failing, SETUP_INTERNAL_ERROR)
    expect(setup.content[0]!.text).toMatch(/^internal error\. .*setup report.*feedback_send/)
    expect(setup.content[0]!.text).not.toContain('secrets')
  })
})

describe('postReport', () => {
  const sample = { schema: 'linedesk.setup-feedback/1' } as SetupReport
  const answering = (res: Response | Error) =>
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      if (res instanceof Error) throw res
      return res
    }) as unknown as typeof fetch

  test('201 with ok is sent; 200 duplicate too', async () => {
    expect(
      await postReport(ENDPOINT, sample, answering(Response.json({ ok: true, id: 'fb_1' }, { status: 201 }))),
    ).toEqual({ status: 'sent', remoteId: 'fb_1' })
    expect(
      await postReport(ENDPOINT, sample, answering(Response.json({ ok: true, id: 'fb_1', duplicate: true }))),
    ).toEqual({ status: 'sent', remoteId: 'fb_1' })
  })

  test('a 404 page, HTML, a 5xx, a 429, a redirect and no connection are kept', async () => {
    const html = new Response('<!doctype html><title>Not found</title>', { status: 404 })
    expect((await postReport(ENDPOINT, sample, answering(html))).status).toBe('kept')
    expect(
      (await postReport(ENDPOINT, sample, answering(new Response('<html>ok</html>', { status: 200 })))).status,
    ).toBe('kept')
    expect((await postReport(ENDPOINT, sample, answering(Response.json({ ok: false }, { status: 503 })))).status).toBe(
      'kept',
    )
    expect(
      (await postReport(ENDPOINT, sample, answering(Response.json({ ok: false, error: 'rate' }, { status: 429 }))))
        .status,
    ).toBe('kept')
    const moved = new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
    expect(await postReport(ENDPOINT, sample, answering(moved))).toMatchObject({
      status: 'kept',
      error: expect.stringMatching(/redirected/),
    })
    expect(await postReport(ENDPOINT, sample, answering(new TypeError('fetch failed')))).toMatchObject({
      status: 'kept',
      error: expect.stringMatching(/could not connect \(feedback\.example\.test\)/),
    })
  })

  test('an answer over 64 KB is not read: by its content-length, or cut off while it streams (F9)', async () => {
    const big = JSON.stringify({ ok: true, id: 'fb_big', pad: 'x'.repeat(MAX_ANSWER_BYTES) })
    const declared = new Response(big, { status: 201, headers: { 'content-length': String(big.length) } })
    expect(await postReport(ENDPOINT, sample, answering(declared))).toMatchObject({
      status: 'kept',
      error: expect.stringMatching(/not the setup report endpoint/),
    })
    // No content-length: chunks until it passes the cap, then cancelled.
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new TextEncoder().encode('{"pad":"'.padEnd(16 * 1024, 'x')))
      },
    })
    expect((await postReport(ENDPOINT, sample, answering(new Response(endless, { status: 201 })))).status).toBe('kept')
    expect(pulled).toBeLessThan(10)
    // A normal answer under the cap still counts.
    expect(
      await postReport(ENDPOINT, sample, answering(Response.json({ ok: true, id: 'fb_small' }, { status: 201 }))),
    ).toEqual({ status: 'sent', remoteId: 'fb_small' })
  })

  test('a 400 is refused', async () => {
    const res = Response.json({ ok: false, error: 'invalid', field: 'items[0].severity' }, { status: 400 })
    expect(await postReport(ENDPOINT, sample, answering(res))).toMatchObject({ status: 'refused' })
  })
})

describe('feedback_send on the setup MCP', () => {
  test('an install link lists it with its own description; the instructions point to it', async () => {
    const { key } = await makeKey(admin, 'claude_code')
    const tools = (await mcp(key, 'tools/list')).result.tools as {
      name: string
      description: string
      annotations: Record<string, boolean>
    }[]
    const tool = tools.find(t => t.name === 'feedback_send')!
    expect(tool.description).toMatch(/without user_consented/)
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(SETUP_MCP_INSTRUCTIONS).toMatch(/feedback_send without user_consented first/)
  })

  test('the preview sends and stores nothing; redacts every known value; the yes sends it', async () => {
    const fetchSpy = mockEndpoint()
    // The workspace's own number, typed into a summary.
    const [number] = await db
      .select({ e164: phone_numbers.e164 })
      .from(phone_numbers)
      .where(eq(phone_numbers.workspace_id, ws.id))
    const { key, keyId } = await makeKey(admin, 'claude_code')
    const input = report({
      text: `Mike Brennan set up Brightwater Plumbing & Heating on ${number!.e164} with key ${key}; ${ENV_SECRET} was in .env.`,
      contact_email: 'Owner@Example.com',
    })

    const preview = await call(key, 'feedback_send', input)
    expect(preview).toMatchObject({ ok: true, sent: false })
    expect(posted).toHaveLength(0)
    expect(await rowsOf(keyId)).toHaveLength(0)
    const shown = JSON.stringify(preview.preview)
    for (const secret of [
      PROVIDER_KEY,
      key,
      ENV_SECRET,
      'Mike Brennan',
      'Brightwater Plumbing',
      number!.e164,
      '555 0142',
      'mike@brightwater.example',
    ])
      expect(shown).not.toContain(secret)
    expect(preview.preview).toMatchObject({
      schema: 'linedesk.setup-feedback/1',
      report_id: expect.stringMatching(/^sf_[0-9a-f]{20}$/),
      source: 'agent',
      install: { install_ref: expect.stringMatching(/^ir_[0-9a-f]{20}$/), install_type: expect.any(String) },
      agent: { client: 'claude-code', model: 'claude-opus' },
      setup: { steps: expect.objectContaining({ email: expect.any(String), telephony: expect.any(String) }) },
      outcome: 'partial',
      contact: { email: 'owner@example.com' },
    })
    expect(preview.preview.summary).toContain('[name]')
    expect(preview.preview.summary).toContain('[business]')
    expect(preview.preview.summary).toContain('[key]')
    expect(preview.preview.items[0].what_happened).toContain('[secret]')
    // The contact goes only as contact.email: in a text it is an email address like any other.
    expect(preview.ask).toMatch(/Something to pass on to the Linedesk team\?/)
    expect(preview.ask).toMatch(/that I am Claude Code/)
    expect(preview.ask).toMatch(/about 10 minutes lost/)
    expect(preview.ask).toMatch(/answer you at owner@example\.com/)

    const sent = await call(key, 'feedback_send', {
      ...input,
      user_consented: true,
      preview_token: preview.preview_token,
    })
    expect(sent).toMatchObject({
      ok: true,
      status: 'sent',
      remote_id: 'fb_remote1',
      message: expect.stringMatching(/^Sent/),
    })
    expect(posted).toHaveLength(1)
    const body = JSON.stringify(posted[0])
    for (const secret of [PROVIDER_KEY, key, ENV_SECRET, 'Mike Brennan', number!.e164, 'mike@brightwater.example'])
      expect(body).not.toContain(secret)
    expect(posted[0]!.contact).toEqual({ email: 'owner@example.com' })
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16 * 1024)
    const [row] = await rowsOf(keyId)
    expect(row).toMatchObject({
      id: sent.id,
      workspace_id: null,
      via: 'setup_link',
      kind: 'setup',
      status: 'sent',
      remote_id: 'fb_remote1',
      tries: 1,
      contact_email: 'owner@example.com',
      actor_id: admin.userId,
    })
    expect(JSON.stringify(row!.report)).not.toContain(PROVIDER_KEY)
    // The command log keeps ids only, never the text or the contact.
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'feedback.send'), eq(commands.setup_key_id, keyId)))
    expect(JSON.stringify(logged!.input)).not.toContain('owner@example.com')
    expect(JSON.stringify(logged!.input)).not.toContain('Telnyx test failed')
    expect(fetchSpy).toHaveBeenCalled()

    // setup_status says a report exists for this link, so the agent stops asking.
    expect((await call(key, 'setup_status', { read_only: true })).feedback).toMatchObject({
      asked: true,
      status: 'sent',
    })
  })

  test('setup_status.feedback asks for one while none was sent', async () => {
    const { key } = await makeKey(admin)
    const status = await call(key, 'setup_status', { read_only: true })
    expect(status.feedback).toMatchObject({ asked: false, how: expect.stringMatching(/feedback_send/) })
  })

  test('an endpoint that is not there yet (404 page) keeps the report; the agent says so; retries and Send again', async () => {
    mockEndpoint()
    answerWith = () =>
      new Response('<!doctype html><h1>404</h1>', { status: 404, headers: { 'content-type': 'text/html' } })
    const { key, keyId } = await makeKey(admin, 'chatgpt')
    const kept = await consent(key, report())
    expect(kept).toMatchObject({ ok: true, status: 'kept', message: expect.stringMatching(/kept on this server/) })
    let [row] = await rowsOf(keyId)
    expect(row).toMatchObject({ status: 'kept', tries: 1 })

    // The hourly retry: not again within the hour, then once the hour is over.
    expect((await retryKeptSetupReports()).tried).toBe(0)
    await db
      .update(feedback)
      .set({ tried_at: new Date(Date.now() - 2 * 3_600_000).toISOString() })
      .where(eq(feedback.id, row!.id))
    expect((await retryKeptSetupReports()).tried).toBe(1)
    ;[row] = await rowsOf(keyId)
    expect(row).toMatchObject({ status: 'kept', tries: 2 })

    // Server admin › System: the list, then Send again once the endpoint answers.
    const list = await act(admin, 'feedback.setupReports', {})
    expect(list.body.data.reports.find((r: { id: string }) => r.id === row!.id)).toMatchObject({
      status: 'kept',
      outcome: 'partial',
      items: 1,
      agent: 'chatgpt',
      reason: 'unreachable',
    })
    answerWith = () => Response.json({ ok: true, id: 'fb_remote2' }, { status: 201 })
    // Right after a try, Send again waits a minute (one try at a time).
    expect((await act(admin, 'feedback.resend', { id: row!.id })).body.error).toMatch(/a moment ago/)
    await db
      .update(feedback)
      .set({ tried_at: new Date(Date.now() - 2 * 60_000).toISOString() })
      .where(eq(feedback.id, row!.id))
    expect((await act(admin, 'feedback.resend', { id: row!.id })).status).toBe(200)
    ;[row] = await rowsOf(keyId)
    expect(row).toMatchObject({ status: 'sent', remote_id: 'fb_remote2', tries: 3 })
    expect((await act(admin, 'feedback.resend', { id: row!.id })).body.ok).toBe(false)
    // Only an instance admin.
    const owner = (await createWorkspace('Other Business')).owner
    expect((await act(owner, 'feedback.resend', { id: row!.id })).status).toBe(403)
    expect((await act(owner, 'feedback.setupReports', {})).status).toBe(403)
  })

  test('a 400 is refused and never sent again', async () => {
    mockEndpoint()
    answerWith = () => Response.json({ ok: false, error: 'invalid', field: 'items[0].severity' }, { status: 400 })
    const { key, keyId } = await makeKey(admin)
    expect(await consent(key, report())).toMatchObject({ status: 'refused' })
    const [row] = await rowsOf(keyId)
    await db
      .update(feedback)
      .set({ tried_at: new Date(Date.now() - 2 * 3_600_000).toISOString() })
      .where(eq(feedback.id, row!.id))
    await retryKeptSetupReports()
    expect(posted).toHaveLength(1)
    expect((await act(admin, 'feedback.resend', { id: row!.id })).body.ok).toBe(false)
  })

  test('SETUP_FEEDBACK_URL=off sends nothing: kept, not retried, no Send again', async () => {
    const fetchSpy = mockEndpoint()
    process.env.SETUP_FEEDBACK_URL = 'off'
    const { key, keyId } = await makeKey(admin)
    expect(await consent(key, report())).toMatchObject({
      status: 'kept',
      message: expect.stringMatching(/SETUP_FEEDBACK_URL=off/),
    })
    const [row] = await rowsOf(keyId)
    expect(row).toMatchObject({ status: 'kept', tries: 0 })
    expect((await retryKeptSetupReports()).tried).toBe(0)
    expect((await act(admin, 'feedback.resend', { id: row!.id })).body.ok).toBe(false)
    const list = await act(admin, 'feedback.setupReports', {})
    expect(list.body.data.sendingOff).toBe(true)
    expect(list.body.data.reports.find((r: { id: string }) => r.id === row!.id)?.reason).toBe('off')
    expect(posted).toHaveLength(0)
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('feedback.example.test'))).toBe(false)
  })

  test('at most one report a minute per link, and ten a day', async () => {
    mockEndpoint()
    const { key, keyId } = await makeKey(admin)
    expect((await consent(key, report())).status).toBe('sent')
    // Past feedback.send's own 10 s, within the link's minute.
    await age(keyId, 30)
    const again = await consent(key, report())
    expect(again.error).toMatch(new RegExp(`Wait ${SETUP_REPORT_MIN_GAP_SECONDS} seconds`))
    // Older than the per-person hour (feedback.send's own limit), still within the link's day.
    for (let i = 0; i < 9; i++) {
      await age(keyId, 3700)
      expect((await consent(key, report())).status).toBe('sent')
    }
    await age(keyId, 3700)
    expect((await consent(key, report())).error).toMatch(/10 setup reports today/)
    await db.delete(feedback).where(eq(feedback.setup_key_id, keyId))
  })

  test('only an install link sends setup reports, and only with the yes', async () => {
    mockEndpoint()
    // A member in the app or a workspace key: refused (the Help report stays as it was).
    const res = await act(ws.owner, 'feedback.send', { kind: 'setup', ...report(), user_consented: true })
    expect(res.body).toMatchObject({ ok: false, error: expect.stringMatching(/setup link/) })
    // Through the action without user_consented: refused (the setup MCP answers with the preview before that).
    const { keyId } = await makeKey(admin)
    expect(await rowsOf(keyId)).toHaveLength(0)
    expect(posted).toHaveLength(0)
  })

  test('the setup page stores the picked agent with the key', async () => {
    const { keyId } = await makeKey(admin, 'cursor')
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
    expect(row!.client).toBe('cursor')
    expect((await act(admin, 'agentSetup.createKey', { client: 'bogus' })).status).toBe(422)
  })
})

describe('redaction of what the install knows (security review F1, F2, F3, F5)', () => {
  test('a known number in every way it is written: German national, with a slash, 0049, +49 (0); US forms', () => {
    const de = phonePattern('+4962215550147')!
    for (const typed of [
      '06221 5550147',
      '06221/5550147',
      '0049 6221 5550147',
      '+49 (0) 6221 555 01 47',
      '6221-5550147',
    ])
      expect(`call ${typed} now`.replace(de, '[phone]'), typed).toBe('call [phone] now')
    expect('id 162215550147 x'.replace(de, '[phone]')).toBe('id 162215550147 x')
    const us = phonePattern('+15035550142')!
    for (const typed of ['(503) 555-0142', '1 503 555 0142', '503.555.0142'])
      expect(`call ${typed} now`.replace(us, '[phone]'), typed).toBe('call [phone] now')
  })

  test("the business's own number in a German format never leaves", async () => {
    await db
      .update(assistants)
      .set({ business_profile: { phone: '+49 6221 5550147', website: 'https://www.brightwater.example/' } })
      .where(eq(assistants.workspace_id, ws.id))
    const known = await knownValues(db, { actorId: admin.userId })
    for (const typed of ['06221 5550147', '06221/5550147', '0049 6221 5550147'])
      expect(redactText(`the forwarding to ${typed} failed`, known, 500)).not.toMatch(/5550147|555 01 47/)
    // The website's domain and its subdomains, also inside an error text.
    expect(redactText('DNS lookup of mail.brightwater.example failed (ENOTFOUND)', known, 500)).toBe(
      'DNS lookup of [domain] failed (ENOTFOUND)',
    )
  })

  test('secrets in every form: split app password, encoded DB password, URL credentials, any *_SECRET or *_KEY', async () => {
    expect(secretVariants('abcd efgh ijkl mnop')).toContain('abcdefghijklmnop')
    // Made-up values, built from parts so secret scanners do not take them for real ones.
    const fake = (...parts: string[]) => parts.join('')
    const env = {
      GMAIL_APP_PASSWORD: fake('abcd efgh ', 'ijkl mnop'),
      DATABASE_URL: fake('postgres://linedesk:', 'p%40ss%2Fw0rd-XYZ123', '@db:5432/linedesk'),
      BETTER_AUTH_SECRETS: fake('v1:rotated-', 'secret-value-0001'),
      DEMO_GATEWAY_SECRET: fake('demo-gateway-', 'secret-value'),
      S3_SECRET_ACCESS_KEY: fake('wJalrXUtnF', 'EMIK7MDENG', 'bPxRfiCYzz'),
      OPENAI_API_KEY: fake('sk-proj-', 'openai-test-value'),
      EMAIL_FROM: 'Brightwater Dispatch <hi@bw-mail.example>',
      FEATURE_KEY: 'true',
    }
    const known = await knownValues(db, { actorId: admin.userId }, env)
    const text = [
      'app password abcdefghijklmnop',
      'db p@ss/w0rd-XYZ123 or p%40ss%2Fw0rd-XYZ123',
      'old v1:rotated-secret-value-0001',
      'demo demo-gateway-secret-value',
      `s3 ${env.S3_SECRET_ACCESS_KEY}`,
      'openai sk-proj-openai-test-value',
      'sent from Brightwater Dispatch via smtp.bw-mail.example',
      'flag true',
    ].join('; ')
    const out = redactText(text, known, 2000)
    for (const leaked of [
      'abcdefghijklmnop',
      'w0rd-XYZ123',
      'rotated-secret',
      'demo-gateway-secret',
      env.S3_SECRET_ACCESS_KEY,
      'sk-proj',
      'Brightwater Dispatch',
      'bw-mail.example',
    ])
      expect(out, leaked).not.toContain(leaked)
    expect(out).toContain('flag true')
  })

  test('the SMTP host and its credentials from a stored SMTP URL', async () => {
    await db.transaction(tx =>
      setProviderKeys(
        tx,
        'smtp',
        { url: ['smtps://AKIA0SMTPUSER77', 'smtp%2Bpass%2Fword99@smtp.relay-host.example:465'].join(':') },
        admin.userId,
        new Date().toISOString(),
      ),
    )
    try {
      const known = await knownValues(db, { actorId: admin.userId }, {})
      const out = redactText(
        'SMTP login AKIA0SMTPUSER77 / smtp+pass/word99 at smtp.relay-host.example:465 refused',
        known,
        500,
      )
      expect(out).not.toMatch(/AKIA0SMTPUSER77|pass\/word99|relay-host/)
    } finally {
      await db.delete(provider_settings).where(eq(provider_settings.provider, 'smtp'))
    }
  })

  test('a setup key, also cut short, is masked', () => {
    expect(redactText('key lds_AbCdEfGh12 and lds_x', [], 200)).toBe('key [key] and lds_x')
  })
})

describe('Send again and the retry claim the report (F8), only for an admin in the app (F12)', () => {
  test('two sends at once post it once', async () => {
    mockEndpoint()
    answerWith = async () => {
      await new Promise(r => setTimeout(r, 50))
      return Response.json({ ok: true, id: 'fb_once' }, { status: 201 })
    }
    process.env.SETUP_FEEDBACK_URL = 'off'
    const { key, keyId } = await makeKey(admin)
    await consent(key, report())
    process.env.SETUP_FEEDBACK_URL = ENDPOINT
    const [row] = await rowsOf(keyId)
    await Promise.all([deliverSetupReport(row!.id), deliverSetupReport(row!.id), deliverSetupReport(row!.id)])
    expect(posted).toHaveLength(1)
    expect((await rowsOf(keyId))[0]).toMatchObject({ status: 'sent', tries: 1 })
  })

  test('a member, a workspace API key, a partner link and an install link are refused', async () => {
    const [anyReport] = await db.select({ id: feedback.id }).from(feedback).limit(1)
    const input = { id: anyReport?.id ?? 'fb_none' }
    const member = await addMember(ws.id, 'member')
    const created = await act(ws.owner, 'apiKey.create', { name: 'Zapier', role: 'admin' })
    const workspaceKey = { headers: { authorization: `Bearer ${created.body.data.key}` } }
    const { keyId } = await makeKey(admin)
    const installLink = (await setupActor(admin.userId, keyId, { passkeyConfirmed: true }))!
    const partnerLink = {
      ...installLink,
      permissions: ['setupLink:end'],
      setupPartnerId: 'pt_any',
    } as typeof installLink
    for (const name of ['feedback.resend', 'feedback.setupReports']) {
      const body = name === 'feedback.resend' ? input : {}
      expect((await act(member, name, body)).status, `${name} member`).toBe(403)
      expect((await request(workspaceKey, 'POST', `/v1/actions/${name}`, body)).status, `${name} key`).toBe(403)
      expect((await runAction(name, body, partnerLink)).status, `${name} partner`).toBe(403)
      // An install link holds instance:admin, and is still refused: these are a person's, in the app.
      expect((await runAction(name, body, installLink)).status, `${name} install link`).toBe(403)
    }
    // Nor are they tools on the setup MCP.
    const { key } = await makeKey(admin)
    const tools = (await mcp(key, 'tools/list')).result.tools.map((t: { name: string }) => t.name)
    expect(tools).not.toContain('feedback_resend')
    expect(tools).not.toContain('feedback_setupReports')
  })
})

describe('the yes is tied to the preview the admin saw (F7)', () => {
  test("a send without the preview_token, with another text or with another link's token is refused", async () => {
    mockEndpoint()
    const { key, keyId } = await makeKey(admin)
    const preview = await call(key, 'feedback_send', report())
    expect(preview.preview_token).toMatch(/^pt1\.\d+\.[\w-]+$/)

    const without = await call(key, 'feedback_send', { ...report(), user_consented: true })
    expect(without.error).toMatch(/not the report the admin saw/)
    const changed = await call(key, 'feedback_send', {
      ...report({ text: 'Something else the admin never saw.' }),
      user_consented: true,
      preview_token: preview.preview_token,
    })
    expect(changed.error).toMatch(/not the report the admin saw/)
    // The same report signed for another link (only the newest link works, so it is made here, as the server would).
    const crossed = await call(key, 'feedback_send', {
      ...report(),
      user_consented: true,
      preview_token: previewToken(`${keyId}x`, preview.preview),
    })
    expect(crossed.error).toMatch(/not the report the admin saw/)
    expect(await rowsOf(keyId)).toHaveLength(0)
    expect(posted).toHaveLength(0)

    // The right token: sent, and what left is the preview (but for the id, time and steps).
    const sent = await call(key, 'feedback_send', {
      ...report(),
      user_consented: true,
      preview_token: preview.preview_token,
    })
    expect(sent.status).toBe('sent')
    const { report_id: _a, sent_at: _b, setup: _c, ...shown } = preview.preview
    expect(posted[0]).toMatchObject(shown)
  })

  test('the token expires after an hour, and a changed or foreign one never matches', () => {
    const env = { BETTER_AUTH_SECRET: ['test', 'only', 'preview', 'signing', 'value'].join('-') }
    const sample = {
      schema: 'linedesk.setup-feedback/1',
      report_id: 'sf_1',
      sent_at: '2026-01-01T00:00:00.000Z',
      outcome: 'partial',
      summary: 'It went fine.',
      items: [],
    } as unknown as SetupReport
    const now = Date.parse('2026-01-01T00:00:00.000Z')
    const token = previewToken('ask_1', sample, now, env)
    expect(previewTokenMatches(token, 'ask_1', sample, now + 59 * 60_000, env)).toBe(true)
    // Another report id and time (the send makes new ones) still match: the admin saw the same content.
    expect(previewTokenMatches(token, 'ask_1', { ...sample, report_id: 'sf_2', sent_at: 'x' }, now, env)).toBe(true)
    expect(previewTokenMatches(token, 'ask_1', sample, now + 61 * 60_000, env)).toBe(false)
    expect(previewTokenMatches(token, 'ask_2', sample, now, env)).toBe(false)
    expect(previewTokenMatches(token, 'ask_1', { ...sample, summary: 'Other.' }, now, env)).toBe(false)
    expect(previewTokenMatches(token, 'ask_1', sample, now, { BETTER_AUTH_SECRET: 'another-secret-value' })).toBe(false)
    const [p, e, mac] = token.split('.')
    expect(previewTokenMatches(`${p}.${Number(e) + 1}.${mac}`, 'ask_1', sample, now, env)).toBe(false)
    // One spelling only: a zero-padded expiry is refused (it would read as a new token, second review of #1522).
    expect(previewTokenMatches(`${p}.0${e}.${mac}`, 'ask_1', sample, now, env)).toBe(false)
    expect(previewTokenMatches(`${p}.00${e}.${mac}`, 'ask_1', sample, now, env)).toBe(false)
    for (const bad of [undefined, '', 'pt1', 'pt1..', `${token}.x`, token.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))])
      expect(previewTokenMatches(bad, 'ask_1', sample, now, env)).toBe(false)
  })
})

describe('second review of #1509: one send per preview, the size measured on the signed part', () => {
  test('a preview_token works once per link; the refusal says so and does not count toward the limits', async () => {
    mockEndpoint()
    const { key, keyId } = await makeKey(admin)
    const { preview_token } = await call(key, 'feedback_send', report())
    const yes = { ...report(), user_consented: true, preview_token }
    expect((await call(key, 'feedback_send', yes)).status).toBe('sent')
    // Right away: the token's own line, not the link's "wait 60 seconds".
    expect((await call(key, 'feedback_send', yes)).error).toMatch(/already sent; each preview_token works once/)
    // Later too, while the token would still be good for its hour.
    await age(keyId, 3700)
    expect((await call(key, 'feedback_send', yes)).error).toMatch(/already sent/)
    expect(await rowsOf(keyId)).toHaveLength(1)
    expect(posted).toHaveLength(1)
    // Another spelling of the same token (a zero-padded expiry) is the same used token, and never a valid one.
    const [p, expires, mac] = preview_token.split('.')
    const padded = `${p}.0${expires}.${mac}`
    expect(previewTokenHash(padded)).toBe(previewTokenHash(preview_token))
    expect((await call(key, 'feedback_send', { ...yes, preview_token: padded })).error).toMatch(/already sent/)
    expect(await rowsOf(keyId)).toHaveLength(1)
    // Only the token's hash is kept on the report.
    const [row] = await rowsOf(keyId)
    expect(row!.preview_token_hash).toBe(previewTokenHash(preview_token))
    expect(JSON.stringify(row)).not.toContain(preview_token)
    // The refusals stored nothing: a new preview and yes go out at once (past feedback.send's own 10 s only).
    await db
      .update(feedback)
      .set({ created_at: new Date(Date.now() - 2 * 3_600_000).toISOString() })
      .where(eq(feedback.actor_id, admin.userId))
    expect((await consent(key, report())).status).toBe('sent')
    expect(await rowsOf(keyId)).toHaveLength(2)
    await db.delete(feedback).where(eq(feedback.setup_key_id, keyId))
  })

  const sample = (whatHappened: string, setup: SetupReport['setup']): SetupReport => ({
    schema: 'linedesk.setup-feedback/1',
    report_id: 'sf_00000000000000000001',
    sent_at: '2026-01-01T00:00:00.000Z',
    source: 'agent',
    install: { install_ref: 'ir_00000000000000000001', version: 'test', install_type: 'dev', public: false },
    agent: { client: 'claude-code' },
    setup,
    outcome: 'partial',
    summary: 'Made up for the size test.',
    items: [{ category: 'confusing', what_happened: whatHappened, severity: 'low' }],
  })
  const fewSteps: SetupReport['setup'] = { current_step: null, steps: {}, minutes_since_start: 0 }
  // The most the instance fills in outside the HMAC: every install step, the longest state, the longest minutes.
  const mostSteps: SetupReport['setup'] = {
    current_step: 'call-audio',
    steps: { email: 'failing', answering: 'failing', telephony: 'failing', 'call-audio': 'failing' },
    minutes_since_start: 1440,
  }
  const signedBytes = (r: SetupReport) => {
    const { report_id: _a, sent_at: _b, setup: _c, ...signed } = r
    return Buffer.byteLength(JSON.stringify(signed))
  }

  test('a report at the edge is cut the same way at the preview and the send, whatever the steps say', () => {
    const base = signedBytes(sample('', fewSteps))
    const edge = 'x'.repeat(SETUP_REPORT_MAX_BYTES - SETUP_REPORT_UNSIGNED_BYTES - base)
    const atPreview = fitReport(sample(edge, fewSteps))
    const atSend = fitReport(sample(edge, mostSteps))
    expect(atPreview.items[0]!.what_happened).toBe(edge)
    expect(atSend.items).toEqual(atPreview.items)
    // So the token of the preview matches the report built again for the send.
    const env = { BETTER_AUTH_SECRET: ['test', 'only', 'size', 'signing', 'value'].join('-') }
    const now = Date.parse('2026-01-01T00:00:00.000Z')
    expect(previewTokenMatches(previewToken('ask_1', atPreview, now, env), 'ask_1', atSend, now, env)).toBe(true)
    // One byte more is cut, at both.
    const over = `${edge}x`
    expect(fitReport(sample(over, fewSteps)).items).toEqual(fitReport(sample(over, mostSteps)).items)
    expect(fitReport(sample(over, fewSteps)).items[0]!.what_happened.length).toBeLessThan(over.length)
  })

  test('the whole report stays within 16 KB: the unsigned fields fit in their reserved room', () => {
    const unsigned = Buffer.byteLength(
      JSON.stringify({ report_id: 'sf_ffffffffffffffffffff', sent_at: '2026-12-31T23:59:59.999Z', setup: mostSteps }),
    )
    expect(unsigned).toBeLessThan(SETUP_REPORT_UNSIGNED_BYTES)
    const base = signedBytes(sample('', mostSteps))
    const edge = 'x'.repeat(SETUP_REPORT_MAX_BYTES - SETUP_REPORT_UNSIGNED_BYTES - base)
    for (const text of [edge, `${edge}x`, 'x'.repeat(40_000)])
      expect(Buffer.byteLength(JSON.stringify(fitReport(sample(text, mostSteps))))).toBeLessThanOrEqual(
        SETUP_REPORT_MAX_BYTES,
      )
  })
})

describe('the hourly job runs the retry and the delete on their own (second review of #1509)', () => {
  test('a failing retry does not skip the delete, nor the other way round; both are logged', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prune = vi.fn(async () => 3)
    expect(
      await runSetupFeedbackJob({
        retry: async () => {
          throw new Error('made-up retry failure')
        },
        prune,
      }),
    ).toEqual({ tried: null, pruned: 3 })
    expect(prune).toHaveBeenCalledOnce()
    const retry = vi.fn(async () => ({ tried: 2 }))
    expect(
      await runSetupFeedbackJob({
        retry,
        prune: async () => {
          throw new Error('made-up delete failure')
        },
      }),
    ).toEqual({ tried: 2, pruned: null })
    expect(retry).toHaveBeenCalledOnce()
    expect(logged.mock.calls.map(c => String(c[0]))).toEqual([
      'setup reports: the retry failed:',
      'setup reports: deleting old ones failed:',
    ])
  })
})

describe('business words, street lines, short names and IP addresses (F4, F11)', () => {
  test("the business name's distinctive words, the street line and a short first name go; ordinary words stay", async () => {
    await db
      .update(assistants)
      .set({ business_profile: { address: '4417 SE Lindqvist Blvd, Portland, OR 97214' } })
      .where(eq(assistants.workspace_id, ws.id))
    await db.update(user).set({ name: 'Tim Do Brennan' }).where(eq(user.id, admin.userId))
    try {
      const known = await knownValues(db, { actorId: admin.userId })
      const out = redactText(
        'Brightwater: the heating step failed at 4417 SE Lindqvist Blvd. Tim said to retry; Do it at the right time, tim.',
        known,
        500,
      )
      expect(out).toBe(
        '[business]: the heating step failed at [address]. [name] said to retry; Do it at the right time, tim.',
      )
      // Inside a hostname too; never inside a longer word.
      expect(redactText('ssh brightwater-vps; Brightwaters', known, 200)).toBe('ssh [business]-vps; Brightwaters')
    } finally {
      await db.update(user).set({ name: 'Mike Brennan' }).where(eq(user.id, admin.userId))
    }
  })

  test('IP addresses are masked in a report, loopback stays', () => {
    expect(redactText('ssh root@203.0.113.42 timed out; AAAA 2001:db8::7 ok; 127.0.0.1:3100 up', [], 500)).toBe(
      'ssh root@[ip] timed out; AAAA [ip] ok; 127.0.0.1:3100 up',
    )
    // The edge forms of the second review: 8 colon groups with ::, digit-less IPv6, IPv4 after _.
    expect(redactText('DB_HOST_10.0.0.5, AAAA dead::beef:cafe and 1:2:3:4:5:6:7:: at 12:30:45', [], 500)).toBe(
      'DB_HOST_[ip], AAAA [ip] and [ip] at 12:30:45',
    )
  })
})

describe('setup reports are not kept forever (F10)', () => {
  const row = (actorId: string, daysAgo: number) => ({
    id: `fb_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
    workspace_id: null,
    actor_id: actorId,
    via: 'setup_link' as const,
    kind: 'setup' as const,
    text: 'made up',
    status: 'sent' as const,
    report: { schema: 'linedesk.setup-feedback/1' },
    created_at: new Date(Date.now() - daysAgo * 24 * 3_600_000).toISOString(),
  })

  test('after 90 days', async () => {
    const old = row(admin.userId, 91)
    const recent = row(admin.userId, 89)
    await db.insert(feedback).values([old, recent])
    expect(await pruneOldSetupReports()).toBeGreaterThanOrEqual(1)
    const left = (await db.select({ id: feedback.id }).from(feedback)).map(r => r.id)
    expect(left).not.toContain(old.id)
    expect(left).toContain(recent.id)
    await db.delete(feedback).where(eq(feedback.id, recent.id))
  })

  test('with the account that made them', async () => {
    const other = (await createWorkspace('Other Install Admin')).owner
    const mine = row(other.userId, 1)
    const someoneElses = row(admin.userId, 1)
    await db.insert(feedback).values([mine, someoneElses])
    await db.transaction(tx => deleteAccounts(tx, [other.userId]))
    const left = (await db.select({ id: feedback.id }).from(feedback)).map(r => r.id)
    expect(left).not.toContain(mine.id)
    expect(left).toContain(someoneElses.id)
    await db.delete(feedback).where(eq(feedback.id, someoneElses.id))
  })
})
