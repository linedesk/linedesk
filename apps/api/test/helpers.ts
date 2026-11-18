// Test fixtures: real sessions through Better Auth (accounts written directly: there is no open sign-up), workspaces through the API,
// rows straight into the test database. Every id is random, so test files can run in parallel.
import { account as accounts, assistant_calendars, assistants, calendar_connections, calls, contacts, phone_numbers, user as users, webhook_endpoints, workspace_settings } from '@linedesk/db'
import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import { app } from '../src/app.ts'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'

const ORIGIN = 'http://localhost:5173'
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0')
/**
 * A random Portland number that is a valid US number everywhere it is checked (transfer contacts included):
 * the exchange is NXX (N = 2-9), never a service code (N11) and never 976 (premium rate).
 */
export function randomNumber(): string {
  let exchange: string
  do exchange = `${2 + Math.floor(Math.random() * 8)}${digits(2)}`
  while (/^[2-9]11$/.test(exchange) || exchange === '976')
  return `+1503${exchange}${digits(4)}`
}

/** Auth requests are rate limited per client address; each fixture user comes from its own. */
export const randomIp = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 256)).join('.')}`

/**
 * Where a test request comes from. The API takes the client address from the connection, not
 * from headers, so tests pass it as the connection the Node server would see.
 */
export const FROM = 'x-test-connection-address'

/** `app.request` with the address in FROM moved from the headers to the simulated connection. */
export function appRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const address = headers.get(FROM) ?? '127.0.0.1'
  headers.delete(FROM)
  // A browser always sends the address it asked (request-host.ts): the app's own, unless a test names another.
  if (!headers.has('host')) headers.set('host', new URL(ORIGIN).host)
  return app.request(path, { ...init, headers }, { incoming: { socket: { remoteAddress: address, remotePort: 0, remoteFamily: 'IPv4' } } })
}

export type Caller = { headers: Record<string, string> }
export type User = Caller & { userId: string }

const PASSWORD = 'test-password-1234'
// One hash for every test account (hashing is slow on purpose).
let passwordHash: Promise<string> | null = null

/**
 * A new account with a password; its email is not verified. There is no open sign-up (signup-gate.ts): the account is
 * written as a server admin's Add user would, then signed in through Better Auth like a real person.
 */
export async function signUp(email = `${uid('user')}@linedesk.test`): Promise<User> {
  passwordHash ??= hashPassword(PASSWORD)
  const id = uid('u')
  await db.insert(users).values({ id, name: 'Test User', email, emailVerified: false })
  await db.insert(accounts).values({ id: uid('acc'), accountId: id, providerId: 'credential', userId: id, password: await passwordHash })
  const res = await appRequest('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`)
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  return { userId: id, headers: { cookie, origin: ORIGIN } }
}

/** The voice agent; each from its own address, so wrong tokens in one test never throttle another (context.ts). */
export const agent = (workspaceId?: string, token = 'test-agent-token-test-agent-token-0000'): Caller => ({
  headers: { authorization: `Bearer ${token}`, [FROM]: randomIp(), ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) },
})
export const anonymous: Caller = { headers: {} }

