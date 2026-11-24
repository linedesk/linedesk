// feedback.send (LIN-639): every member, key and MCP client may send a report to the Linedesk team. It is masked before
// it is stored or sent, kept in `feedback`, emailed after the commit to FEEDBACK_EMAIL (the transport is mocked here),
// limited per sender, and never logged with its text, screenshot or contact address.
import { FEEDBACK_RATE_LIMITED } from '@linedesk/actions'
import { commands, feedback } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { type Email, emailSender } from '../src/email.ts'
import { feedbackRecipient } from '../src/feedback.ts'
import { act, addMember, anonymous, type Caller, createWorkspace, type User, type Workspace } from './helpers.ts'

let ws: Workspace
const bearer = (key: string): Caller => ({ headers: { authorization: `Bearer ${key}` } })
const rowOf = async (id: string) => (await db.select().from(feedback).where(eq(feedback.id, id)))[0]!

/** A tiny real PNG (1×1), as a data URL. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** The mail transport as SMTP would be, recording what it is given. */
function mockTransport(fail?: string) {
  const sent: Email[] = []
  vi.spyOn(emailSender, 'kind', 'get').mockReturnValue('smtp')
  vi.spyOn(emailSender, 'send').mockImplementation(async email => {
    if (fail) throw new Error(fail)
    sent.push(email)
  })
  return sent
}

const statusOf = async (id: string, not = 'pending') =>
  vi.waitFor(async () => {
    const row = await rowOf(id)
    if (row.status === not) throw new Error('still pending')
    return row
  })

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.FEEDBACK_EMAIL
})

