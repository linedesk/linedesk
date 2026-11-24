import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { parseRange } from './recording-route.ts'
import {
  createFileRecordingStore,
  createS3RecordingStore,
  RecordingConfigError,
  S3RequestError,
  s3StoreFromValues,
} from './recording-store.ts'
import { fakeS3 } from '../test/fake-s3.ts'

const badKeys = [
  '../other-bucket/secret.txt',
  '../../etc/passwd.ogg',
  '/etc/passwd',
  'ws_1/../ws_2/call.ogg',
  'ws_1/call_1.txt',
  'ws_1/sub/call_1.ogg',
  'call_1.ogg',
  '',
]

describe('file store', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'linedesk-recordings-'))
  const root = join(tmp, 'recordings')
  await mkdir(join(root, 'ws_1'), { recursive: true })
  await writeFile(join(root, 'ws_1/call_1.ogg'), new Uint8Array([1, 2, 3]))
  await writeFile(join(tmp, 'secret.ogg'), 'outside the root')
  const store = createFileRecordingStore(root)
  afterAll(() => rm(tmp, { recursive: true, force: true }))

  test('finds a recording under the root', async () => {
    expect(await store.exists('ws_1/call_1.ogg')).toBe(true)
    expect(await store.locate('ws_1/call_1.ogg', 300)).toMatchObject({
      path: expect.stringMatching(/recordings\/ws_1\/call_1\.ogg$/),
      size: 3,
    })
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
  const options = {
    endpoint: 'https://s3.test/',
    region: 'us-east-1',
    bucket: 'recordings',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
  }

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
    const answer = (status: number) =>
      createS3RecordingStore({ ...options, fetch: vi.fn<typeof fetch>(async () => new Response(null, { status })) })
    await expect(answer(404).delete('ws_1/call_1.ogg')).resolves.toBeUndefined()
    await expect(answer(403).delete('ws_1/call_1.ogg')).rejects.toThrow('DELETE ws_1/call_1.ogg failed (403)')
    await expect(answer(204).delete('../x/y.ogg')).rejects.toThrow('not a recording key')
  })

  test('a passing server error is tried again; a lasting one fails after three tries (LIN-736)', async () => {
    const answers = [500, 503, 200]
    const flaky = vi.fn<typeof fetch>(async () => new Response(null, { status: answers.shift()! }))
    await createS3RecordingStore({ ...options, fetch: flaky, retryDelaysMs: [0, 0] }).put(
      'ws_1/call_1.ogg',
      new Uint8Array([1]),
      'audio/ogg',
    )
    expect(flaky).toHaveBeenCalledTimes(3)
    const down = vi.fn<typeof fetch>(async () => new Response(null, { status: 500 }))
    await expect(
      createS3RecordingStore({ ...options, fetch: down, retryDelaysMs: [0, 0] }).exists('ws_1/call_1.ogg'),
    ).rejects.toThrow('HEAD ws_1/call_1.ogg failed (500)')
    expect(down).toHaveBeenCalledTimes(3)
    const denied = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }))
    await expect(
      createS3RecordingStore({ ...options, fetch: denied, retryDelaysMs: [0, 0] }).exists('ws_1/call_1.ogg'),
    ).rejects.toThrow('(403)')
    expect(denied).toHaveBeenCalledTimes(1)
  })

  test('exists is a signed HEAD: 200 yes, 404 no, anything else is an error', async () => {
    const answer = (status: number) =>
      createS3RecordingStore({ ...options, fetch: vi.fn<typeof fetch>(async () => new Response(null, { status })) })
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))
    expect(await createS3RecordingStore({ ...options, fetch: fakeFetch }).exists('ws_1/call_1.ogg')).toBe(true)
    const request = fakeFetch.mock.calls[0]![0] as Request
    expect([request.method, request.url]).toEqual(['HEAD', 'https://s3.test/recordings/ws_1/call_1.ogg'])
    expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256 Credential=key/')
    expect(await answer(404).exists('ws_1/call_1.ogg')).toBe(false)
    await expect(answer(403).exists('ws_1/call_1.ogg')).rejects.toThrow('HEAD ws_1/call_1.ogg failed (403)')
  })
})

