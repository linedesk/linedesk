// An in-memory S3 for tests: answers signed PUT, GET, HEAD and DELETE on path-style URLs, or always
// fails with a given status and S3 error code (the body quotes the key ID, as real S3 does).
type Failure = { status: number; code: string }

export function fakeS3(failure?: Failure) {
  const objects = new Map<string, string>()
  const log: [string, string][] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    log.push([request.method, request.url])
    const keyId = /Credential=([^/]+)\//.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
    if (failure || !keyId) {
      const { status, code } = failure ?? { status: 403, code: 'AccessDenied' }
      const body = `<?xml version="1.0"?><Error><Code>${code}</Code><Message>The key ${keyId} was refused</Message><AWSAccessKeyId>${keyId}</AWSAccessKeyId></Error>`
      return new Response(body, { status, headers: { 'content-type': 'application/xml' } })
    }
    const path = new URL(request.url).pathname
    if (request.method === 'PUT') {
      objects.set(path, await request.text())
      return new Response(null, { status: 200 })
    }
    const body = objects.get(path)
    if (request.method === 'DELETE') {
      objects.delete(path)
      return new Response(null, { status: 204 })
    }
    if (body === undefined) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
    return new Response(request.method === 'HEAD' ? null : body, { status: 200 })
  }
  return { fetch: fetch as typeof globalThis.fetch, objects, log }
}
