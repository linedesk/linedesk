// A partner team invitation before sign-in (PartnerInvite.tsx): the link's token goes in the body of a POST, never in
// an address that ends up in logs, and the answer is the card's content.
import { afterEach, expect, test, vi } from 'vitest'
import { previewPartnerInvitation } from './PartnerInvite.tsx'

afterEach(() => vi.unstubAllGlobals())

test('the preview asks with the token in the body and reads the card from the answer', async () => {
  const answer = {
    status: 'open',
    partnerName: 'Northwind',
    role: 'admin',
    email: 'dana@example.com',
    invitedBy: 'Mike',
  }
  const fetch = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  expect(await previewPartnerInvitation('t'.repeat(43))).toEqual(answer)
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('/v1/partner-invitations/preview')
  expect(url).not.toContain('ttt')
  expect(init.method).toBe('POST')
  expect(JSON.parse(String(init.body))).toEqual({ token: 't'.repeat(43) })
})

test('a refused preview (too many) is an error the card says in plain words', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 429 })),
  )
  await expect(previewPartnerInvitation('t'.repeat(43))).rejects.toMatchObject({ status: 429 })
})
