// Helpers for tests on white-label partners' own addresses (request-host.test.ts, host-sessions.test.ts): partners and
// addresses straight in the database, requests to an address, and a sign-in made on one (sessions are bound to the
// address they were made on, host-sessions.ts).
import { organization, partner_domains, partners, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, vi } from 'vitest'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { reloadHosts } from '../src/request-host.ts'
import { appRequest, FROM, randomIp, type User } from './helpers.ts'

export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`

/** A partner straight in the database, approved unless said otherwise. */
export async function makePartner(status: 'approved' | 'suspended' | 'pending' = 'approved') {
  const id = uid('ptn')
  const now = new Date().toISOString()
  await db.insert(partners).values({
    id,
    name: `Agency ${id}`,
    status,
    created_by: 'cli',
    approved_at: status === 'pending' ? null : now,
    approved_by: status === 'pending' ? null : 'cli',
    suspended_at: status === 'suspended' ? now : null,
  })
  return id
}

/** A partner address straight in the database (S5's partner page makes them later), and the map loaded again. */
export async function addDomain(
  partnerId: string,
  hostname: string,
  status: (typeof partner_domains.$inferInsert)['status'],
) {
  const id = uid('pd')
  await db.insert(partner_domains).values({
    id,
    partner_id: partnerId,
    hostname,
    status,
    challenge_token: 'a'.repeat(64),
    created_by: 'cli',
    ...(status === 'removed' ? { removed_at: new Date().toISOString(), removed_by: 'cli' } : {}),
  })
  await reloadHosts()
  return id
}

export async function setStatus(domainId: string, status: 'active' | 'failed' | 'removed') {
  await db
    .update(partner_domains)
    .set({ status, removed_at: status === 'removed' ? new Date().toISOString() : null })
    .where(eq(partner_domains.id, domainId))
  await reloadHosts()
}

/** Makes a workspace a client of the partner (as its New client would). */
export async function makeClient(workspaceId: string, partnerId: string) {
  await db.update(organization).set({ partnerId }).where(eq(organization.id, workspaceId))
}

/** A request to `host`, as the browser on a page of `origin` would send it (the session cookie when signed in). */
export function onHost(
  host: string,
  path: string,
  init: { method?: string; who?: User; origin?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { host, [FROM]: randomIp(), ...init.headers }
  if (init.who?.headers.cookie) headers.cookie = init.who.headers.cookie
  if (init.origin) headers.origin = init.origin
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return appRequest(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

/**
 * `who` signed in again on `host` with an email code, as the sign-in page there does: a session made on that address.
 * Their email is marked verified first (a code to an unverified address signs in too, but the tests act as members).
 */
export async function signInOn(host: string, who: User): Promise<User> {
  const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, who.userId))
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, who.userId))
  const origin = `https://${host}`
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  try {
    const asked = await onHost(host, '/api/auth/email-otp/send-verification-otp', {
      origin,
      body: { email: account!.email, type: 'sign-in' },
    })
    if (!asked.ok) throw new Error(`code not sent: ${asked.status} ${await asked.text()}`)
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    const otp = send.mock.calls.at(-1)![0].subject.slice(0, 6)
    const res = await onHost(host, '/api/auth/sign-in/email-otp', { origin, body: { email: account!.email, otp } })
    if (!res.ok) throw new Error(`sign-in on ${host} failed: ${res.status} ${await res.text()}`)
    const cookie = res.headers
      .getSetCookie()
      .map(c => c.split(';')[0])
      .join('; ')
    return { userId: who.userId, headers: { cookie, origin } }
  } finally {
    send.mockRestore()
  }
}
