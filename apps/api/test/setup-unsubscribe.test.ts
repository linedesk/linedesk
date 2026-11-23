// One-click unsubscribe from setup emails (setup-unsubscribe.ts): the signed link in each setup email and its
// List-Unsubscribe headers, the confirm page, the POST that turns setup emails off for exactly that member, and
// refusals for a tampered token.
import { calls, member_notification_settings, setup_events } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import type { Email, EmailSender } from '../src/email.ts'
import { sendSetupEmailFor, setupRecipients } from '../src/setup-emails.ts'
import { SETUP_UNSUBSCRIBE_PATH, setupUnsubscribeToken } from '../src/setup-unsubscribe.ts'
import { addMember, appRequest, createWorkspace, type Workspace } from './helpers.ts'

const NOW = new Date().toISOString()

function spySender() {
  const sent: Email[] = []
  const sender: EmailSender = {
    kind: 'smtp',
    send: async email => void sent.push(email),
    check: async () => ({ ok: true, message: '' }),
  }
  return { sender, sent }
}

/** A workspace that signed up 3 hours ago without a real call: day 0 is due. */
async function dueWorkspace(name: string) {
  const ws = await createWorkspace(name)
  await db.delete(calls).where(eq(calls.id, ws.call.id))
  await db
    .update(setup_events)
    .set({ at: new Date(Date.parse(NOW) - 3 * 3_600_000).toISOString() })
    .where(and(eq(setup_events.workspace_id, ws.id), eq(setup_events.event, 'signup')))
  return ws
}

/** Another owner of the workspace (setup emails go to owners only). */
/** An admin of the workspace: setup emails go to its one owner only, so a colleague's setting must stay untouched. */
const colleagueOf = (ws: Workspace) => addMember(ws.id, 'admin')

const setting = async (ws: Workspace, userId: string) =>
  (
    await db
      .select({ setup: member_notification_settings.setup_emails })
      .from(member_notification_settings)
      .where(
        and(eq(member_notification_settings.workspace_id, ws.id), eq(member_notification_settings.user_id, userId)),
      )
  )[0]?.setup ?? null

const get = (token: string) => appRequest(`${SETUP_UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`)
/** What a mail app sends for the one-click button (RFC 8058): a form POST, no cookie, no confirm page. */
const oneClick = (token: string) =>
  appRequest(`${SETUP_UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  })

describe('one-click unsubscribe from setup emails', () => {
  test('each setup email carries its owner’s own signed link, in the footer and as List-Unsubscribe', async () => {
    const ws = await dueWorkspace('Unsubscribe Link Plumbing')
    const { sender, sent } = spySender()
    await sendSetupEmailFor(db, sender, ws.id, NOW)
    const [mail] = sent
    const url = `http://localhost:5173${SETUP_UNSUBSCRIBE_PATH}?t=${setupUnsubscribeToken(ws.id, ws.owner.userId)}`
    expect(mail!.headers).toEqual({
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
    expect(mail!.text).toContain(url)
  })

  test('a valid token: the link shows a confirm page and changes nothing; the POST turns setup emails off, once', async () => {
    const ws = await dueWorkspace('Unsubscribe Valid Plumbing')
    const colleague = await colleagueOf(ws)
    const token = setupUnsubscribeToken(ws.id, ws.owner.userId)
    expect(await setupRecipients(db, ws.id)).toHaveLength(1)

    const page = await get(token)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<form method="post"')
    expect(await setting(ws, ws.owner.userId)).toBeNull()

    const done = await oneClick(token)
    expect(done.status).toBe(200)
    expect(await done.text()).toContain('Setup emails are off')
    expect(await setting(ws, ws.owner.userId)).toBe(false)
    // Only that owner's own setting: the colleague's stays as it was.
    expect(await setupRecipients(db, ws.id)).toHaveLength(0)
    expect(await setting(ws, colleague.userId)).toBeNull()

    // Idempotent: again, the same answer and the same state.
    expect((await oneClick(token)).status).toBe(200)
    expect(await setting(ws, ws.owner.userId)).toBe(false)
    expect(await setupRecipients(db, ws.id)).toHaveLength(0)
  })

  test('a tampered token is refused and changes nothing', async () => {
    const ws = await dueWorkspace('Unsubscribe Tampered Plumbing')
    const colleague = await colleagueOf(ws)
    const token = setupUnsubscribeToken(ws.id, ws.owner.userId)
    const [w, , mac] = token.split('.') as [string, string, string]
    const flipped = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`
    const otherUser = `${w}.${Buffer.from(colleague.userId).toString('base64url')}.${mac}`
    for (const bad of [flipped, otherUser, `${token}.x`, 'nonsense', '']) {
      expect((await get(bad)).status, bad).toBe(400)
      expect((await oneClick(bad)).status, bad).toBe(400)
    }
    expect(await setting(ws, ws.owner.userId)).toBeNull()
    expect(await setting(ws, colleague.userId)).toBeNull()
    expect(await setupRecipients(db, ws.id)).toHaveLength(1)
  })

  test("another user's token turns off only their own setup emails, never in a workspace they are not in", async () => {
    const ws = await dueWorkspace('Unsubscribe Own Plumbing')
    const other = await dueWorkspace('Unsubscribe Other Plumbing')
    // Their own token: only their own setting in their own workspace.
    expect((await oneClick(setupUnsubscribeToken(other.id, other.owner.userId))).status).toBe(200)
    expect(await setting(other, other.owner.userId)).toBe(false)
    expect(await setting(ws, ws.owner.userId)).toBeNull()
    expect(await setupRecipients(db, ws.id)).toHaveLength(1)
    // A validly signed token for a workspace the user is no member of writes nothing.
    expect((await oneClick(setupUnsubscribeToken(ws.id, other.owner.userId))).status).toBe(200)
    expect(await setting(ws, other.owner.userId)).toBeNull()
  })

  test('without SECRETS_KEY no link or header is sent, and every token is refused', async () => {
    const ws = await dueWorkspace('Unsubscribe No Key Plumbing')
    const token = setupUnsubscribeToken(ws.id, ws.owner.userId)
    const key = process.env.SECRETS_KEY
    delete process.env.SECRETS_KEY
    try {
      const { sender, sent } = spySender()
      await sendSetupEmailFor(db, sender, ws.id, NOW)
      expect(sent[0]!.headers).toBeUndefined()
      expect(sent[0]!.text).toContain(`/#account/preferences?ws=${ws.id}`)
      expect((await oneClick(token)).status).toBe(400)
    } finally {
      process.env.SECRETS_KEY = key
    }
    expect(await setting(ws, ws.owner.userId)).toBeNull()
  })
})
