// Partner › AI keys (S7): each stage with its provider, the key's last four characters and the test, never a key; the
// owner's buttons only for the owner and not while a server admin turned the keys off.
import type { PartnerKeyRow, PartnerKeysData } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { KeyRows, keysErrorText, ownKeysShown, readyLine, ServerAiRow, stageLine, stageState } from './PartnerKeys.tsx'

const row = (stage: PartnerKeyRow['stage'], over: Partial<PartnerKeyRow> = {}): PartnerKeyRow => ({
  stage,
  provider: null,
  last4: null,
  status: null,
  failure: null,
  checkedAt: null,
  updatedAt: null,
  ...over,
})

const data = (over: Partial<PartnerKeysData> = {}): PartnerKeysData => ({
  stages: [
    row('stt', { provider: 'deepgram', last4: 'A1B2', status: 'ok', checkedAt: new Date().toISOString() }),
    row('llm', { provider: 'anthropic', last4: 'C3D4', status: 'failing', failure: 'invalid x-api-key' }),
    row('tts', { provider: 'elevenlabs', last4: 'E5F6', status: 'untested' }),
    row('realtime'),
  ],
  canEdit: true,
  disabled: null,
  ready: { threeStage: false, realtime: false },
  ...over,
})

const render = (d: PartnerKeysData) =>
  renderToStaticMarkup(<KeyRows data={d} busy={null} onConnect={() => {}} onTest={() => {}} onClear={() => {}} />)

test('every stage in order, with the provider, the last four characters and the test; nothing connected says so', () => {
  const html = render(data())
  const order = ['Speech to text', 'Language model', 'Voice', 'Realtime'].map(word => html.indexOf(word))
  expect(order.every(i => i >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(html).toContain('Deepgram · •••• A1B2 · ')
  expect(html).toContain('invalid x-api-key')
  expect(html).toContain('Not connected')
  // The owner: Test and Change for a connected stage, Connect for an empty one.
  expect(html).toContain('>Connect<')
  expect(html.match(/>Change</g)).toHaveLength(3)
  expect(html.match(/>Test</g)).toHaveLength(3)
})

test('an admin of the team, or keys a server admin turned off: no buttons', () => {
  expect(render(data({ canEdit: false }))).not.toMatch(/>(Connect|Change|Test)</)
  expect(render(data({ disabled: { reason: 'abuse', at: new Date().toISOString() } }))).not.toMatch(
    />(Connect|Change|Test)</,
  )
})

test('the mark and line of a stage', () => {
  expect(stageState(row('stt'))).toBe('missing')
  expect(stageState(row('stt', { provider: 'deepgram', status: 'ok' }))).toBe('works')
  expect(stageState(row('stt', { provider: 'deepgram', status: 'failing' }))).toBe('failing')
  expect(stageState(row('stt', { provider: 'deepgram', status: 'untested' }))).toBe('untested')
  expect(stageLine(row('tts', { provider: 'elevenlabs', last4: 'WXYZ', status: 'untested' }))).toBe(
    'ElevenLabs · •••• WXYZ',
  )
})

test('whether calls can run on the keys yet', () => {
  expect(readyLine(data())).toBe('team.partner.keys.readyNone')
  expect(readyLine(data({ ready: { threeStage: true, realtime: false } }))).toBe('team.partner.keys.readyThreeStage')
  expect(readyLine(data({ ready: { threeStage: false, realtime: true } }))).toBe('team.partner.keys.readyRealtime')
  expect(readyLine(data({ ready: { threeStage: true, realtime: true } }))).toBe('team.partner.keys.readyBoth')
})

test("a refusal with a keys code in the page's words, others as the partner area words them", () => {
  expect(keysErrorText(Object.assign(new Error('x'), { code: 'keys_disabled' }))).toContain('turned your AI keys off')
  expect(keysErrorText(Object.assign(new Error('x'), { code: 'forbidden' }))).not.toBe('x')
  expect(keysErrorText(new Error('Too many key tests.'))).toBe('Too many key tests.')
})

test('no key yet: one line says the server’s AI is in use; the stages show once there is a key, turned off, or asked for', () => {
  const none = data({ stages: [row('stt'), row('llm'), row('tts'), row('realtime')] })
  expect(ownKeysShown(none, false)).toBe(false)
  // The owner opens them with "Use your own keys".
  expect(ownKeysShown(none, true)).toBe(true)
  // A partner with any key, or keys a server admin turned off, sees the stages at once.
  expect(ownKeysShown(data(), false)).toBe(true)
  expect(ownKeysShown({ ...none, disabled: { reason: 'abuse', at: new Date().toISOString() } }, false)).toBe(true)
  const owner = renderToStaticMarkup(<ServerAiRow canEdit onUseOwn={() => {}} />)
  expect(owner).toContain('AI for calls')
  expect(owner).toContain('This server&#x27;s speech, model and voice')
  expect(owner).toContain('>Use your own keys<')
  // No pricing claim in the line: calls are billed at the client's call quality.
  expect(owner).not.toMatch(/included|free|plan/i)
  // An admin of the team reads the line, without the owner's button.
  expect(renderToStaticMarkup(<ServerAiRow canEdit={false} onUseOwn={() => {}} />)).not.toContain('Use your own keys')
})
