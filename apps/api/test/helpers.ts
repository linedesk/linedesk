// Test fixtures: real users and sessions through Better Auth, workspaces through the API,
// rows straight into the test database. Every id is random, so test files can run in parallel.
import { assistants, calls, contacts, phone_numbers } from '@callfront/db'
import { eq } from 'drizzle-orm'
import { app } from '../src/app.ts'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'

const ORIGIN = 'http://localhost:5173'
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
export const randomNumber = () => `+1503${Math.floor(1e6 + Math.random() * 9e6)}`

/** Auth requests are rate limited per client address; each fixture user comes from its own. */
export const randomIp = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 256)).join('.')}`

export type Caller = { headers: Record<string, string> }
export type User = Caller & { userId: string }

export async function signUp(): Promise<User> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': randomIp() },
    body: JSON.stringify({ name: 'Test User', email: `${uid('user')}@callfront.test`, password: 'test-password-1234' }),
  })
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`)
  const { user } = (await res.json()) as { user: { id: string } }
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  return { userId: user.id, headers: { cookie, origin: ORIGIN } }
}

export const agent = (workspaceId?: string, token = 'test-agent-token'): Caller => ({
  headers: { authorization: `Bearer ${token}`, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) },
})
export const anonymous: Caller = { headers: {} }

export async function request(
  who: Caller,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const res = await app.request(path, {
    method,
    headers: { ...who.headers, ...extra, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted on in the tests
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

/** POST /v1/actions/<name>, optionally with an idempotency key. */
export const act = (who: Caller, name: string, input: unknown, key?: string) =>
  request(who, 'POST', `/v1/actions/${name}`, input, key ? { 'idempotency-key': key } : {})

/** A workspace with its owner, assistant, a phone number, one contact and one call. */
export async function createWorkspace(name: string) {
  const owner = await signUp()
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
  return { id, owner, assistant: assistant!, number, contact: contact!, call: call! }
}
export type Workspace = Awaited<ReturnType<typeof createWorkspace>>

export async function addMember(workspaceId: string, role: 'admin' | 'member'): Promise<User> {
  const user = await signUp()
  await auth.api.addMember({ body: { userId: user.userId, organizationId: workspaceId, role } })
  return user
}

export const getCall = async (id: string) => (await db.select().from(calls).where(eq(calls.id, id)))[0]
export const getContact = async (id: string) => (await db.select().from(contacts).where(eq(contacts.id, id)))[0]
export const getAssistant = async (id: string) => (await db.select().from(assistants).where(eq(assistants.id, id)))[0]
