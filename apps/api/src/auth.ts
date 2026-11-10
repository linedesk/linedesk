import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { genericOAuth, magicLink, organization } from 'better-auth/plugins'
import { authConfig } from './auth-methods.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { createRateLimiter } from './rate-limit.ts'

const { google, microsoft, oidc, trustedProviders, methods } = authConfig

/** Where the web app is served from; the only origin browser requests are accepted from. */
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'

/** A member can create this many workspaces. */
export const WORKSPACE_LIMIT = 5

// Link requests per address, on top of Better Auth's limit per IP: 5 in 10 minutes (a link's lifetime).
const allowLinkFor = createRateLimiter({ max: 5, windowMs: 10 * 60_000 })

async function sendMagicLink({ email, url }: { email: string; url: string }) {
  if (!allowLinkFor(email.toLowerCase())) throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many sign-in links for this email. Try again in a few minutes.' })
  const text = `Open this link to sign in to Linedesk:\n\n${url}\n\nThe link works once and expires in 10 minutes. If you did not ask for it, you can ignore this email.`
  try {
    await emailSender.send({ to: email, subject: 'Your Linedesk sign-in link', text })
  } catch (err) {
    console.error('sign-in email failed', err)
    throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not send the email. Try again in a moment.' })
  }
}

// Workspace = Better Auth organization. Sign-in methods: see auth-methods.ts.
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: [WEB_ORIGIN],
  emailAndPassword: { enabled: methods.password },
  socialProviders: {
    ...(google && { google }),
    ...(microsoft && { microsoft }),
  },
  // One person, one account: a provider sign-in joins the account with the same email. Which
  // providers are trusted for that without an email-verified claim: see auth-methods.ts.
  account: { accountLinking: { enabled: true, trustedProviders } },
  // On in every environment, not only when NODE_ENV says production.
  rateLimit: { enabled: true },
  plugins: [
    organization({ organizationLimit: WORKSPACE_LIMIT }),
    ...(methods.magicLink ? [magicLink({ sendMagicLink, expiresIn: 600, storeToken: 'hashed' })] : []),
    ...(oidc ? [genericOAuth({ config: [{ providerId: 'oidc', clientId: oidc.clientId, clientSecret: oidc.clientSecret, discoveryUrl: oidc.discoveryUrl, scopes: ['openid', 'profile', 'email'], pkce: true }] })] : []),
  ],
})