describe('feedback.send', () => {
  test('stores the report masked, keeps contact_email, and emails it with the screenshot', async () => {
    const sent = mockTransport()
    const member = await addMember(ws.id, 'member')
    const res = await act(member, 'feedback.send', {
      kind: 'bug',
      text: 'Calls page breaks.\nMy key sk_live_0123456789abcdefFAKEkeyXYZ and +1 503 555 0142, mike@brightwater.example',
      page: '/calls/call_1?token=abc123',
      context: { version: '1.2.3', browser: 'Firefox 140', errors: 'TypeError at mike@brightwater.example' },
      screenshot: PNG,
      contact_email: 'Mike@Brightwater.example',
    })
    expect(res.status).toBe(200)
    const id: string = res.body.data.id
    expect(id).toMatch(/^fb_[0-9a-f]{20}$/)

    const row = await statusOf(id)
    expect(row.status).toBe('sent')
    expect(row.sent_at).toBeTruthy()
    expect(row.workspace_id).toBe(ws.id)
    expect(row.actor_id).toBe(member.userId)
    expect(row.via).toBe('app')
    expect(row.kind).toBe('bug')
    expect(row.text).not.toContain('sk_live_0123456789abcdefFAKEkeyXYZ')
    expect(row.text).not.toContain('555 0142')
    expect(row.text).not.toContain('mike@brightwater.example')
    expect(row.text).toContain('[email]')
    expect(row.text).toContain('Calls page breaks.')
    expect(row.page).toBe('/calls/call_1')
    expect(row.context?.errors).not.toContain('mike@brightwater.example')
    expect(row.context?.version).toBe('1.2.3')
    expect(row.has_screenshot).toBe(true)
    expect(row.contact_email).toBe('mike@brightwater.example')

    expect(sent).toHaveLength(1)
    const email = sent[0]!
    expect(email.to).toBe('support@linedesk.ai')
    expect(email.subject).toBe('[Linedesk bug] Calls page breaks.')
    expect(email.replyTo).toBe('mike@brightwater.example')
    expect(email.text).toContain(ws.id)
    expect(email.text).toContain(member.userId)
    expect(email.text).not.toContain('sk_live_0123456789abcdefFAKEkeyXYZ')
    expect(email.attachments).toHaveLength(1)
    expect(email.attachments![0]!.contentType).toBe('image/png')
    expect(email.attachments![0]!.content.subarray(0, 4).toString('hex')).toBe('89504e47')

    // The command log keeps ids only: no text, no screenshot, no address.
    const [logged] = await db.select().from(commands).where(eq(commands.action, 'feedback.send'))
    const stored = JSON.stringify(logged)
    expect(stored).not.toContain('Calls page breaks')
    expect(stored).not.toContain('iVBORw0KGgo')
    expect(stored).not.toContain('brightwater.example')
  })

  test('never sends the sender address without contact_email', async () => {
    const sent = mockTransport()
    const member = await addMember(ws.id, 'member')
    const res = await act(member, 'feedback.send', { kind: 'feature', text: 'Export calls as PDF' })
    expect(res.status).toBe(200)
    await statusOf(res.body.data.id)
    expect(sent[0]!.replyTo).toBeUndefined()
    expect(sent[0]!.subject).toBe('[Linedesk feature request] Export calls as PDF')
    expect(sent[0]!.attachments).toBeUndefined()
  })

  test('a failed email is stored as failed, and the sender gets no error', async () => {
    mockTransport('SMTP 550 for mike@brightwater.example')
    const member = await addMember(ws.id, 'member')
    const res = await act(member, 'feedback.send', { kind: 'bug', text: 'It broke' })
    expect(res.status).toBe(200)
    const row = await statusOf(res.body.data.id)
    expect(row.status).toBe('failed')
    expect(row.last_error).toContain('[email]')
  })

  test('FEEDBACK_EMAIL=off keeps the report and sends nothing', async () => {
    const sent = mockTransport()
    process.env.FEEDBACK_EMAIL = 'off'
    const member = await addMember(ws.id, 'member')
    const res = await act(member, 'feedback.send', { kind: 'setup', text: 'Calendar step was unclear' })
    expect(res.status).toBe(200)
    expect((await rowOf(res.body.data.id)).status).toBe('kept')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(sent).toHaveLength(0)
  })

  test('without email set up the report is kept', async () => {
    vi.spyOn(emailSender, 'kind', 'get').mockReturnValue('none')
    const send = vi.spyOn(emailSender, 'send')
    const member = await addMember(ws.id, 'member')
    const res = await act(member, 'feedback.send', { kind: 'bug', text: 'No email here' })
    expect(res.status).toBe(200)
    expect((await statusOf(res.body.data.id)).status).toBe('kept')
    expect(send).not.toHaveBeenCalled()
  })

  test('FEEDBACK_EMAIL: empty is the default, off is null, anything else must be an address', () => {
    expect(feedbackRecipient({})).toBe('support@linedesk.ai')
    expect(feedbackRecipient({ FEEDBACK_EMAIL: ' OFF ' })).toBeNull()
    expect(feedbackRecipient({ FEEDBACK_EMAIL: 'bugs@brightwater.example' })).toBe('bugs@brightwater.example')
    expect(() => feedbackRecipient({ FEEDBACK_EMAIL: 'not-an-address' })).toThrow()
  })

  test('a workspace API key may send; no sign-in is refused', async () => {
    mockTransport()
    const created = await act(ws.owner, 'apiKey.create', { name: 'Zapier', role: 'member' })
    expect(created.status).toBe(200)
    const res = await act(bearer(created.body.data.key), 'feedback.send', { kind: 'bug', text: 'From a key' })
    expect(res.status).toBe(200)
    const row = await rowOf(res.body.data.id)
    expect(row.via).toBe('api_key')
    expect(row.client).toBe('Zapier')

    expect((await act(anonymous, 'feedback.send', { kind: 'bug', text: 'Who am I' })).status).toBe(401)
  })

  test('input: a screenshot that is not a PNG or JPEG is refused', async () => {
    const member = await addMember(ws.id, 'member')
    const gif = await act(member, 'feedback.send', {
      kind: 'bug',
      text: 'x',
      screenshot: 'data:image/gif;base64,R0lGOD',
    })
    expect(gif.status).toBe(422)
    // A PNG data URL whose bytes are not a PNG.
    const fake = await act(member, 'feedback.send', {
      kind: 'bug',
      text: 'x',
      screenshot: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`,
    })
    expect(fake.status).toBe(409)
    expect(await db.select().from(feedback).where(eq(feedback.actor_id, member.userId))).toHaveLength(0)
  })

  test('a 3 MB screenshot passes the body limit', async () => {
    mockTransport()
    const member = await addMember(ws.id, 'member')
    const big = Buffer.alloc(3 * 1024 * 1024 - 16)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big)
    const res = await act(member, 'feedback.send', {
      kind: 'bug',
      text: 'Big screenshot',
      screenshot: `data:image/png;base64,${big.toString('base64')}`,
    })
    expect(res.status).toBe(200)
    await statusOf(res.body.data.id)
  })

  describe('rate limit', () => {
    let member: User
    beforeAll(async () => {
      member = await addMember(ws.id, 'member')
    })

    test('one per 10 seconds, then 10 an hour', async () => {
      mockTransport()
      expect((await act(member, 'feedback.send', { kind: 'bug', text: 'first' })).status).toBe(200)
      const soon = await act(member, 'feedback.send', { kind: 'bug', text: 'second' })
      expect(soon.status).toBe(409)
      expect(soon.body.code).toBe(FEEDBACK_RATE_LIMITED)
      expect(soon.body.error).toMatch(/10 seconds/)

      // Nine more in the last hour, none in the last 10 seconds: ten in all, the next is refused.
      await db
        .update(feedback)
        .set({ created_at: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(feedback.actor_id, member.userId))
      await db.insert(feedback).values(
        Array.from({ length: 9 }, (_, i) => ({
          id: `fb_rate${i}${crypto.randomUUID().slice(0, 8)}`,
          workspace_id: ws.id,
          actor_id: member.userId,
          via: 'app' as const,
          kind: 'bug' as const,
          text: 'earlier',
          status: 'kept' as const,
          created_at: new Date(Date.now() - (2 + i) * 60_000).toISOString(),
        })),
      )
      const many = await act(member, 'feedback.send', { kind: 'bug', text: 'eleventh' })
      expect(many.status).toBe(409)
      expect(many.body.code).toBe(FEEDBACK_RATE_LIMITED)

      // Older than an hour does not count.
      await db
        .update(feedback)
        .set({ created_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() })
        .where(eq(feedback.actor_id, member.userId))
      expect((await act(member, 'feedback.send', { kind: 'bug', text: 'later' })).status).toBe(200)
    })
  })
})
