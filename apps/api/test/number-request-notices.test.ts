// The emails about a number request once the carrier decided (src/number-request-notices.ts, docs/numbers-kyc.md):
// which status changes call for one, that it is queued in the caller's transaction, who gets it (who asked and the
// owners, never a plain member or a disabled account), what it says, and that a request that moved on gets nothing.
import { number_requests, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import type { Email, EmailSender } from '../src/email.ts'
import {
  numberRequestEmail,
  numberRequestNeedsOperatorAlert,
  requestedNumberText,
} from '../src/emails/number-requests.ts'
import { setJobQueue } from '../src/jobs.ts'
import {
  NUMBER_REQUEST_NOTICE,
  noticeFor,
  notifyNumberRequestChange,
  sendNumberRequestNotice,
} from '../src/number-request-notices.ts'
import { addMember, createWorkspace, type User, type Workspace } from './helpers.ts'

const emailOf = async (who: User) => (await db.select().from(user).where(eq(user.id, who.userId)))[0]!.email

function fakeSender() {
  const sent: Email[] = []
  const sender: EmailSender = {
    kind: 'smtp',
    send: async email => void sent.push(email),
    check: async () => ({ ok: true, message: '' }),
  }
  return { sent, sender }
}

async function insertRequest(
  ws: Workspace,
  requestedBy: string,
  values: Partial<typeof number_requests.$inferInsert> = {},
): Promise<string> {
  const id = `nr_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
  const now = new Date().toISOString()
  await db.insert(number_requests).values({
    id,
    workspace_id: ws.id,
    country: 'DE',
    number_type: 'local',
    prefix: '30',
    city: 'berlin',
    status: 'pending_review',
    provider: 'dev',
    carrier_account: 'install',
    e164: '+493023125678',
    requested_by: requestedBy,
    created_at: now,
    updated_at: now,
    ...values,
  })
  return id
}

afterEach(() => setJobQueue(null))

describe('which changes call for an email', () => {
  test('reaching active, rejected or needs_operator; nothing else, and nothing when the status stayed', () => {
    expect(noticeFor('active', 'pending_review')).toBe('active')
    expect(noticeFor('active', 'needs_operator')).toBe('active')
    expect(noticeFor('rejected', 'pending_review')).toBe('rejected')
    expect(noticeFor('needs_operator', 'approved')).toBe('needs_operator')
    expect(noticeFor('needs_operator', 'needs_operator')).toBeNull()
    expect(noticeFor('active', 'active')).toBeNull()
    expect(noticeFor('pending_review', 'submitted')).toBeNull()
    expect(noticeFor('cancelled', 'pending_review')).toBeNull()
    expect(noticeFor('approved', 'pending_review')).toBeNull()
  })

  test('queued in the caller transaction, once per change; without a queue nothing happens', async () => {
    await expect(
      db.transaction(tx => notifyNumberRequestChange(tx, { id: 'nr_x', status: 'active' }, 'pending_review')),
    ).resolves.toBeUndefined()
    const send = vi.fn(async () => 'job')
    setJobQueue({ send } as never)
    await db.transaction(async tx => {
      await notifyNumberRequestChange(tx, { id: 'nr_x', status: 'rejected' }, 'pending_review')
      await notifyNumberRequestChange(tx, { id: 'nr_x', status: 'pending_review' }, 'submitted')
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      NUMBER_REQUEST_NOTICE,
      { requestId: 'nr_x', kind: 'rejected' },
      expect.objectContaining({ db: expect.anything() }),
    )
  })
})

describe('sending', () => {
  let ws: Workspace
  let admin: User
  let member: User
  beforeAll(async () => {
    ws = await createWorkspace('Brightwater Sanitär')
    admin = await addMember(ws.id, 'admin')
    member = await addMember(ws.id, 'member')
  })

  test('live: to who asked and the owner, never a plain member; the number and the link to Phone numbers', async () => {
    const id = await insertRequest(ws, admin.userId, { status: 'active' })
    const { sent, sender } = fakeSender()
    expect(await sendNumberRequestNotice(db, sender, { requestId: id, kind: 'active' })).toEqual({ sent: 2, failed: 0 })
    const to = sent.map(e => e.to).sort()
    expect(to).toEqual([await emailOf(ws.owner), await emailOf(admin)].map(a => a.toLowerCase()).sort())
    expect(to).not.toContain((await emailOf(member)).toLowerCase())
    expect(sent[0]!.subject).toBe('Your German number +49 30 23125678 is live')
    expect(sent[0]!.text).toContain('your number in Berlin is set up')
    expect(sent[0]!.text).toContain(`#workspace/phone?`)
  })

  test('rejected: the carrier reason as it came, what to do, nothing charged', async () => {
    const id = await insertRequest(ws, ws.owner.userId, {
      status: 'rejected',
      reason: 'Proof of address must show the business in Berlin.',
    })
    const { sent, sender } = fakeSender()
    expect(await sendNumberRequestNotice(db, sender, { requestId: id, kind: 'rejected' })).toEqual({
      sent: 1,
      failed: 0,
    })
    expect(sent[0]!.subject).toBe('Your number request for Berlin was not approved')
    expect(sent[0]!.text).toContain('Proof of address must show the business in Berlin.')
    expect(sent[0]!.text).toContain('Nothing was charged')
  })

  test('a disabled account gets nothing; a request that moved on or is gone gets nothing', async () => {
    const id = await insertRequest(ws, admin.userId, { status: 'rejected', reason: 'requirements_declined' })
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, admin.userId))
    try {
      const { sent, sender } = fakeSender()
      await sendNumberRequestNotice(db, sender, { requestId: id, kind: 'rejected' })
      expect(sent.map(e => e.to)).toEqual([(await emailOf(ws.owner)).toLowerCase()])
      expect(sent[0]!.text).toContain('The carrier declined the documents.')
    } finally {
      await db.update(user).set({ disabledAt: null }).where(eq(user.id, admin.userId))
    }
    const { sent, sender } = fakeSender()
    expect(await sendNumberRequestNotice(db, sender, { requestId: id, kind: 'active' })).toMatchObject({
      skipped: 'moved_on',
    })
    expect(await sendNumberRequestNotice(db, sender, { requestId: 'nr_none', kind: 'active' })).toMatchObject({
      skipped: 'gone',
    })
    expect(sent).toEqual([])
  })

  test('a failed send throws when nothing went out, so the job tries again', async () => {
    const id = await insertRequest(ws, ws.owner.userId, { status: 'active' })
    const sender: EmailSender = {
      kind: 'smtp',
      send: async () => {
        throw new Error('smtp down')
      },
      check: async () => ({ ok: false, message: '' }),
    }
    await expect(sendNumberRequestNotice(db, sender, { requestId: id, kind: 'active' })).rejects.toThrow(
      /no number request email/,
    )
  })
})