test('s3StoreFromValues: names what is missing (never a value), defaults to us-east-1 and path style', async () => {
  const values = { endpoint: 'https://s3.test', bucket: 'b' }
  expect(() => s3StoreFromValues(values)).toThrow(RecordingConfigError)
  expect(() => s3StoreFromValues(values)).toThrow('S3 storage is missing: Access key ID, Secret access key')
  expect(() =>
    s3StoreFromValues({ ...values, endpoint: 'not a url', access_key_id: 'k', secret_access_key: 'topsecret' }),
  ).toThrow('the S3 endpoint is not a URL')
  const location = await s3StoreFromValues({ ...values, access_key_id: 'k', secret_access_key: 's' }).locate(
    'ws_1/a.ogg',
    60,
  )
  const url = new URL((location as { url: string }).url)
  expect(url.origin + url.pathname).toBe('https://s3.test/b/ws_1/a.ogg')
  expect(url.searchParams.get('X-Amz-Credential')).toContain('/us-east-1/s3/')
})

test('s3: prefix and virtual-hosted style (AWS, Hetzner) as egress writes them', async () => {
  const store = s3StoreFromValues({
    endpoint: 'https://fsn1.your-objectstorage.com',
    region: 'fsn1',
    bucket: 'calls',
    access_key_id: 'k',
    secret_access_key: 's',
    prefix: '/linedesk/recordings/',
    force_path_style: 'false',
  })
  const url = new URL(((await store.locate('ws_1/a.ogg', 60)) as { url: string }).url)
  expect(url.origin + url.pathname).toBe('https://calls.fsn1.your-objectstorage.com/linedesk/recordings/ws_1/a.ogg')
  const bad = s3StoreFromValues({
    endpoint: 'https://s3.test',
    bucket: 'b',
    access_key_id: 'k',
    secret_access_key: 's',
    prefix: '../x',
  })
  await expect(bad.locate('ws_1/a.ogg', 60)).rejects.toThrow('prefix')
})

describe('probe ("Test connection")', () => {
  test('s3: puts a test object, reads it back and deletes it, all signed', async () => {
    const s3 = fakeS3()
    await createS3RecordingStore({
      endpoint: 'https://s3.test',
      region: 'auto',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
      prefix: 'pre',
      fetch: s3.fetch,
    }).probe()
    expect(s3.log.map(([method]) => method)).toEqual(['PUT', 'GET', 'DELETE'])
    expect(s3.log[0]![1]).toMatch(/^https:\/\/s3\.test\/b\/pre\/\.linedesk-probe-[0-9a-f-]+\.txt$/)
    expect(s3.objects.size).toBe(0)
  })

  test('s3: a rejected key is an S3RequestError with the status and code, not the message', async () => {
    const s3 = fakeS3({ status: 403, code: 'InvalidAccessKeyId' })
    const store = createS3RecordingStore({
      endpoint: 'https://s3.test',
      region: 'auto',
      bucket: 'b',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 's',
      fetch: s3.fetch,
    })
    const error = await store.probe().catch(e => e)
    expect(error).toBeInstanceOf(S3RequestError)
    expect([error.status, error.code, error.step]).toEqual([403, 'InvalidAccessKeyId', 'writing a test object'])
    expect(error.message).not.toContain('AKIAEXAMPLE')
  })

  test('file: writes, reads and deletes a test file; creates the directory like egress would', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'linedesk-probe-'))
    try {
      await createFileRecordingStore(join(tmp, 'recordings')).probe()
      expect(await readdir(join(tmp, 'recordings'))).toEqual([])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
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