export async function request(
  who: Caller,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const res = await appRequest(path, {
    method,
    // Every write is JSON, as the web app sends it (csrf.ts refuses a cookie-signed write that is not).
    headers: { ...who.headers, ...extra, ...(body === undefined && method === 'GET' ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted on in the tests
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

/** POST /v1/actions/<name>, optionally with an idempotency key. */
export const act = (who: Caller, name: string, input: unknown, key?: string) =>
  request(who, 'POST', `/v1/actions/${name}`, input, key ? { 'idempotency-key': key } : {})

/**
 * Runs `run` while `who` is a server admin, then makes them a plain user again: only server admins create workspaces
 * (workspace-creation.ts), and most tests want an owner who is no server admin.
 */
export async function asServerAdmin<T>(who: User, run: () => Promise<T>): Promise<T> {
  await db.update(users).set({ instanceAdmin: true }).where(eq(users.id, who.userId))
  // As if they passed the admin passkey check (#728), for files that switch it on: a fixture, not what is tested.
  const secondFactor = process.env.ADMIN_SECOND_FACTOR
  process.env.ADMIN_SECOND_FACTOR = 'off'
  try {
    return await run()
  } finally {
    if (secondFactor === undefined) delete process.env.ADMIN_SECOND_FACTOR
    else process.env.ADMIN_SECOND_FACTOR = secondFactor
    await db.update(users).set({ instanceAdmin: false }).where(eq(users.id, who.userId))
  }
}

/** A workspace with its owner, assistant, a phone number, one contact and one call. */
export async function createWorkspace(name: string, emailVerified = true) {
  const owner = await signUp()
  if (emailVerified) await db.update(users).set({ emailVerified: true }).where(eq(users.id, owner.userId))
  const { status, body } = await asServerAdmin(owner, () => request(owner, 'POST', '/v1/workspaces', { name }))
  if (status !== 200) throw new Error(`workspace not created: ${status} ${JSON.stringify(body)}`)
  const id: string = body.workspace.id
  const [assistant] = await db.select().from(assistants).where(eq(assistants.workspace_id, id))
  const number = randomNumber()
  // Set up as phoneNumber.setup does: created_at on the API's clock, the one calls.started_at uses.
  await db
    .insert(phone_numbers)
    .values({ id: uid('pn'), workspace_id: id, e164: number, provider: 'dev', created_at: new Date().toISOString() })
  const [contact] = await db
    .insert(contacts)
    .values({ id: uid('ct'), workspace_id: id, phone: randomNumber(), name: 'Known Caller' })
    .returning()
  const [call] = await db
    .insert(calls)
    .values({
      id: uid('call'),
      workspace_id: id,
      contact_id: contact!.id,
      from_number: contact!.phone,
      to_number: number,
    })
    .returning()
  // A connected calendar account (no tokens: nothing reaches a provider) and one calendar of the assistant.
  const [connection] = await db.insert(calendar_connections)
    .values({ id: uid('calc'), workspace_id: id, provider: 'google', account_email: `${uid('cal')}@example.com`, connected_by: owner.userId })
    .returning()
  const [assistantCalendar] = await db.insert(assistant_calendars)
    .values({ id: uid('acal'), workspace_id: id, assistant_id: assistant!.id, connection_id: connection!.id, external_id: 'primary', name: 'Office', is_default: true })
    .returning()
  // A webhook of the assistant that is switched off (so it is never asked), so patches on it can be tested.
  const [webhookEndpoint] = await db.insert(webhook_endpoints)
    .values({ id: uid('whe'), workspace_id: id, assistant_id: assistant!.id, hooks: ['call_start'], status: 'disabled', url: 'https://example.com/hook', created_by: owner.userId })
    .returning()
  return { id, owner, assistant: assistant!, number, contact: contact!, call: call!, connection: connection!, assistantCalendar: assistantCalendar!, webhookEndpoint: webhookEndpoint! }
}
export type Workspace = Awaited<ReturnType<typeof createWorkspace>>

/**
 * Makes `numbers` the assistant's transfer contacts, straight in the database (as if saved before the workspace's
 * countries changed): call.transfer dials only an assistant's saved contacts.
 */
export async function saveTransferContacts(assistantId: string, numbers: string[]) {
  const transfers = numbers.map((number, i) => ({
    id: `contact${i}`,
    name: `Contact ${i + 1}`,
    number,
    condition: 'Urgent: a burst pipe',
    hours_only: false,
    ring_seconds: 25,
    if_no_answer: 'next' as const,
    enabled: true,
  }))
  await db.update(assistants).set({ transfers }).where(eq(assistants.id, assistantId))
}

export async function addMember(workspaceId: string, role: 'admin' | 'member'): Promise<User> {
  const user = await signUp()
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.userId))
  await auth.api.addMember({ body: { userId: user.userId, organizationId: workspaceId, role } })
  return user
}

export const getCall = async (id: string) => (await db.select().from(calls).where(eq(calls.id, id)))[0]
export const getContact = async (id: string) => (await db.select().from(contacts).where(eq(contacts.id, id)))[0]
export const getAssistantCalendar = async (id: string) => (await db.select().from(assistant_calendars).where(eq(assistant_calendars.id, id)))[0]
export const getWebhookEndpoint = async (id: string) => (await db.select().from(webhook_endpoints).where(eq(webhook_endpoints.id, id)))[0]
export const getAssistant = async (id: string) => (await db.select().from(assistants).where(eq(assistants.id, id)))[0]

/**
 * Allow Premium and Allow Ultra on, and the workspace's assistant on Premium with a Premium voice and model: what a
 * bill owner chose, written directly (LIN-438 tests).
 */
export async function withPremiumAndUltra(ws: Workspace) {
  await db
    .insert(workspace_settings)
    .values({ workspace_id: ws.id, timezone: 'America/Los_Angeles', allow_premium: true, allow_ultra: true })
    .onConflictDoUpdate({ target: workspace_settings.workspace_id, set: { allow_premium: true, allow_ultra: true } })
  await db
    .update(assistants)
    .set({
      call_quality: 'premium',
      voice: { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9', model: 'eleven_v3' },
      llm_model: 'gpt-4.1',
    })
    .where(eq(assistants.id, ws.assistant.id))
}

/** The workspace's Allow Premium and Allow Ultra, and its assistant's level and model picks, as stored now. */
export async function premiumAndUltraOf(ws: Workspace) {
  const [flags] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, ws.id))
  const [assistant] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  return {
    allowPremium: flags?.allow_premium ?? false,
    allowUltra: flags?.allow_ultra ?? false,
    level: assistant!.call_quality,
    voiceModel: assistant!.voice.model ?? null,
    llmModel: assistant!.llm_model,
    realtimeModel: assistant!.realtime_model,
  }
}

/** What withPremiumAndUltra set, kept. */
export const KEPT_PREMIUM_AND_ULTRA = {
  allowPremium: true,
  allowUltra: true,
  level: 'premium',
  voiceModel: 'eleven_v3',
  llmModel: 'gpt-4.1',
  realtimeModel: null,
}
