import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins'
import { db } from './db.ts'

// Workspace = Better Auth organization. Email + password for now; magic link and SSO come later.
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: [process.env.WEB_ORIGIN ?? 'http://localhost:5173'],
  emailAndPassword: { enabled: true },
  plugins: [organization()],
})
