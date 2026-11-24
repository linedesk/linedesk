// A blocked number is not answered: call.start files the call quietly in Spam and tells the agent to hang up.
import { assistants, calls } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { callerLocale, callLanguage } from '../src/email-locale.ts'
import { workspaceLocale } from '../src/workspace-locale.ts'
import { act, addMember, agent, createWorkspace, getCall, getContact, randomNumber } from './helpers.ts'

test('a member blocks a caller; their next call lands in Spam, read, and the agent is told to hang up', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const member = await addMember(ws.id, 'member')
  expect((await act(member, 'contact.block', { contactId: ws.contact.id })).status).toBe(200)
  expect((await getContact(ws.contact.id))?.blocked_at).toBeTruthy()

  const { status, body } = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  expect(status).toBe(200)
  expect(body.data.blocked).toBe(true)
  expect(await getCall(body.data.callId)).toMatchObject({
    status: 'completed',
    outcome: 'spam',
    unread: false,
    title: 'Blocked caller',
    duration_sec: 0,
  })

  expect((await act(member, 'contact.unblock', { contactId: ws.contact.id })).status).toBe(200)
  const again = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  expect(again.body.data.blocked).toBe(false)
  expect((await getCall(again.body.data.callId))?.status).toBe('live')
})

test("other callers are answered as usual, and another workspace cannot block this one's contacts", async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const other = await createWorkspace('Other Plumbing')
  const fresh = await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })
  expect(fresh.body.data.blocked).toBe(false)
  expect((await act(other.owner, 'contact.block', { contactId: ws.contact.id })).status).toBe(409)
  expect((await getContact(ws.contact.id))?.blocked_at).toBeNull()
})

test("the texts a call is filed with are in the call's language: a German assistant in a workspace that reads US", async () => {
  // Production, 2026-11-19: a German owner whose workspace country was not set yet (the sign-up hint said US) got
  // English texts on his German calls. The assistant answers in German, so the call's texts are German too.
  const ws = await createWorkspace('Sprachtest Sanitär')
  await db
    .update(assistants)
    .set({ languages: { main: 'de', mode: 'allowed', allowed: ['en'] } })
    .where(eq(assistants.id, ws.assistant.id))
  await db.update(calls).set({ assistant_id: ws.assistant.id }).where(eq(calls.id, ws.call.id))
  expect((await workspaceLocale(db, ws.id)).resolvedLanguage).toBe('en')
  expect(await callLanguage(db, ws.id, ws.call.id)).toBe('de')
  expect(await callerLocale(db, ws.id, ws.call.id)).toBe('de')
  // Without a call: the workspace language.
  expect(await callLanguage(db, ws.id, null)).toBe('en')
  const member = await addMember(ws.id, 'member')
  expect((await act(member, 'contact.block', { contactId: ws.contact.id })).status).toBe(200)
  const { body } = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  expect(await getCall(body.data.callId)).toMatchObject({ outcome: 'spam', title: 'Gesperrter Anrufer' })
  // The agent still gets the workspace language (its fallback for an assistant without a main language).
  expect(body.data.workspaceLanguage).toBe('en')
})
