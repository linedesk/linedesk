// Test fixtures: real users and sessions through Better Auth, workspaces through the API,
// rows straight into the test database. Every id is random, so test files can run in parallel.
import { assistant_calendars, assistants, calendar_connections, calls, contacts, phone_numbers, user as users, webhook_endpoints } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { app } from '../src/app.ts'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'

const ORIGIN = 'http://localhost:5173'
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
export const randomNumber = () => `+1503${Math.floor(1e6 + Math.random() * 9e6)}`

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
  return app.request(path, { ...init, headers }, { incoming: { socket: { remoteAddress: address, remotePort: 0, remoteFamily: 'IPv4' } } })
}

export type Caller = { headers: Record<string, string> }
export type User = Caller & { userId: string }

/** A new account with a password; its email is not verified. */
export async function signUp(email = `${uid('user')}@linedesk.test`): Promise<User> {
  const res = await appRequest('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
    body: JSON.stringify({ name: 'Test User', email, password: 'test-password-1234' }),
  })
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`)
  const { user } = (await res.json()) as { user: { id: string } }
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  return { userId: user.id, headers: { cookie, origin: ORIGIN } }
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

/** A workspace with its owner, assistant, a phone number, one contact and one call. */
export async function createWorkspace(name: string, emailVerified = true) {
  const owner = await signUp()
  if (emailVerified) await db.update(users).set({ emailVerified: true }).where(eq(users.id, owner.userId))
  const { status, body } = await request(owner, 'POST', '/v1/workspaces', { name })
  if (status !== 200) throw new Error(`workspace not created: ${status} ${JSON.stringify(body)}`)
  const id: string = body.workspace.id
  const [assistant] = await db.select().from(assistants).where(eq(assistants.workspace_id, id))
  const number = randomNumber()
  await db.insert(phone_numbers).values({ id: uid('pn'), workspace_id: id, e164: number, provider: 'dev' })
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
  // A webhook endpoint that receives nothing (no events), so patches on it can be tested.
  const [webhookEndpoint] = await db.insert(webhook_endpoints)
    .values({ id: uid('whe'), workspace_id: id, url: 'https://example.com/hook', events: [], created_by: owner.userId })
    .returning()
  return { id, owner, assistant: assistant!, number, contact: contact!, call: call!, connection: connection!, assistantCalendar: assistantCalendar!, webhookEndpoint: webhookEndpoint! }
}
export type Workspace = Awaited<ReturnType<typeof createWorkspace>>

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
