// Numbers that need documents (KYC; docs/numbers-kyc.md, src/number-requests.ts) through the API, with the dev carrier
// (its in-memory requirement groups and orders): the flag, the profile and documents, the whole state flow from
// requested to active or rejected, the carrier's webhook, who may do what, and that nothing changes with the flag off.
import {
  commands,
  number_purchases,
  number_requests,
  organization,
  phone_numbers,
  regulatory_documents,
} from '@linedesk/db'
import { decideDevReview, devProvider } from '@linedesk/telephony'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import type { Actor } from '../src/context.ts'
import { installPurchaseRefusal, purchaseIdOfRequest } from '../src/number-purchases.ts'
import { documentSlot, NUMBER_REQUEST_WEBHOOK_PATH } from '../src/number-requests.ts'
import { deleteWorkspace } from '../src/workspace-delete.ts'
import { decryptSecret } from '../src/secrets.ts'
import { act, addMember, appRequest, createWorkspace, type Workspace } from './helpers.ts'

// The carrier is the dev provider for this file, whatever another test file picks in the shared test database.
vi.mock('../src/provider-settings.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/provider-settings.ts')>()
  return { ...original, telephonyProvider: async () => devProvider }
})

const PDF = Buffer.from('%PDF-1.4\n% a proof of address\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const upload = (kind: string, bytes: Buffer, contentType = 'application/pdf', filename = `${kind}.pdf`) => ({
  kind,
  filename,
  contentType,
  content: bytes.toString('base64'),
})

const profile = (city = 'Berlin', extra: Record<string, string> = {}) => ({
  legal_name: 'Brightwater Sanitär GmbH',
  entity_type: 'business',
  registration_number: 'HRB 123456 B',
  address: { street: 'Hauptstraße 1', city, postal_code: '10115', country: 'DE' },
  contact: { first_name: 'Mike', last_name: 'Brennan', email: 'mike@brightwater.test', phone: '+493055500100' },
  ...extra,
})

/** A workspace with a complete German profile and its three documents. */
async function readyForGermany(ws: Workspace) {
  expect((await act(ws.owner, 'numberRequest.saveProfile', profile())).status).toBe(200)
  for (const [kind, n] of [
    ['id_or_registration', 1],
    ['proof_of_address', 2],
    ['bnetza_form', 3],
  ] as const)
    expect(
      (await act(ws.owner, 'numberRequest.uploadDocument', upload(kind, Buffer.concat([PDF, Buffer.from([n])]))))
        .status,
    ).toBe(200)
}

const webhook = (body: object) =>
  appRequest(NUMBER_REQUEST_WEBHOOK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const requestRow = async (id: string) => (await db.select().from(number_requests).where(eq(number_requests.id, id)))[0]!

afterEach(() => vi.unstubAllEnvs())

describe('flag off (the default)', () => {
  let ws: Workspace
  beforeAll(async () => {
    ws = await createWorkspace('Brightwater Plumbing & Heating')
  })

  test('no country is open: the countries are empty, every request is refused, the webhook does not exist', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', '')
    expect((await act(ws.owner, 'numberRequest.countries', {})).body.data).toEqual({ countries: [] })
    const refused = await act(ws.owner, 'numberRequest.requirements', { country: 'DE' })
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('number_request_country_closed')
    expect((await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '30' })).status).toBe(409)
    expect((await webhook({ kind: 'number_order', ref: 'x' })).status).toBe(404)
    const rows = await db.select().from(number_requests).where(eq(number_requests.workspace_id, ws.id))
    expect(rows).toEqual([])
  })

  test('buying a number in Germany is refused as before: the flag does not open plain purchases', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    // Not in the account yet, so the setup would buy it.
    const find = vi.spyOn(devProvider, 'findNumber').mockResolvedValue(null)
    const buy = vi.spyOn(devProvider, 'buyNumber')
    const res = await act(ws.owner, 'phoneNumber.setup', { e164: '+493055501234', purchase: true })
    expect(res.status).toBe(409)
    expect(buy).not.toHaveBeenCalled()
    find.mockRestore()
    buy.mockRestore()
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.e164, '+493055501234'))).toEqual([])
  })

  test('only the countries the flag names are open', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'GB')
    expect((await act(ws.owner, 'numberRequest.countries', {})).body.data).toEqual({ countries: ['GB'] })
    expect((await act(ws.owner, 'numberRequest.requirements', { country: 'DE' })).status).toBe(409)
    expect((await act(ws.owner, 'numberRequest.requirements', { country: 'GB' })).status).toBe(200)
  })
})

