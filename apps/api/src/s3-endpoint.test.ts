import type { LookupAddress } from 'node:dns'
import { expect, test, vi } from 'vitest'
import { isLinkLocalAddress } from './ip-address.ts'
import { LINK_LOCAL_ENDPOINT, PRIVATE_ENDPOINT, s3EndpointProblem, s3Fetch } from './s3-endpoint.ts'

/** A made-up DNS: names that resolve to private, link-local or public addresses, and one that does not resolve. */
const names: Record<string, string[]> = {
  'minio.storage.test': ['10.0.0.5'],
  'metadata.storage.test': ['169.254.169.254'],
  'mixed.storage.test': ['93.184.215.14', '172.17.0.2'],
  'public.storage.test': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
}
const fakeDns = (host: string, done: (err: Error | null, list: LookupAddress[]) => void) => {
  const list = names[host]
  if (!list) return done(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }), [])
  done(
    null,
    list.map(address => ({ address, family: address.includes(':') ? 6 : 4 })),
  )
}

test('link-local and cloud metadata addresses, however they are written', () => {
  for (const ip of [
    '169.254.169.254',
    '169.254.0.1',
    'fe80::1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    'fd00:ec2::254',
    '100.100.100.200',
    '64:ff9b::a9fe:a9fe',
    '2002:a9fe:a9fe::1',
  ])
    expect(isLinkLocalAddress(ip), ip).toBe(true)
  for (const ip of [
    '10.0.0.5',
    '127.0.0.1',
    '93.184.215.14',
    '::1',
    'fd00::1',
    '2606:2800:21f:cb07:6820:80da:af6b:8b2c',
  ])
    expect(isLinkLocalAddress(ip), ip).toBe(false)
})

test('a setup key without the Allow: public endpoints only, checked after DNS', async () => {
  const problem = (endpoint: string) => s3EndpointProblem(endpoint, 'public', fakeDns)
  expect(await problem('http://127.0.0.1:9000')).toEqual({ kind: 'private', message: PRIVATE_ENDPOINT })
  expect(await problem('http://[::1]:9000')).toMatchObject({ kind: 'private' })
  expect(await problem('http://minio.storage.test:9000')).toMatchObject({ kind: 'private' })
  // One private address among public ones is enough to refuse.
  expect(await problem('https://mixed.storage.test')).toMatchObject({ kind: 'private' })
  expect(await problem('http://metadata.storage.test')).toEqual({ kind: 'link_local', message: LINK_LOCAL_ENDPOINT })
  expect(await problem('https://nowhere.storage.test')).toMatchObject({ kind: 'not_found' })
  expect(await problem('https://public.storage.test')).toBeNull()
  expect(await problem('https://93.184.215.14')).toBeNull()
})

test('everyone else: anything but link-local and metadata addresses', async () => {
  const problem = (endpoint: string) => s3EndpointProblem(endpoint, 'not_link_local', fakeDns)
  expect(await problem('http://169.254.169.254/latest')).toMatchObject({ kind: 'link_local' })
  expect(await problem('http://[fe80::1]:9000')).toMatchObject({ kind: 'link_local' })
  expect(await problem('http://metadata.storage.test')).toMatchObject({ kind: 'link_local' })
  // A MinIO on the Docker network is fine for the admin; a name that does not resolve is checked at the connection.
  expect(await problem('http://minio.storage.test:9000')).toBeNull()
  expect(await problem('http://127.0.0.1:9000')).toBeNull()
  expect(await problem('https://nowhere.storage.test')).toBeNull()
})

test('the S3 fetch never sends to a refused address written as such', async () => {
  const doFetch = vi.fn<typeof fetch>(async () => new Response('ok'))
  await expect(s3Fetch('not_link_local', doFetch)('http://169.254.169.254/b/k', { method: 'PUT' })).rejects.toThrow(
    'fetch failed',
  )
  await expect(s3Fetch('public', doFetch)('http://10.1.2.3:9000/b/k')).rejects.toMatchObject({
    cause: { code: 'EPRIVATEADDRESS', message: PRIVATE_ENDPOINT },
  })
  expect(doFetch).not.toHaveBeenCalled()
  expect((await s3Fetch('not_link_local', doFetch)('http://10.1.2.3:9000/b/k')).status).toBe(200)
  expect((await s3Fetch('public', doFetch)('https://93.184.215.14/b/k')).status).toBe(200)
})
