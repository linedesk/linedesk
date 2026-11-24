// Contract test of the Cloudflare for SaaS adapter against answers recorded from Cloudflare's API documentation
// (test/fixtures/cloudflare-saas, API v4 custom hostnames, 2026-11-18). Never calls Cloudflare.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { CLOUDFLARE_API, cloudflareSaas } from './cloudflare-saas.ts'
import { DomainProviderError, hostnameState } from './provider.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/cloudflare-saas/${name}.json`, import.meta.url), 'utf8')

const TOKEN = 'cf-token-made-up-0123456789abcdef'
const ZONE = '023e105f4ecef8ad9ca31a8372d0c353'
const ID = '0d89c70d-ad9f-4843-b99f-6cc0252067e9'
type Sent = { method: string; url: string; headers: Record<string, string>; body: unknown }

/** A fetch that answers from the recorded fixtures, one per request in order, and keeps what was sent. */
function recorded(...answers: [status: number, fixture: string][]) {
  const sent: Sent[] = []
  const doFetch = (async (url: string, init: RequestInit) => {
    sent.push({
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    })
    const [status, name] = answers.shift() ?? [500, 'auth-error']
    return new Response(fixture(name), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { sent, doFetch }
}

const provider = (doFetch: typeof fetch, customOrigin: string | null = 'saas-origin.example.com') =>
  cloudflareSaas({ token: TOKEN, zoneId: ZONE, cnameTarget: 'partners.linedesk.ai', customOrigin }, doFetch)

describe('Cloudflare for SaaS adapter', () => {
  test('create: POST custom_hostnames with HTTP DV validation and the custom origin, read as pending', async () => {
    const { sent, doFetch } = recorded([200, 'create-pending'])
    const created = await provider(doFetch).create('app.cascade-it.example')
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: `${CLOUDFLARE_API}/zones/${ZONE}/custom_hostnames`,
      headers: { authorization: `Bearer ${TOKEN}` },
      body: {
        hostname: 'app.cascade-it.example',
        ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
        custom_origin_server: 'saas-origin.example.com',
      },
    })
    expect(created).toEqual({
      id: ID,
      hostname: 'app.cascade-it.example',
      status: 'pending',
      sslStatus: 'pending_validation',
      ownership: { name: '_cf-custom-hostname.app.cascade-it.example', value: '5cc07c04-ea62-4a5a-95f0-419334a875a4' },
      errors: ['custom hostname does not CNAME to this zone.'],
    })
    expect(hostnameState(created)).toBe('pending')
  })

  test('without a custom origin the fallback origin serves it (no custom_origin_server)', async () => {
    const { sent, doFetch } = recorded([200, 'create-pending'])
    await provider(doFetch, null).create('app.cascade-it.example')
    expect(sent[0]!.body).not.toHaveProperty('custom_origin_server')
  })

  test('create of a name that exists already takes the existing one (a retry after a crash)', async () => {
    const { sent, doFetch } = recorded([409, 'create-duplicate'], [200, 'list-by-hostname'])
    const found = await provider(doFetch).create('app.cascade-it.example')
    expect(found).toMatchObject({ id: ID, status: 'pending', sslStatus: 'pending_validation' })
    expect(sent[1]).toMatchObject({
      method: 'GET',
      url: `${CLOUDFLARE_API}/zones/${ZONE}/custom_hostnames?hostname=app.cascade-it.example`,
    })
  })

  test('get: active only when the name and the certificate are; moved and a timed-out certificate', async () => {
    const active = await provider(recorded([200, 'get-active']).doFetch).get(ID)
    expect(hostnameState(active!)).toBe('active')
    const moved = await provider(recorded([200, 'get-moved']).doFetch).get(ID)
    expect(hostnameState(moved!)).toBe('moved')
    const timedOut = await provider(recorded([200, 'get-cert-timed-out']).doFetch).get(ID)
    expect(hostnameState(timedOut!)).toBe('cert_failed')
    expect(timedOut!.errors).toEqual(['The certificate authority could not validate the hostname.'])
  })

  test('get of a name Cloudflare no longer has is null; delete of one is done', async () => {
    expect(await provider(recorded([404, 'not-found']).doFetch).get(ID)).toBeNull()
    const { sent, doFetch } = recorded([200, 'delete'])
    await provider(doFetch).remove(ID)
    expect(sent[0]).toMatchObject({ method: 'DELETE', url: `${CLOUDFLARE_API}/zones/${ZONE}/custom_hostnames/${ID}` })
    await expect(provider(recorded([404, 'not-found']).doFetch).remove(ID)).resolves.toBeUndefined()
  })

  test('a refusal throws without the token in the message', async () => {
    const error = await provider(recorded([403, 'auth-error']).doFetch)
      .get(ID)
      .catch(e => e)
    expect(error).toBeInstanceOf(DomainProviderError)
    expect(error.message).toBe('Cloudflare refused (403, 10000): Authentication error')
    expect(error.message).not.toContain(TOKEN)
  })

  test('ids and names are sent encoded', async () => {
    const { sent, doFetch } = recorded([404, 'not-found'])
    await provider(doFetch).get('../zones/other')
    expect(sent[0]!.url).toBe(`${CLOUDFLARE_API}/zones/${ZONE}/custom_hostnames/..%2Fzones%2Fother`)
  })
})