describe('profile and documents', () => {
  let ws: Workspace
  beforeAll(async () => {
    ws = await createWorkspace('Brightwater Plumbing & Heating')
  })

  test('requirements say what is missing until the profile and documents are there', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE,GB')
    const before = await act(ws.owner, 'numberRequest.requirements', { country: 'DE' })
    expect(before.body.data).toMatchObject({
      country: 'DE',
      addressInArea: true,
      missing: {
        fields: expect.arrayContaining(['legal_name', 'registration_number']),
        documents: ['id_or_registration', 'proof_of_address', 'bnetza_form'],
      },
    })
    expect(before.body.data.cities).toContainEqual({ id: 'berlin', prefix: '30', names: ['berlin'] })
    await readyForGermany(ws)
    const after = await act(ws.owner, 'numberRequest.requirements', { country: 'DE' })
    expect(after.body.data.missing).toEqual({ fields: [], documents: [] })
    // The UK also wants a website and a use case.
    const uk = await act(ws.owner, 'numberRequest.requirements', { country: 'GB' })
    expect(uk.body.data.missing).toEqual({ fields: ['website', 'use_case'], documents: [] })
  })

  test('a document is stored encrypted, listed by name only, never logged, and the same file is kept once', async () => {
    const bytes = Buffer.concat([PDF, Buffer.from('unique-document')])
    const res = await act(ws.owner, 'numberRequest.uploadDocument', upload('proof_of_address', bytes))
    expect(res.status).toBe(200)
    const id = res.body.data.documentId as string
    const [row] = await db.select().from(regulatory_documents).where(eq(regulatory_documents.id, id))
    expect(row!.content_encrypted).not.toContain(bytes.toString('base64').slice(0, 16))
    expect(Buffer.from(decryptSecret(row!.content_encrypted, documentSlot(id)), 'base64')).toEqual(bytes)
    const again = await act(ws.owner, 'numberRequest.uploadDocument', upload('proof_of_address', bytes))
    expect(again.body.data.documentId).toBe(id)
    const listed = await act(ws.owner, 'numberRequest.getProfile', {})
    expect(listed.body.data.profile).toMatchObject({ legal_name: 'Brightwater Sanitär GmbH' })
    expect(listed.body.data.documents).toContainEqual(
      expect.objectContaining({ id, kind: 'proof_of_address', size: bytes.byteLength }),
    )
    expect(JSON.stringify(listed.body)).not.toContain(bytes.toString('base64').slice(0, 16))
    const logged = await db
      .select({ input: commands.input })
      .from(commands)
      .where(and(eq(commands.workspace_id, ws.id), eq(commands.action, 'numberRequest.uploadDocument')))
    expect(logged.length).toBeGreaterThan(0)
    expect(JSON.stringify(logged)).not.toContain(bytes.toString('base64').slice(0, 16))
  })

  test('the command log keeps ids only: no profile names, address, contact or document filenames', async () => {
    const named = Buffer.concat([PDF, Buffer.from('named-document')])
    expect(
      (
        await act(
          ws.owner,
          'numberRequest.uploadDocument',
          upload('id_or_registration', named, 'application/pdf', 'Mike-Brennan-passport.pdf'),
        )
      ).status,
    ).toBe(200)
    expect((await act(ws.owner, 'numberRequest.saveProfile', profile())).status).toBe(200)
    const logged = await db
      .select({ input: commands.input, result: commands.result })
      .from(commands)
      .where(eq(commands.workspace_id, ws.id))
    const text = JSON.stringify(logged)
    for (const personal of [
      'Brennan',
      'Hauptstraße',
      'mike@brightwater.test',
      '+493055500100',
      'HRB 123456',
      'passport.pdf',
    ])
      expect(text, personal).not.toContain(personal)
  })

  test('a file that is not what it says is refused; a PNG is taken; a document can be deleted', async () => {
    const fake = await act(
      ws.owner,
      'numberRequest.uploadDocument',
      upload('bnetza_form', Buffer.from('<html>'), 'application/pdf'),
    )
    expect(fake.status).toBe(409)
    const png = await act(
      ws.owner,
      'numberRequest.uploadDocument',
      upload('id_or_registration', PNG, 'image/png', 'id.png'),
    )
    expect(png.status).toBe(200)
    expect((await act(ws.owner, 'numberRequest.deleteDocument', { documentId: png.body.data.documentId })).status).toBe(
      200,
    )
    expect((await act(ws.owner, 'numberRequest.deleteDocument', { documentId: png.body.data.documentId })).status).toBe(
      409,
    )
  })

  test('members, other workspaces and the agent get nothing', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const member = await addMember(ws.id, 'member')
    for (const [name, input] of [
      ['numberRequest.getProfile', {}],
      ['numberRequest.saveProfile', profile()],
      ['numberRequest.uploadDocument', upload('proof_of_address', PDF)],
      ['numberRequest.create', { country: 'DE', prefix: '30' }],
      ['numberRequest.list', {}],
    ] as const)
      expect((await act(member, name, input)).status, name).toBe(403)
    const other = await createWorkspace('Other Heating')
    const theirs = await act(other.owner, 'numberRequest.getProfile', {})
    expect(theirs.body.data).toEqual({ profile: null, documents: [] })
    const [doc] = await db.select().from(regulatory_documents).where(eq(regulatory_documents.workspace_id, ws.id))
    expect((await act(other.owner, 'numberRequest.deleteDocument', { documentId: doc!.id })).status).toBe(409)
  })
})

