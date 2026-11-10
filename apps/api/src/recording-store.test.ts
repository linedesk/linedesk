import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { parseRange } from './recording-route.ts'
import { createFileRecordingStore, createS3RecordingStore, RecordingConfigError, recordingStoreFromEnv } from './recording-store.ts'

const badKeys = ['../other-bucket/secret.txt', '../../etc/passwd.ogg', '/etc/passwd', 'ws_1/../ws_2/call.ogg', 'ws_1/call_1.txt', 'ws_1/sub/call_1.ogg', 'call_1.ogg', '']

describe('file store', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'callfront-recordings-'))
  const root = join(tmp, 'recordings')
  await mkdir(join(root, 'ws_1'), { recursive: true })
  await writeFile(join(root, 'ws_1/call_1.ogg'), new Uint8Array([1, 2, 3]))
  await writeFile(join(tmp, 'secret.ogg'), 'outside the root')
  const store = createFileRecordingStore(root)
  afterAll(() => rm(tmp, { recursive: true, force: true }))

  test('finds a recording under the root', async () => {
    expect(await store.exists('ws_1/call_1.ogg')).toBe(true)
    expect(await store.locate('ws_1/call_1.ogg', 300)).toMatchObject({ path: expect.stringMatching(/recordings\/ws_1\/call_1\.ogg$/), size: 3 })
    expect(await store.exists('ws_1/call_2.ogg')).toBe(false)
    expect(await store.locate('ws_1/call_2.ogg', 300)).toBeNull()
  })

  test('deletes a recording; deleting a missing one is fine', async () => {
    await writeFile(join(root, 'ws_1/call_9.ogg'), 'x')
    await store.delete('ws_1/call_9.ogg')
    expect(await store.exists('ws_1/call_9.ogg')).toBe(false)
    await expect(store.delete('ws_1/call_9.ogg')).resolves.toBeUndefined()
    await expect(store.delete('../secret.ogg')).rejects.toThrow('not a recording key')
  })

  test.each(badKeys)('refuses the key %j', async key => {
    await expect(store.locate(key, 300)).rejects.toThrow('not a recording key')
    await expect(store.exists(key)).rejects.toThrow('not a recording key')
  })

  test('does not follow a symlink out of the recordings directory', async () => {
    await symlink(join(tmp, 'secret.ogg'), join(root, 'ws_1/link.ogg'))
    await symlink(tmp, join(root, 'ws_link'))
    expect(await store.locate('ws_1/link.ogg', 300)).toBeNull()
    expect(await store.exists('ws_link/secret.ogg')).toBe(false)
  })

  test('a directory or a missing root is not a recording', async () => {
    await mkdir(join(root, 'ws_1/dir.ogg'))
    expect(await store.locate('ws_1/dir.ogg', 300)).toBeNull()
    expect(await createFileRecordingStore(join(tmp, 'nowhere')).exists('ws_1/call_1.ogg')).toBe(false)
  })
})

describe('s3 store (mocked HTTP)', () => {
  const options = { endpoint: 'https://s3.test/', region: 'us-east-1', bucket: 'recordings', accessKeyId: 'key', secretAccessKey: 'secret' }

  test('locate returns a path-style, query-signed link that expires', async () => {
    const location = await createS3RecordingStore(options).locate('ws_1/call_1.ogg', 300)
    const url = new URL((location as { url: string }).url)
    expect(url.origin + url.pathname).toBe('https://s3.test/recordings/ws_1/call_1.ogg')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^key\/\d{8}\/us-east-1\/s3\/aws4_request$/)
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(url.search).not.toContain('secret')
  })

  test.each(badKeys)('never signs or requests the key %j', async key => {
    const fakeFetch = vi.fn<typeof fetch>()
    const store = createS3RecordingStore({ ...options, fetch: fakeFetch })
    await expect(store.locate(key, 300)).rejects.toThrow('not a recording key')
    await expect(store.exists(key)).rejects.toThrow('not a recording key')
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  test('delete is a signed DELETE; a missing object is fine, anything else is an error', async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    await createS3RecordingStore({ ...options, fetch: fakeFetch }).delete('ws_1/call_1.ogg')
    const request = fakeFetch.mock.calls[0]![0] as Request
    expect([request.method, request.url]).toEqual(['DELETE', 'https://s3.test/recordings/ws_1/call_1.ogg'])
    const answer = (status: number) => createS3RecordingStore({ ...options, fetch: vi.fn<typeof fetch>(async () => new Response(null, { status })) })
    await expect(answer(404).delete('ws_1/call_1.ogg')).resolves.toBeUndefined()
    await expect(answer(403).delete('ws_1/call_1.ogg')).rejects.toThrow('DELETE ws_1/call_1.ogg failed (403)')
    await expect(answer(204).delete('../x/y.ogg')).rejects.toThrow('not a recording key')
  })

  test('exists is a signed HEAD: 200 yes, 404 no, anything else is an error', async () => {
    const answer = (status: number) => createS3RecordingStore({ ...options, fetch: vi.fn<typeof fetch>(async () => new Response(null, { status })) })
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))
    expect(await createS3RecordingStore({ ...options, fetch: fakeFetch }).exists('ws_1/call_1.ogg')).toBe(true)
    const request = fakeFetch.mock.calls[0]![0] as Request
    expect([request.method, request.url]).toEqual(['HEAD', 'https://s3.test/recordings/ws_1/call_1.ogg'])
    expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256 Credential=key/')
    expect(await answer(404).exists('ws_1/call_1.ogg')).toBe(false)
    await expect(answer(403).exists('ws_1/call_1.ogg')).rejects.toThrow('HEAD ws_1/call_1.ogg failed (403)')
  })
})

test('recordingStoreFromEnv: file by default, s3 by env, a config error names what is missing', async () => {
  expect(await recordingStoreFromEnv({ RECORDINGS_DIR: tmpdir() }).exists('ws_1/missing.ogg')).toBe(false)
  expect(await recordingStoreFromEnv({ RECORDING_STORE: '', RECORDINGS_DIR: tmpdir() }).exists('ws_1/missing.ogg')).toBe(false)
  const s3 = { RECORDING_STORE: 's3', S3_ENDPOINT: 'https://s3.test', S3_BUCKET: 'b' }
  expect(() => recordingStoreFromEnv(s3)).toThrow(RecordingConfigError)
  expect(() => recordingStoreFromEnv(s3)).toThrow('S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY not set')
  expect(await recordingStoreFromEnv({ ...s3, S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }).locate('ws_1/a.ogg', 60)).toHaveProperty('url')
  expect(() => recordingStoreFromEnv({ RECORDING_STORE: 'minio' })).toThrow('unknown RECORDING_STORE')
})

test('parseRange: the byte ranges players send', () => {
  expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
  expect(parseRange('bytes=200-299', 1000)).toEqual({ start: 200, end: 299 })
  expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
  expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  expect(parseRange('bytes=1000-', 1000)).toBeNull()
  expect(parseRange('bytes=300-200', 1000)).toBeNull()
  expect(parseRange('bytes=-', 1000)).toBeNull()
  expect(parseRange('items=0-1', 1000)).toBeNull()
})
