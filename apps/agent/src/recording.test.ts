import { expect, test, vi } from 'vitest'
import type { ApiClient } from './api-client.ts'
import { hangUp } from './call-log.ts'
import type { CallSession } from './call-session.ts'
import { describeRecording, livekitRecorder, recordingOutput, resolveRecording, saveRecording, startRecording, stopRecording, stopRecordingOrThrow, type CallRecorder, type RecordingConfig } from './recording.ts'

const call = (record_calls?: boolean) =>
  ({ callId: 'call_1', workspaceId: 'ws_1', assistant: record_calls === undefined ? null : { record_calls } }) as unknown as CallSession
const recorder = (over: Partial<CallRecorder> = {}): CallRecorder => ({
  store: 'file' as const, start: vi.fn(async () => 'EG_1'), stop: vi.fn(async () => {}), waitUntilFinal: vi.fn(async () => true), ...over,
})
const fakeApi = () => ({ run: vi.fn(async () => ({ ok: true as const, rows: {} })), providerSettings: vi.fn() }) satisfies ApiClient

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
  expect(await startRecording(broken, call(true), 'call-abc', 0)).toBeNull()
  await expect(stopRecording(broken, 'EG_1')).resolves.toBeUndefined()
  await expect(stopRecording(null, null)).resolves.toBeUndefined()
})

test('before a warm transfer the recording must really stop: a failure is reported, so nobody is put through', async () => {
  const broken = recorder({ stop: async () => { throw new Error('egress not reachable') } })
  await expect(stopRecordingOrThrow(broken, 'EG_1')).rejects.toThrow('egress not reachable')
  const working = recorder()
  await expect(stopRecordingOrThrow(working, 'EG_1')).resolves.toBeUndefined()
  expect(working.stop).toHaveBeenCalledWith('EG_1')
  // Nothing recorded (off, or it never started): nothing to stop, the transfer may go ahead.
  await expect(stopRecordingOrThrow(null, null)).resolves.toBeUndefined()
  await expect(stopRecordingOrThrow(broken, null)).resolves.toBeUndefined()
})

test('reports the recording once the file is final, sending the call id and the store', async () => {
  const api = fakeApi()
  const rec = recorder({ store: 's3' })
  await saveRecording(api, call(true), rec, 'EG_1', 15_000, { wait: async () => {} })
  expect(rec.waitUntilFinal).toHaveBeenCalledWith('EG_1', 15_000)
  expect(api.run).toHaveBeenCalledWith(expect.objectContaining({ name: 'call.setRecording' }), { callId: 'call_1', store: 's3' }, 'ws_1')

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

const s3Settings = { provider: 's3', endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'calls', access_key_id: 'k', secret_access_key: 'topsecret', prefix: 'linedesk/', force_path_style: null }

test('the store: Linedesk settings first, else RECORDING_STORE; off unless one is named', () => {
  expect(resolveRecording(null, {})).toEqual({ store: 'off' })
  expect(resolveRecording(undefined, { RECORDING_STORE: '' })).toEqual({ store: 'off' })
  expect(resolveRecording(null, { RECORDING_STORE: 'file' })).toEqual({ store: 'file' })
  expect(resolveRecording({ provider: 'file' }, { RECORDING_STORE: 's3' })).toEqual({ store: 'file' })
  expect(resolveRecording(s3Settings, { RECORDING_STORE: 'file' })).toEqual({
    store: 's3', s3: { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'calls', accessKeyId: 'k', secretAccessKey: 'topsecret', prefix: 'linedesk/', forcePathStyle: true },
  })
  expect(resolveRecording(null, { RECORDING_STORE: 's3', S3_BUCKET: 'env', S3_FORCE_PATH_STYLE: 'false' })).toMatchObject({ store: 's3', s3: { bucket: 'env', forcePathStyle: false } })
  expect(resolveRecording({ provider: 'minio' }, {})).toEqual({ store: 'off' })
  expect(livekitRecorder({ store: 'off' }, {})).toBeNull()
})

test('says in one line where calls go, never a key', () => {
  expect(describeRecording({ store: 'off' })).toContain('call recording is off')
  expect(describeRecording({ store: 'file' })).toContain('shared recordings directory')
  const s3 = describeRecording(resolveRecording(s3Settings))
  expect(s3).toContain('S3 bucket calls')
  expect(s3).not.toContain('topsecret')
})

test('egress writes into the shared directory, or uploads to S3 with the keys in the request', () => {
  const file: RecordingConfig = { store: 'file' }
  expect(recordingOutput('ws_1/call_1.ogg', file, {})).toMatchObject({ filepath: '/recordings/ws_1/call_1.ogg', output: { case: undefined } })
  expect(recordingOutput('ws_1/call_1.ogg', file, { RECORDINGS_EGRESS_DIR: '/mnt/rec' }).filepath).toBe('/mnt/rec/ws_1/call_1.ogg')

  expect(recordingOutput('ws_1/call_1.ogg', resolveRecording(s3Settings))).toMatchObject({
    filepath: 'linedesk/ws_1/call_1.ogg',
    output: { case: 's3', value: { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'calls', accessKey: 'k', secret: 'topsecret', region: 'auto', forcePathStyle: true } },
  })
  const hetzner = resolveRecording({ ...s3Settings, prefix: null, region: null, force_path_style: 'false' })
  expect(recordingOutput('ws_1/call_1.ogg', hetzner)).toMatchObject({ filepath: 'ws_1/call_1.ogg', output: { value: { region: 'us-east-1', forcePathStyle: false } } })
  const missing = () => recordingOutput('k', resolveRecording({ provider: 's3', endpoint: 'https://s3.test', secret_access_key: 'topsecret' }))
  expect(missing).toThrow('S3 recording storage is missing: bucket, access key ID')
  expect(missing).not.toThrow('topsecret')
})

test('a recording that fails to start is tried once more', async () => {
  const flaky = recorder({ start: vi.fn<CallRecorder['start']>().mockRejectedValueOnce(new Error('egress busy')).mockResolvedValue('EG_2') })
  expect(await startRecording(flaky, call(true), 'call-abc', 0)).toBe('EG_2')
  expect(flaky.start).toHaveBeenCalledTimes(2)
})
