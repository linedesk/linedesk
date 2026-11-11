// Which ways to sign in this install offers. Everything except the password is switched on by
// setting its env vars, so a self-hosted install works with none of them.
import type { AuthMethods, LegalLinks, SsoMethod } from './auth-types.ts'

type Env = Record<string, string | undefined>

const pair = (id?: string, secret?: string) => (id && secret ? { clientId: id, clientSecret: secret } : null)

export function readAuthConfig(env: Env) {
  const google = pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)
  const github = pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET)
  const microsoftKeys = pair(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET)
  const microsoft = microsoftKeys && { ...microsoftKeys, tenantId: env.MICROSOFT_TENANT_ID || 'common' }
  const oidcKeys = pair(env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET)
  const oidc =
    oidcKeys && env.OIDC_DISCOVERY_URL
      ? { ...oidcKeys, discoveryUrl: env.OIDC_DISCOVERY_URL, label: env.OIDC_DISPLAY_NAME || 'Single sign-on' }
      : null
  // No provider is trusted by name (Better Auth's `trustedProviders` would join an account without
  // asking whether the email is verified). Every provider sign-in must prove its address instead:
  // Google's email_verified, Microsoft's personal accounts or domain-verified work email, GitHub's
  // verified primary email (account-linking.ts, github-sign-in.ts), OIDC's email_verified.
  const trustedProviders: string[] = []
  const methods: AuthMethods = {
    password: env.AUTH_PASSWORD_ENABLED !== 'false',
    emailCode: emailDelivery(env) !== 'none',
    passkey: env.AUTH_PASSKEY_ENABLED !== 'false',
    signUp: env.AUTH_SIGNUP_ENABLED !== 'false',
    sso: [
      google && { id: 'google', label: 'Google' },
      microsoft && { id: 'microsoft', label: 'Microsoft' },
      github && { id: 'github', label: 'GitHub' },
      oidc && { id: 'oidc', label: oidc.label },
    ].filter(Boolean) as SsoMethod[],
    links: readLegalLinks(env),
  }
  return { google, microsoft, github, oidc, trustedProviders, methods }
}

const httpUrl = (value?: string) => {
  const url = value?.trim()
  if (!url) return null
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(`${url} is not an http(s) URL (TERMS_URL / PRIVACY_URL)`)
  return url
}

/** Links the sign-in page and the profile menu show. A malformed value fails at start, not silently. */
export function readLegalLinks(env: Env): LegalLinks {
  const supportEmail = env.SUPPORT_EMAIL?.trim() || null
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail))
    throw new Error(`SUPPORT_EMAIL ${supportEmail} is not an email address`)
  return { terms: httpUrl(env.TERMS_URL), privacy: httpUrl(env.PRIVACY_URL), supportEmail }
}

/** How email leaves this install. Printing it to the log is for development and must be asked for. */
export function emailDelivery(env: Env): 'smtp' | 'log' | 'none' {
  if (env.SMTP_URL) return 'smtp'
  return env.EMAIL_TO_LOG === 'true' ? 'log' : 'none'
}

export const authConfig = readAuthConfig(process.env)
export const authMethods = authConfig.methods