describe('a number request from requested to active, or rejected', () => {
  let ws: Workspace
  beforeAll(async () => {
    ws = await createWorkspace('Brightwater Plumbing & Heating')
    await readyForGermany(ws)
  })

  test('an incomplete profile is refused before the carrier is asked anything', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE,GB')
    const order = vi.spyOn(devProvider.regulatory!, 'orderNumber')
    const res = await act(ws.owner, 'numberRequest.create', { country: 'GB', prefix: '20' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('number_request_incomplete')
    expect(order).not.toHaveBeenCalled()
    expect((await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '0999' })).status).toBe(409)
    order.mockRestore()
  })

  test('requested → pending_review; the webhook reads the carrier again: still pending, then approved and active', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const upload = vi.spyOn(devProvider.regulatory!, 'uploadDocument')
    const submit = vi.spyOn(devProvider.regulatory!, 'submitRequirementGroup')
    const res = await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '030' })
    expect(res.status).toBe(200)
    const request = res.body.data.request
    expect(request).toMatchObject({
      country: 'DE',
      prefix: '30',
      city: 'berlin',
      status: 'pending_review',
      reason: null,
    })
    expect(request.e164).toMatch(/^\+4930/)
    expect(res.body.data.addressOutsideArea).toBe(false)
    // Every document went to the carrier, and every requirement got a value.
    expect(upload).toHaveBeenCalledTimes(3)
    const values = submit.mock.calls[0]![0].values
    expect(values).toHaveLength((await devProvider.regulatory!.numberRequirements('DE', 'local')).length)
    expect(submit.mock.calls[0]![0].customerReference).toBe(request.id)
    upload.mockRestore()
    submit.mockRestore()

    const row = await requestRow(request.id)
    expect(row).toMatchObject({ status: 'pending_review', provider: 'dev', carrier_account: 'install' })
    expect(row.order_ref).toBeTruthy()
    expect(row.requirement_group_ref).toBeTruthy()

    // A webhook that says the order changed, while the carrier still reviews: nothing moves.
    expect((await webhook({ kind: 'number_order', ref: row.order_ref })).status).toBe(200)
    expect((await requestRow(request.id)).status).toBe('pending_review')

    // A webhook body cannot approve anything by itself: only the carrier's own answer does.
    expect((await webhook({ kind: 'number_order', ref: row.order_ref, status: 'success' })).status).toBe(200)
    expect((await requestRow(request.id)).status).toBe('pending_review')

    decideDevReview(row.order_ref!, 'approved')
    expect((await webhook({ kind: 'number_order', customerReference: request.id })).status).toBe(200)
    const done = await requestRow(request.id)
    expect(done).toMatchObject({ status: 'active', e164: request.e164 })
    const [number] = await db.select().from(phone_numbers).where(eq(phone_numbers.e164, request.e164))
    expect(number).toMatchObject({
      id: done.phone_number_id,
      workspace_id: ws.id,
      mode: 'new',
      purchased: true,
      carrier_account: 'install',
    })

    const listed = await act(ws.owner, 'numberRequest.list', {})
    expect(listed.body.data.requests[0]).toMatchObject({ id: request.id, status: 'active', phoneNumberId: number!.id })
    // Decided: a refresh changes nothing, cancelling is refused.
    expect((await act(ws.owner, 'numberRequest.refresh', { requestId: request.id })).body.data.request.status).toBe(
      'active',
    )
    expect((await act(ws.owner, 'numberRequest.cancel', { requestId: request.id })).status).toBe(409)
  })

  test('a declined review rejects the request with the reason, through a refresh', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const res = await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '40' })
    expect(res.status).toBe(200)
    expect(res.body.data.addressOutsideArea).toBe(true)
    const row = await requestRow(res.body.data.request.id)
    decideDevReview(row.order_ref!, 'declined', 'Address is not in the Hamburg area')
    const refreshed = await act(ws.owner, 'numberRequest.refresh', { requestId: row.id })
    expect(refreshed.body.data.request).toMatchObject({
      status: 'rejected',
      reason: 'Address is not in the Hamburg area',
    })
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.e164, row.e164!))).toEqual([])
  })

  test('cancelling an open request cancels the order: it never completes', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const res = await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '89' })
    const id = res.body.data.request.id
    const cancelled = await act(ws.owner, 'numberRequest.cancel', { requestId: id })
    expect(cancelled.body.data).toMatchObject({ cancelled: true, request: { status: 'cancelled' } })
    const row = await requestRow(id)
    decideDevReview(row.order_ref!, 'approved')
    expect((await devProvider.regulatory!.getNumberOrder(row.order_ref!)).status).toBe('cancelled')
    expect((await act(ws.owner, 'numberRequest.refresh', { requestId: id })).body.data.request.status).toBe('cancelled')
  })

  test('another workspace cannot see, refresh or cancel the request; a webhook for an unknown order changes nothing', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const [row] = await db.select().from(number_requests).where(eq(number_requests.workspace_id, ws.id))
    const other = await createWorkspace('Other Heating')
    expect((await act(other.owner, 'numberRequest.list', {})).body.data.requests).toEqual([])
    expect((await act(other.owner, 'numberRequest.refresh', { requestId: row!.id })).status).toBe(409)
    expect((await act(other.owner, 'numberRequest.cancel', { requestId: row!.id })).status).toBe(409)
    expect((await webhook({ kind: 'number_order', ref: 'dev_order_unknown' })).status).toBe(200)
    expect((await webhook({ something: 'else' })).status).toBe(200)
  })

  test('at most two open requests per workspace', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const ws2 = await createWorkspace('Brightwater Two')
    await readyForGermany(ws2)
    expect((await act(ws2.owner, 'numberRequest.create', { country: 'DE', prefix: '221' })).status).toBe(200)
    expect((await act(ws2.owner, 'numberRequest.create', { country: 'DE', prefix: '69' })).status).toBe(200)
    const third = await act(ws2.owner, 'numberRequest.create', { country: 'DE', prefix: '711' })
    expect(third.status).toBe(409)
  })
})

