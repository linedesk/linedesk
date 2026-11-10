import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { genericOAuth, magicLink, organization } from 'better-auth/plugins'
import { authConfig } from './auth-methods.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { createRateLimiter } from './rate-limit.ts'
import { instanceAdminHooks } from './instance-admin.ts'
import { maySendSignInLink } from './signup-gate.ts'

const { google, microsoft, oidc, trustedProviders, methods } = authConfig

/** Where the web app is served from; the only origin browser requests are accepted from. */
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'

/** A member can create this many workspaces. */
export const WORKSPACE_LIMIT = 5

// Link requests per address, on top of Better Auth's limit per IP: 5 in 10 minutes (a link's lifetime).
const allowLinkFor = createRateLimiter({ max: 5, windowMs: 10 * 60_000 })

/**
 * Addresses that user.invite just created an account for: their next link gets the welcome text.
 * Decided on the server; nothing the client sends can choose it.
 */
const welcomeNext = new Set<string>()
export const expectWelcome = (email: string) => welcomeNext.add(email.toLowerCase())

function signInEmail(email: string, url: string) {
  if (welcomeNext.delete(email.toLowerCase())) {
    return {
      subject: 'Your Linedesk account',
      text: `An account on Linedesk was created for you. Open this link to sign in:\n\n${url}\n\nThe link works once and expires in 10 minutes. After that, ask for a new link on the sign-in page with this email address.`,
    }
  }
  return {
    subject: 'Your Linedesk sign-in link',
    text: `Open this link to sign in to Linedesk:\n\n${url}\n\nThe link works once and expires in 10 minutes. If you did not ask for it, you can ignore this email.`,
  }
}

async function sendMagicLink({ email, url }: { email: string; url: string }) {
  if (!allowLinkFor(email.toLowerCase())) throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many sign-in links for this email. Try again in a few minutes.' })
  // Closed sign-up: no mail to an address that has no account. The screen says the same either way.
  if (!(await maySendSignInLink(db, email))) return
  const message = { to: email, ...signInEmail(email, url) }
  // An invite waits for the email, so the admin hears when it fails. A sign-in from the screen does
  // not: waiting for SMTP only for real accounts would tell anyone which addresses have one.
  if (message.subject === 'Your Linedesk account') {
    await emailSender.send(message).catch(err => {
      console.error('welcome email failed', err)
      throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not send the email.' })
    })
    return
  }
  void emailSender.send(message).catch(err => console.error('sign-in email failed', err))
}

// Workspace = Better Auth organization. Sign-in methods: see auth-methods.ts.
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: [WEB_ORIGIN],
  emailAndPassword: { enabled: methods.password },
  databaseHooks: instanceAdminHooks,
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
