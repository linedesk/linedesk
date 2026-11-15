import type { GroupStatus } from '@linedesk/actions'
import { expect, test } from 'vitest'
import type { AdminHealth } from './api.ts'
import { groupRow, serverRows } from './StatusCard.tsx'

const health: AdminHealth = {
  api: { ok: true, message: 'Answering.' },
  readSync: { ok: true, message: 'Answering.' },
  livekit: { ok: true, message: 'LiveKit answers' },
  sip: { ok: true, message: '1 inbound trunk' },
  agent: { ok: true, message: 'Checked in 26 s ago.' },
  email: { ok: true, message: 'Resend' },
}

const group = (over: Partial<GroupStatus>): GroupStatus => ({
  id: 'answering',
  label: 'Answering calls',
  needed: true,
  state: 'works',
  detail: null,
  message: 'Answered by OpenAI Realtime.',
  provider: 'openai_realtime',
  providerLabel: 'OpenAI Realtime',
  testedAt: null,
  parts: [],
  ...over,
})

test('a part that works: the mark says it, the row only names what is in use', () => {
  const row = groupRow(group({ answeredBy: ['Deepgram', 'OpenAI', 'ElevenLabs'] }))
  expect(row).toMatchObject({ state: 'works', mark: 'Works', value: 'Deepgram · OpenAI · ElevenLabs' })
  expect(row.href).toBe('#admin/providers/answering')
})

test('a part with a problem says it in full under its name, not cut off at the right', () => {
  const row = groupRow(group({ state: 'failing', detail: 'Key rejected', message: 'OpenAI rejected the key.' }))
  expect(row).toMatchObject({
    mark: 'Failing: Key rejected',
    value: null,
    problem: 'The API key is not accepted.',
    help: 'OpenAI rejected the key.',
  })
  // Not set up: the words alone at the right, no problem line.
  expect(groupRow(group({ state: 'missing', message: 'x' }))).toMatchObject({ value: 'Not set up', problem: null })
})

test('call audio without a SIP trunk: a partly mark, a short sentence, the server text and the fix behind the (?)', () => {
  const row = groupRow(
    group({
      id: 'call-audio',
      label: 'Call audio',
      state: 'partly',
      detail: 'phone calls (SIP) not set up',
      message: 'No inbound trunk, so no call can arrive (run setup-sip)',
      provider: null,
      providerLabel: null,
    }),
  )
  expect(row).toMatchObject({
    state: 'partly',
    mark: 'Partly works: phone calls (SIP) not set up',
    value: null,
    problem: "Calls can't come in yet: no SIP trunk.",
  })
  expect(row.help).toMatch(/^No inbound trunk, so no call can arrive\. /)
  expect(row.help).toContain('setup-sip <number>')
})

test('the server parts: a mark alone while the API and read sync respond, the voice agent with its check-in', () => {
  const [api, readSync, agent] = serverRows(health)
  expect(api).toMatchObject({ label: 'API', state: 'works', mark: 'Responding', value: null })
  expect(readSync).toMatchObject({ state: 'works', value: null })
  expect(agent).toMatchObject({ state: 'works', value: 'Checked in 26 s ago.' })
  const down = serverRows({ ...health, readSync: { ok: false, message: "Electric can't be reached." } })[1]
  expect(down).toMatchObject({ state: 'failing', value: null, problem: "Electric can't be reached." })
  // "Failing" once in the mark; a long raw error is one short line, its full text behind the (?).
  const raw = `Socket closed by the server. {"error":"${'x'.repeat(300)}"}`
  expect(serverRows({ ...health, agent: { ok: false, message: raw } })[2]).toMatchObject({
    mark: 'Failing',
    problem: 'Socket closed by the server.',
    help: raw,
  })
  expect(serverRows(null).map(r => r.state)).toEqual(['checking', 'checking', 'checking'])
})