describe('the carrier decides before Linedesk does: nothing is left on the account unpaid', () => {
  let ws: Workspace
  beforeAll(async () => {
    ws = await createWorkspace('Brightwater Plumbing & Heating')
    await readyForGermany(ws)
  })

  test('cancelling an order the carrier completed meanwhile sets the number up instead (not cancelled)', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const res = await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '30' })
    const row = await requestRow(res.body.data.request.id)
    decideDevReview(row.order_ref!, 'approved')
    const cancel = await act(ws.owner, 'numberRequest.cancel', { requestId: row.id })
    expect(cancel.status).toBe(200)
    expect(cancel.body.data).toMatchObject({ cancelled: false, request: { status: 'active', e164: row.e164 } })
    const [number] = await db.select().from(phone_numbers).where(eq(phone_numbers.e164, row.e164!))
    expect(number).toMatchObject({ workspace_id: ws.id, purchased: true })
  })

  test('cancelling a request the carrier declined meanwhile rejects it with the reason', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const res = await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '40' })
    const row = await requestRow(res.body.data.request.id)
    decideDevReview(row.order_ref!, 'declined', 'Form not signed')
    const cancel = await act(ws.owner, 'numberRequest.cancel', { requestId: row.id })
    expect(cancel.body.data).toMatchObject({
      cancelled: false,
      request: { status: 'rejected', reason: 'Form not signed' },
    })
  })

  test('a create that fails after the carrier completed the order releases the number', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const fresh = await createWorkspace('Brightwater Rollback')
    await readyForGermany(fresh)
    // The carrier approves at once; reading the order back then fails, so the action rolls back.
    vi.stubEnv('LINEDESK_DEV_KYC_OUTCOME', 'approved')
    const read = vi.spyOn(devProvider.regulatory!, 'getNumberOrder').mockRejectedValue(new Error('connection reset'))
    const release = vi.spyOn(devProvider, 'releaseNumber')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await act(fresh.owner, 'numberRequest.create', { country: 'DE', prefix: '89' })
    expect(res.status).toBe(500)
    expect(release).toHaveBeenCalledTimes(1)
    const released = release.mock.calls[0]![0].e164
    expect(released).toMatch(/^\+4989/)
    expect(await db.select().from(number_requests).where(eq(number_requests.workspace_id, fresh.id))).toEqual([])
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.e164, released))).toEqual([])
    read.mockRestore()
    release.mockRestore()
    errors.mockRestore()
  })
})

