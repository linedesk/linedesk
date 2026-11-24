import type { GroupStatus, ProviderLine } from '@linedesk/actions'
import { expect, test } from 'vitest'
import type { AdminHealth } from './api.ts'
import { groupTrouble, troubleHeadline } from './providerStatus.ts'
import { AGENT_DOCS_URL, agentStart, groupRow, serverRows } from './StatusCard.tsx'

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

const failingLine = (over: Partial<ProviderLine>): ProviderLine => ({
  provider: 'openrouter',
  label: 'OpenRouter',
  state: 'failing',
  detail: 'Key rejected',
  message: 'OpenRouter rejected the key (HTTP 401). Enter a valid key under Server admin › Providers › OpenRouter.',
  testedAt: null,
  reason: 'auth',
  ...over,
})

test('a provider that rejects its key: named with the consequence, the fix in the row, the headline names it', () => {
  const line = failingLine({})
  const g = group({ state: 'failing', detail: 'Key rejected', message: line.message, provider: null, parts: [line] })
  const row = groupRow(g)
  expect(row).toMatchObject({
    problem: "OpenRouter rejects its API key, so calls can't be answered.",
    help: line.message,
    value: null,
    replaceKey: { provider: 'openrouter', label: 'OpenRouter' },
  })
  expect(troubleHeadline(groupTrouble(g)!)).toBe("OpenRouter's API key was rejected.")
})

test('other failures keep their link: the consequence in words, no Replace key', () => {
  const quota = failingLine({ reason: 'quota', message: 'OpenRouter quota or credit used up (HTTP 402).' })
  const answering = group({ state: 'failing', message: quota.message, parts: [quota] })
  expect(groupRow(answering)).toMatchObject({
    problem: "OpenRouter has no credit left, so calls can't be answered.",
    replaceKey: null,
  })
  expect(troubleHeadline(groupTrouble(answering)!)).toBe('OpenRouter has no credit left.')
  // A group without its own words says its name; a passing problem says the provider is not answering.
  const lookup = failingLine({ provider: 'google_places', label: 'Google Places', reason: 'timeout', message: 'x' })
  const business = group({ id: 'business', label: 'Business lookup', state: 'failing', message: 'x', parts: [lookup] })
  expect(groupRow(business).problem).toBe("Google Places isn't answering, so Business lookup doesn't work.")
  const resend = failingLine({ provider: 'resend', label: 'Resend', message: 'y' })
  const email = group({ id: 'email', label: 'Email', state: 'failing', message: 'y', parts: [resend] })
  expect(groupRow(email).problem).toBe("Resend rejects its API key, so sign-in codes and emails can't be sent.")
})

test('the failing provider is the one whose error the group shows, not another one behind it', () => {
  const stt = failingLine({ provider: 'deepgram', label: 'Deepgram', reason: 'quota', message: 'quota' })
  const llm = failingLine({})
  const g = group({ state: 'failing', message: llm.message, parts: [stt, llm] })
  expect(groupTrouble(g)).toEqual({ provider: 'openrouter', label: 'OpenRouter', reason: 'auth' })
  expect(groupTrouble(group({ state: 'works' }))).toBeNull()
})

test('the voice agent that is not running: what starts it on this install', () => {
  const message = 'Not seen since the API started. Is the agent worker running?'
  expect(agentStart('docker', message)).toMatchObject({
    problem: 'Not running. Start it on the server:',
    command: 'docker compose up -d agent',
    docs: null,
  })
  expect(agentStart('docker', message).help).toContain('voice server')
  expect(agentStart('cloud', message).command).toBe('docker compose up -d agent')
  expect(agentStart('dev', message)).toMatchObject({
    problem: 'Not running. Start it in the repository:',
    command: 'pnpm --filter @linedesk/agent worker',
    help: message,
  })
  expect(agentStart('unknown', message)).toMatchObject({ command: null, docs: AGENT_DOCS_URL })
  expect(agentStart(undefined, message).docs).toBe(AGENT_DOCS_URL)
  const agent = serverRows({ ...health, installType: 'docker', agent: { ok: false, message } })[2]
  expect(agent).toMatchObject({ state: 'failing', mark: 'Failing', command: 'docker compose up -d agent' })
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
  expect(serverRows({ ...health, readSync: { ok: false, message: raw } })[1]).toMatchObject({
    mark: 'Failing',
    problem: 'Socket closed by the server.',
    help: raw,
  })
  expect(serverRows(null).map(r => r.state)).toEqual(['checking', 'checking', 'checking'])
})
