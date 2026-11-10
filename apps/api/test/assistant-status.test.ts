// The inbox header's status: green only when the server has what the assistant needs to answer.
import { expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { voiceReady } from '../src/provider-settings.ts'
import { anonymous, createWorkspace, request } from './helpers.ts'

const livekit = { LIVEKIT_URL: 'ws://livekit.test:7880', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secret' }
const voice = { DEEPGRAM_API_KEY: 'dg', OPENROUTER_API_KEY: 'or', ELEVENLABS_API_KEY: 'el' }

test('voice is ready only with LiveKit and a speech, language model and voice provider', async () => {
  expect(await voiceReady(db, { ...voice })).toBe(false)
  expect(await voiceReady(db, { ...livekit })).toBe(false)
  expect(await voiceReady(db, { ...livekit, DEEPGRAM_API_KEY: 'dg', OPENROUTER_API_KEY: 'or' })).toBe(false)
  expect(await voiceReady(db, { ...livekit, ...voice })).toBe(true)
})

test('any member can ask; nobody signed out can', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const res = await request(ws.owner, 'GET', '/v1/assistant/status')
  expect(res.status).toBe(200)
  expect(typeof res.body.voiceReady).toBe('boolean')
  expect((await request(anonymous, 'GET', '/v1/assistant/status')).status).toBe(401)
})