describe('approved numbers that cannot be set up wait for the operator, and do not hold the workspace up', () => {
  test('routing fails: needs_operator with an ALERT, not open; a refresh sets it up once routing works', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const ws = await createWorkspace('Brightwater Parked')
    await readyForGermany(ws)
    const first = await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '30' })
    await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '40' })
    const row = await requestRow(first.body.data.request.id)
    decideDevReview(row.order_ref!, 'approved')
    const route = vi.spyOn(devProvider, 'routeToSip').mockRejectedValue(new Error('SIP trunk missing'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const parked = await act(ws.owner, 'numberRequest.refresh', { requestId: row.id })
    expect(parked.body.data.request).toMatchObject({ status: 'needs_operator', reason: 'routing_failed' })
    expect(errors.mock.calls.some(c => String(c[0]).startsWith(`ALERT number request ${row.id}`))).toBe(true)
    // Not open: a third request may be made (two open at most), and it cannot be cancelled (the number is bought).
    expect((await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '89' })).status).toBe(200)
    expect((await act(ws.owner, 'numberRequest.cancel', { requestId: row.id })).status).toBe(409)
    route.mockRestore()
    errors.mockRestore()
    const fixed = await act(ws.owner, 'numberRequest.refresh', { requestId: row.id })
    expect(fixed.body.data.request).toMatchObject({ status: 'active', reason: null })
  })

  test('the workspace was disabled while the carrier decided: parked, not set up', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const ws = await createWorkspace('Brightwater Disabled')
    await readyForGermany(ws)
    const res = await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '221' })
    const row = await requestRow(res.body.data.request.id)
    await db.update(organization).set({ disabledAt: new Date() }).where(eq(organization.id, ws.id))
    decideDevReview(row.order_ref!, 'approved')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await webhook({ kind: 'number_order', ref: row.order_ref })).status).toBe(200)
    errors.mockRestore()
    expect(await requestRow(row.id)).toMatchObject({ status: 'needs_operator', reason: 'workspace_disabled' })
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.e164, row.e164!))).toEqual([])
  })
})

