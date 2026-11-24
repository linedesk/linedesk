// The default voice of a new assistant is for the default text-to-speech provider (migration 0005).
import { assistants } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, addMember, createWorkspace } from './helpers.ts'

test('a new assistant has no voice chosen, for ElevenLabs; choosing one keeps the provider with it', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  expect(ws.assistant.voice).toEqual({ provider: 'elevenlabs', voice_id: '' })

  const voice = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' } // a curated voice
  expect((await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice })).status).toBe(200)
  const [updated] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  expect(updated?.voice).toEqual(voice)
})

test("the realtime voice is the assistant's own, kept apart from the three stages' voice; only realtime voices are taken", async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  expect(ws.assistant.realtime_voice).toBe('') // the server's default voice
  const voice = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' }
  await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice })
  const set = await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, realtime_voice: 'cedar' })
  expect(set.status).toBe(200)
  const [updated] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  expect(updated).toMatchObject({ realtime_voice: 'cedar', voice })

  for (const bad of ['nova', 'cgSgspJ2msm6clMCkdW9', 'Cedar'])
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, realtime_voice: bad })).status,
      bad,
    ).toBe(422)
  // A member cannot change it (settings:write).
  const member = await addMember(ws.id, 'member')
  expect((await act(member, 'assistant.update', { assistantId: ws.assistant.id, realtime_voice: 'ash' })).status).toBe(
    403,
  )

  await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, realtime_voice: '' })
  const [back] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  expect(back?.realtime_voice).toBe('')
})

test('a copy of an assistant keeps its realtime voice', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, realtime_voice: 'sage' })
  const res = await act(ws.owner, 'assistant.create', { copyOf: ws.assistant.id })
  const { assistantId } = (res.body as { data: { assistantId: string } }).data
  const [copy] = await db.select().from(assistants).where(eq(assistants.id, assistantId))
  expect(copy?.realtime_voice).toBe('sage')
})
