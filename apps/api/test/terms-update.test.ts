// A new terms version for existing customers (src/terms-update.ts, LIN-420): `/v1/me` asks a bill's owner once
// TERMS_VERSION changed, and account.acceptTerms records it per bill (source `terms_update`); nobody else is asked,
// nothing without terms set, and a stale version is refused. Server admin › Users shows the last acceptance.
// Instance-wide (vitest.config.ts): it makes a server admin.
import { billing_accounts, organization, terms_acceptances } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { termsUpdateFor } from '../src/terms-update.ts'
import {
  act,
  addMember,
  asServerAdmin,
  createWorkspace,
  request,
  signUp,
  type User,
  type Workspace,
} from './helpers.ts'

const TERMS = {
  TERMS_URL: 'https://desk.example.com/terms',
  TERMS_VERSION: '2026-11-18',
  PRIVACY_URL: 'https://desk.example.com/privacy',
  PRIVACY_VERSION: '2026-11-10',
}
const SHOWN = { termsVersion: TERMS.TERMS_VERSION, privacyVersion: TERMS.PRIVACY_VERSION }
const IN_EFFECT = {
  termsUrl: TERMS.TERMS_URL,
  termsVersion: TERMS.TERMS_VERSION,
  privacyUrl: TERMS.PRIVACY_URL,
  privacyVersion: TERMS.PRIVACY_VERSION,
}
const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 12)}`

beforeEach(() => {
  for (const [name, value] of Object.entries(TERMS)) vi.stubEnv(name, value)
})
afterEach(() => vi.unstubAllEnvs())

/** A bill of `owner` in `status`, `ws` on it when given. */
async function bill(
  owner: User,
  status: (typeof billing_accounts.$inferInsert)['status'],
  { ws, kind = 'cloud' }: { ws?: Workspace; kind?: 'cloud' | 'partner' } = {},
) {
  const id = rid('bill')
  await db.insert(billing_accounts).values({
    id,
    kind,
    owner_user_id: owner.userId,
    status,
    // A suspended bill always says why (schema check).
    ...(status === 'suspended' ? { suspend_reason: 'payment' as const } : {}),
  })
  if (ws) await db.update(organization).set({ billingAccountId: id }).where(eq(organization.id, ws.id))
  return id
}

/** An acceptance of `owner` for `billId` of these versions, as sign-up records it. */
const accepted = (owner: User, billId: string, termsVersion: string, privacyVersion = TERMS.PRIVACY_VERSION) =>
  db.insert(terms_acceptances).values({
    id: rid('ta'),
    user_id: owner.userId,
    billing_account_id: billId,
    source: 'signup',
    terms_url: TERMS.TERMS_URL,
    terms_version: termsVersion,
    privacy_url: TERMS.PRIVACY_URL,
    privacy_version: privacyVersion,
    // A day ago, on the API's clock (the database's may differ from it).
    accepted_at: new Date(Date.now() - 86_400_000).toISOString(),
  })

const askedOf = async (who: User) => {
  const res = await request(who, 'GET', '/v1/me')
  expect(res.status).toBe(200)
  return res.body.termsUpdate
}
const acceptancesOf = (who: User, source?: 'terms_update') =>
  db
    .select()
    .from(terms_acceptances)
    .where(and(eq(terms_acceptances.user_id, who.userId), source ? eq(terms_acceptances.source, source) : undefined))

describe('a new terms version (LIN-420)', () => {
  test("a bill's owner who accepted an older version is asked once; accepting records it with where from", async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const billId = await bill(ws.owner, 'active', { ws })
    await accepted(ws.owner, billId, '2026-11-17')
    expect(await askedOf(ws.owner)).toEqual(IN_EFFECT)

    const res = await act(ws.owner, 'account.acceptTerms', SHOWN)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toEqual({ accepted: 1 })
    const [row, ...more] = await acceptancesOf(ws.owner, 'terms_update')
    expect(more).toEqual([])
    expect(row).toMatchObject({
      billing_account_id: billId,
      terms_url: TERMS.TERMS_URL,
      terms_version: TERMS.TERMS_VERSION,
      privacy_url: TERMS.PRIVACY_URL,
      privacy_version: TERMS.PRIVACY_VERSION,
      disclosure: null,
    })
    expect(row!.ip_address).toBeTruthy()
    expect(await askedOf(ws.owner)).toBeNull()

    // Asked again (a second tab): nothing more is recorded.
    expect((await act(ws.owner, 'account.acceptTerms', SHOWN)).body.data).toEqual({ accepted: 0 })
    expect(await acceptancesOf(ws.owner, 'terms_update')).toHaveLength(1)
  })

  test('an owner with no acceptance at all (a bill from before A9) is asked too; every owned bill is recorded', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const first = await bill(ws.owner, 'trialing', { ws })
    const second = await bill(ws.owner, 'comped')
    const suspended = await bill(ws.owner, 'suspended')
    expect(await askedOf(ws.owner)).toEqual(IN_EFFECT)
    expect((await act(ws.owner, 'account.acceptTerms', SHOWN)).body.data).toEqual({ accepted: 3 })
    const bills = (await acceptancesOf(ws.owner, 'terms_update')).map(r => r.billing_account_id).sort()
    expect(bills).toEqual([first, second, suspended].sort())
  })

  test('already accepted this version, or only the privacy policy changed: not asked', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const billId = await bill(ws.owner, 'active', { ws })
    await accepted(ws.owner, billId, TERMS.TERMS_VERSION, '2026-01-01')
    expect(await askedOf(ws.owner)).toBeNull()
    expect((await act(ws.owner, 'account.acceptTerms', SHOWN)).body.data).toEqual({ accepted: 0 })
  })

  test('nobody else is asked: a member, a canceled bill, a cloud sign-up waiting for Checkout', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    await bill(ws.owner, 'active', { ws })
    const member = await addMember(ws.id, 'admin')
    expect(await askedOf(member)).toBeNull()
    expect((await act(member, 'account.acceptTerms', SHOWN)).body.data).toEqual({ accepted: 0 })
    expect(await acceptancesOf(member)).toEqual([])

    const other = await createWorkspace('Riverside Dental')
    await bill(other.owner, 'canceled', { ws: other })
    await bill(other.owner, 'pending_payment')
    expect(await askedOf(other.owner)).toBeNull()
  })

  test('a partner bill waiting for Checkout is asked: its Checkout takes no terms', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const billId = await bill(ws.owner, 'pending_payment', { kind: 'partner' })
    await accepted(ws.owner, billId, '2026-11-17')
    expect(await askedOf(ws.owner)).toEqual(IN_EFFECT)
  })

  test('without terms set (a self-hosted install): nobody is asked, and accepting is refused', async () => {
    vi.stubEnv('TERMS_URL', '')
    vi.stubEnv('TERMS_VERSION', '')
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    await bill(ws.owner, 'active', { ws })
    expect(await askedOf(ws.owner)).toBeNull()
    const res = await act(ws.owner, 'account.acceptTerms', SHOWN)
    expect(res.status).toBe(409)
    expect(await acceptancesOf(ws.owner)).toEqual([])
  })

  test('versions other than in effect (changed while the dialog was open): refused with terms_changed', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    await bill(ws.owner, 'active', { ws })
    for (const stale of [
      { ...SHOWN, termsVersion: '2026-11-17' },
      { ...SHOWN, privacyVersion: '2026-01-01' },
    ]) {
      const res = await act(ws.owner, 'account.acceptTerms', stale)
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('terms_changed')
    }
    expect((await act(ws.owner, 'account.acceptTerms', {})).status).toBe(422)
    expect(await acceptancesOf(ws.owner)).toEqual([])
  })

  test('only the person in the app: a personal key cannot accept', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    await bill(ws.owner, 'active', { ws })
    const made = await act(ws.owner, 'personalKey.create', { name: 'Script' })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    const key = { headers: { authorization: `Bearer ${made.body.data.key}` } }
    expect((await act(key, 'account.acceptTerms', SHOWN)).status).toBe(403)
    expect((await request(key, 'GET', '/v1/me')).body.termsUpdate).toBeNull()
    expect(await acceptancesOf(ws.owner)).toEqual([])
  })

  test('never while signed in as someone else, nor without account:own (a partner address) or a session', async () => {
    const owner = await signUp()
    await bill(owner, 'active')
    const actor: Actor = {
      actorId: owner.userId,
      role: 'owner',
      workspaceId: null,
      permissions: ['account:own'],
      sessionId: 'session',
    }
    expect(await termsUpdateFor(db, actor)).toEqual(IN_EFFECT)
    expect(await termsUpdateFor(db, { ...actor, impersonation: { by: 'admin' } as never })).toBeNull()
    expect(await termsUpdateFor(db, { ...actor, permissions: [] })).toBeNull()
    expect(await termsUpdateFor(db, { ...actor, sessionId: undefined })).toBeNull()
  })

  test('Server admin › Users shows the last acceptance, or none', async () => {
    const ws = await createWorkspace('Brightwater Plumbing & Heating')
    const billId = await bill(ws.owner, 'active', { ws })
    await accepted(ws.owner, billId, '2026-11-17')
    await act(ws.owner, 'account.acceptTerms', SHOWN)
    const admin = await signUp()
    const res = await asServerAdmin(admin, () => request(admin, 'GET', '/v1/admin/users'))
    expect(res.status).toBe(200)
    const listed = (id: string) => res.body.users.find((u: { id: string }) => u.id === id)
    expect(listed(ws.owner.userId).terms).toMatchObject({
      terms_version: TERMS.TERMS_VERSION,
      privacy_version: TERMS.PRIVACY_VERSION,
      source: 'terms_update',
    })
    expect(listed(ws.owner.userId).terms.accepted_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/)
    // Versions, source and time only: never the IP address or browser of the acceptance.
    expect(Object.keys(listed(ws.owner.userId).terms).sort()).toEqual([
      'accepted_at',
      'privacy_version',
      'source',
      'terms_version',
    ])
    expect(listed(admin.userId).terms).toBeNull()
  })
})
