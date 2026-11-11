// The default voice of a new assistant is for the default text-to-speech provider (migration 0005).
import { assistants } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { act, createWorkspace } from './helpers.ts'

test('a new assistant has no voice chosen, for ElevenLabs; choosing one keeps the provider with it', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  expect(ws.assistant.voice).toEqual({ provider: 'elevenlabs', voice_id: '' })

  const voice = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' } // a curated voice
  expect((await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice })).status).toBe(200)
  const [updated] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
  expect(updated?.voice).toEqual(voice)
})
