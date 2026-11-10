import { expect, test, vi } from 'vitest'
import type { ApiClient } from './api-client.ts'
import { hangUp } from './call-log.ts'
import type { CallSession } from './call-session.ts'
import { describeRecording, livekitRecorder, recordingMode, recordingOutput, saveRecording, startRecording, stopRecording, type CallRecorder } from './recording.ts'

const call = (record_calls?: boolean) =>
  ({ callId: 'call_1', workspaceId: 'ws_1', assistant: record_calls === undefined ? null : { record_calls } }) as unknown as CallSession
const recorder = (over: Partial<CallRecorder> = {}) => ({
  start: vi.fn(async () => 'EG_1'), stop: vi.fn(async () => {}), waitUntilFinal: vi.fn(async () => true), ...over,
}) satisfies CallRecorder
const fakeApi = () => ({ run: vi.fn(async () => ({ ok: true as const, rows: {} })) }) satisfies ApiClient

test('records into the key derived from workspace and call', async () => {
  const rec = recorder()
  expect(await startRecording(rec, call(true), 'call-abc')).toBe('EG_1')
  expect(rec.start).toHaveBeenCalledWith('call-abc', 'ws_1/call_1.ogg')
  expect(await startRecording(recorder(), call(), 'call-abc')).toBe('EG_1') // no assistant row: default is on
})

test('does not record when the workspace turned it off or recording is not configured', async () => {
  const rec = recorder()
  expect(await startRecording(rec, call(false), 'call-abc')).toBeNull()
  expect(rec.start).not.toHaveBeenCalled()
  expect(await startRecording(null, call(true), 'call-abc')).toBeNull()
})

test('a recording that cannot start or stop does not fail the call', async () => {
  const broken = recorder({ start: async () => { throw new Error('no egress service available') }, stop: async () => { throw new Error('gone') } })
  expect(await startRecording(broken, call(true), 'call-abc')).toBeNull()
  await expect(stopRecording(broken, 'EG_1')).resolves.toBeUndefined()
  await expect(stopRecording(null, null)).resolves.toBeUndefined()
})

test('reports the recording once the file is final, sending only the call id', async () => {
  const api = fakeApi()
  const rec = recorder()
  await saveRecording(api, call(true), rec, 'EG_1', 15_000, { wait: async () => {} })
  expect(rec.waitUntilFinal).toHaveBeenCalledWith('EG_1', 15_000)
  expect(api.run).toHaveBeenCalledWith(expect.objectContaining({ name: 'call.setRecording' }), { callId: 'call_1' }, 'ws_1')

  const notFinal = fakeApi()
  await saveRecording(notFinal, call(true), recorder({ waitUntilFinal: async () => false }), 'EG_1', 15_000)
  await saveRecording(notFinal, call(true), recorder(), null, 15_000)
  await saveRecording(notFinal, call(true), null, 'EG_1', 15_000)
  expect(notFinal.run).not.toHaveBeenCalled()
})

test('hang-up: the recording stops first and is saved even when finishing the call fails', async () => {
  const order: string[] = []
  const step = (name: string, fail = false) => async () => {
    order.push(name)
    if (fail) throw new Error(`${name} failed`)
  }
  await hangUp({ stopRecording: step('stop'), finishCall: step('finish'), saveRecording: step('save') })
  expect(order).toEqual(['stop', 'finish', 'save'])

  order.length = 0
  await expect(hangUp({ stopRecording: step('stop'), finishCall: step('finish', true), saveRecording: step('save') })).rejects.toThrow('finish failed')
  expect(order).toEqual(['stop', 'finish', 'save'])
})

test('hang-up is cut off when it does not fit the budget', async () => {
  const never = () => new Promise<void>(() => {})
  await expect(hangUp({ stopRecording: async () => {}, finishCall: never, saveRecording: async () => {} }, 20)).rejects.toThrow('gave up after 0.02 s')
})

test('recording is off unless a store is named, and says so in one line', () => {
  expect(recordingMode({})).toBe('off')
  expect(recordingMode({ RECORDING_STORE: '' })).toBe('off')
  expect(recordingMode({ RECORDING_STORE: 'file' })).toBe('file')
  expect(livekitRecorder({})).toBeNull()
  expect(describeRecording({})).toContain('call recording is off')
  expect(describeRecording({ RECORDING_STORE: 'file' })).toContain('shared recordings directory')
  expect(describeRecording({ RECORDING_STORE: 's3', S3_BUCKET: 'recs' })).toContain('S3 bucket recs')
})

test('egress writes into the shared directory, or uploads to S3 by env', () => {
  expect(recordingOutput('ws_1/call_1.ogg', { RECORDING_STORE: 'file' })).toMatchObject({ filepath: '/recordings/ws_1/call_1.ogg', output: { case: undefined } })
  expect(recordingOutput('ws_1/call_1.ogg', { RECORDING_STORE: 'file', RECORDINGS_EGRESS_DIR: '/mnt/rec' }).filepath).toBe('/mnt/rec/ws_1/call_1.ogg')

  const s3 = { RECORDING_STORE: 's3', S3_ENDPOINT: 'https://s3.test', S3_BUCKET: 'recordings', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }
  expect(recordingOutput('ws_1/call_1.ogg', s3)).toMatchObject({
    filepath: 'ws_1/call_1.ogg',
    output: { case: 's3', value: { endpoint: 'https://s3.test', bucket: 'recordings', accessKey: 'k', secret: 's', region: 'us-east-1', forcePathStyle: true } },
  })
  expect(() => recordingOutput('k', { RECORDING_STORE: 's3', S3_ENDPOINT: 'https://s3.test' })).toThrow('Missing environment variables: S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.')
})
