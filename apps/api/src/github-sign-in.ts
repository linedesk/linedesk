// GitHub sign-in (Better Auth's GitHub provider, scopes read:user and user:email). GitHub's profile
// email is the one the user chose to show publicly, and Better Auth would fall back to any address
// on the account. We only ever use the account's primary address, and only once GitHub has verified
// it: that address joins an existing Linedesk account (docs/architecture.md, account linking) and
// counts as proven for an invitation (there is no open sign-up). Without one the sign-in is refused.

import type { GithubProfile } from 'better-auth/social-providers'

/** One entry of GET https://api.github.com/user/emails. */
export type GitHubEmail = { email: string; primary: boolean; verified: boolean }
type Fetch = typeof fetch

/** The account's primary address if GitHub verified it, else null. Other addresses are never used. */
export function verifiedPrimaryEmail(emails: unknown): string | null {
  if (!Array.isArray(emails)) return null
  const primary = (emails as GitHubEmail[]).find(e => e?.primary === true)
  return primary?.verified === true && typeof primary.email === 'string' ? primary.email : null
}

async function getJson<T>(fetchImpl: Fetch, url: string, accessToken: string): Promise<T | null> {
  const res = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'linedesk',
    },
    redirect: 'error',
  }).catch(() => null)
  return res?.ok ? ((await res.json()) as T) : null
}

/**
 * Replaces the provider's own `getUserInfo`. Without a verified primary address the user has no
 * email, so Better Auth stops with `email_not_found` before it looks up or creates any user.
 */
export async function githubUserInfo(token: { accessToken?: string }, fetchImpl: Fetch = fetch) {
  if (!token.accessToken) return null
  const profile = await getJson<GithubProfile>(fetchImpl, 'https://api.github.com/user', token.accessToken)
  if (!profile?.id) return null
  const emails = await getJson<unknown>(fetchImpl, 'https://api.github.com/user/emails', token.accessToken)
  const email = verifiedPrimaryEmail(emails)
  return {
    user: {
      name: profile.name || profile.login || '',
      email,
      image: profile.avatar_url,
      emailVerified: email !== null,
    },
    // Better Auth keys the account on `profile.id` (the numeric GitHub user id, which never changes).
    data: { ...profile, email },
  }
}

/** The `socialProviders.github` entry for Better Auth. */
export const githubProvider = (keys: { clientId: string; clientSecret: string }) => ({
  ...keys,
  scope: ['read:user', 'user:email'],
  disableDefaultScope: true,
  getUserInfo: (token: { accessToken?: string }) => githubUserInfo(token),
})