describe('the texts', () => {
  test('the number as written in the country; the area code while none is reserved', () => {
    expect(requestedNumberText('DE', '30', '+493023125678')).toBe('+49 30 23125678')
    expect(requestedNumberText('IE', '1', '+35315550100')).toBe('+353 1 5550100')
    expect(requestedNumberText('DE', '30', null)).toBe('030')
    expect(requestedNumberText('DE', '89', '+493023125678')).toBe('+493023125678')
  })

  test('a city the catalog does not name shows its area code; an unknown reason code stays as written', () => {
    const email = numberRequestEmail(
      { kind: 'rejected', country: 'DE', city: 'potsdam', prefix: '331', e164: null, reason: 'odd_code' },
      'ws_1',
      'https://desk.example.com',
    )
    expect(email.subject).toBe('Your number request for 0331 was not approved')
    expect(email.text).toContain('odd_code')
  })

  test('the operator alert names the workspace, number, request and reason', () => {
    const alert = numberRequestNeedsOperatorAlert({
      requestId: 'nr_1',
      workspace: 'Brightwater (ws_1)',
      e164: '+493023125678',
      reason: 'routing_failed',
      carrierAccount: 'install',
    })('en')
    expect(alert.subject).toBe('An approved number could not be set up: +493023125678')
    const facts = alert.blocks.find(b => b.kind === 'facts')
    expect(facts).toMatchObject({
      rows: expect.arrayContaining([
        ['Workspace', 'Brightwater (ws_1)'],
        ['Request', 'nr_1'],
        ['Reason', 'routing_failed'],
        ['Carrier account', "This server's"],
      ]),
    })
  })
})
