import { describe, expect, it, vi } from 'vitest'
import { githubProvider, githubUserInfo, verifiedPrimaryEmail } from './github-sign-in.ts'

const profile = {
  id: 4242,
  login: 'mike-b',
  name: 'Mike Brennan',
  avatar_url: 'https://avatars.example/4242',
  email: 'public@example.com',
}

/** A fake GitHub API: /user answers `profile`, /user/emails answers `emails`. */
function fakeGitHub(emails: unknown, status = 200) {
  return vi.fn(async (url: string | URL | Request) => {
    const body = String(url).endsWith('/user/emails') ? emails : profile
    return new Response(JSON.stringify(body), { status: String(url).endsWith('/user/emails') ? status : 200 })
  }) as unknown as typeof fetch
}

describe('verifiedPrimaryEmail', () => {
  it('takes the primary address only when GitHub verified it', () => {
    expect(
      verifiedPrimaryEmail([
        { email: 'other@example.com', primary: false, verified: true },
        { email: 'mike@example.com', primary: true, verified: true },
      ]),
    ).toBe('mike@example.com')
    expect(
      verifiedPrimaryEmail([
        { email: 'other@example.com', primary: false, verified: true },
        { email: 'mike@example.com', primary: true, verified: false },
      ]),
    ).toBeNull()
    expect(verifiedPrimaryEmail([{ email: 'other@example.com', primary: false, verified: true }])).toBeNull()
    expect(verifiedPrimaryEmail(null)).toBeNull()
    expect(verifiedPrimaryEmail({ message: 'Not Found' })).toBeNull()
  })
})

describe('githubUserInfo', () => {
  it('reports the verified primary address, never the public profile address', async () => {
    const info = await githubUserInfo(
      { accessToken: 't' },
      fakeGitHub([
        { email: 'public@example.com', primary: false, verified: true },
        { email: 'mike@example.com', primary: true, verified: true },
      ]),
    )
    expect(info?.user).toEqual({
      name: 'Mike Brennan',
      email: 'mike@example.com',
      image: profile.avatar_url,
      emailVerified: true,
    })
    expect(info?.data.id).toBe(4242)
  })

  it('reports no email when the primary address is unverified, so Better Auth refuses the sign-in', async () => {
    const info = await githubUserInfo(
      { accessToken: 't' },
      fakeGitHub([{ email: 'mike@example.com', primary: true, verified: false }]),
    )
    expect(info?.user).toMatchObject({ email: null, emailVerified: false })
    expect(info?.data.email).toBeNull()
  })

  it('reports no email when the emails could not be read (scope not granted)', async () => {
    const info = await githubUserInfo({ accessToken: 't' }, fakeGitHub({ message: 'Forbidden' }, 403))
    expect(info?.user).toMatchObject({ email: null, emailVerified: false })
  })

  it('gives up without an access token', async () => {
    expect(await githubUserInfo({}, fakeGitHub([]))).toBeNull()
  })

  it('asks only for read:user and user:email', () => {
    expect(githubProvider({ clientId: 'id', clientSecret: 's' })).toMatchObject({
      scope: ['read:user', 'user:email'],
      disableDefaultScope: true,
    })
  })
})