describe('deleting a workspace with number requests', () => {
  test('open orders are cancelled at the carrier; a completed one on the install account is released', async () => {
    vi.stubEnv('NUMBER_KYC_COUNTRIES', 'DE')
    const ws = await createWorkspace('Brightwater Deleted')
    await readyForGermany(ws)
    const pending = await requestRow(
      (await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '30' })).body.data.request.id,
    )
    const parked = await requestRow(
      (await act(ws.owner, 'numberRequest.create', { country: 'DE', prefix: '40' })).body.data.request.id,
    )
    // The second is approved, but routing fails: on the account, set up nowhere.
    decideDevReview(parked.order_ref!, 'approved')
    const route = vi.spyOn(devProvider, 'routeToSip').mockRejectedValue(new Error('SIP trunk missing'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(ws.owner, 'numberRequest.refresh', { requestId: parked.id })
    route.mockRestore()
    expect((await requestRow(parked.id)).status).toBe('needs_operator')

    const release = vi.spyOn(devProvider, 'releaseNumber')
    const result = await db.transaction(tx =>
      deleteWorkspace(
        tx,
        { workspaceId: ws.id, name: 'Brightwater Deleted', keepAccounts: true },
        new Date().toISOString(),
        null,
      ),
    )
    errors.mockRestore()
    expect((await devProvider.regulatory!.getNumberOrder(pending.order_ref!)).status).toBe('cancelled')
    // Approved later: the cancelled order never completes.
    decideDevReview(pending.order_ref!, 'approved')
    expect((await devProvider.regulatory!.getNumberOrder(pending.order_ref!)).status).toBe('cancelled')
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ e164: parked.e164 }))
    expect(result.numbers).toContainEqual({ e164: parked.e164, carrier: 'released' })
    expect(await db.select().from(number_requests).where(eq(number_requests.workspace_id, ws.id))).toEqual([])
    release.mockRestore()
  })
})

describe('purchase limits', () => {
  test('a request the carrier rejected or that was cancelled does not count; an open one does', async () => {
    const ws = await createWorkspace('Brightwater Limits')
    const actor = { actorId: ws.owner.userId, permissions: [] } as unknown as Actor
    const now = new Date().toISOString()
    const results: (string | null)[] = []
    // In one transaction that is rolled back: the rows (on a carrier that counts) never reach the install-wide limits
    // other test files in this database check.
    const rollback = new Error('rolled back on purpose')
    await expect(
      db.transaction(async tx => {
        const add = async (status: 'rejected' | 'cancelled' | 'pending_review') => {
          const id = `nr_limit_${status}_${Math.random().toString(36).slice(2, 10)}`
          await tx.insert(number_requests).values({
            id,
            workspace_id: ws.id,
            country: 'DE',
            prefix: '30',
            city: 'berlin',
            status,
            provider: 'telnyx',
            carrier_account: 'install',
            e164: '+4930555000',
            requested_by: ws.owner.userId,
            created_at: now,
            updated_at: now,
          })
          // As create logs it, on a carrier that is not `dev` (the free one never counts).
          await tx.insert(number_purchases).values({
            id: purchaseIdOfRequest(id),
            workspace_id: ws.id,
            actor_id: ws.owner.userId,
            e164: '+4930555000',
            provider: 'telnyx',
            carrier_account: 'install',
          })
        }
        const refusal = () => installPurchaseRefusal(tx, actor, ws.id, { byNumber: false, now })
        await add('rejected')
        await add('cancelled')
        await add('rejected')
        results.push(await refusal())
        await add('pending_review')
        results.push(await refusal())
        await add('pending_review')
        results.push(await refusal())
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect(results[0]).toBeNull()
    expect(results[1]).toBeNull()
    expect(results[2]).toMatch(/A workspace can get 2 numbers/)
  })
})
