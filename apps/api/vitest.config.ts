import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { categoryEnv, providerNames, providers } from '@linedesk/actions'
import { configDefaults, defineConfig } from 'vitest/config'
import { isReachable, runDatabaseUrl, testDatabaseBaseUrl } from './test/test-database.ts'

const envFile = new URL('../../.env', import.meta.url)
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}

/** Where this run's databases go. Without Postgres: null on a developer machine, an error in CI. */
async function testDatabaseBase(): Promise<string | null> {
  const base = testDatabaseBaseUrl({ ...fileEnv, ...process.env })
  if (base && (await isReachable(base))) return base
  const problem = base ? `no Postgres at ${new URL(base).host}` : 'DATABASE_URL is not set'
  if (process.env.CI) throw new Error(`The API tests need Postgres: ${problem}`)
  console.warn(`\nSkipping the API integration tests: ${problem} (run \`pnpm db:up\`, and \`cp .env.example .env\`).\n`)
  return null
}

/**
 * Files that change what is global to an install (provider keys, instance settings, instance admins, stored provider
 * test results) or count across workspaces (the admin overview). Each gets a database of its own, so tests in other
 * files, which run at the same time, never see their keys or their counts move under them, and none clears another's.
 */
const INSTANCE_WIDE_FILES = [
  'test/admin.test.ts',
  'test/billing-schema.test.ts',
  'test/after-call-transcript.test.ts',
  // Stripe keys and the billing switch (provider_settings, instance_settings).
  'test/billing-settings.test.ts',
  // The once-a-day setup alert of the recharge job (instance_settings).
  'test/billing-recharge.test.ts',
  // Stripe keys and the billing switch, the Checkout setup alert to the instance admins.
  'test/billing-checkout.test.ts',
  // The billing switch and the renewal reminder setting (instance_settings).
  'test/billing-periods.test.ts',
  // The billing switch (dunning, bill ownership, port-out).
  'test/billing-lifecycle.test.ts',
  'test/authenticator.test.ts',
  'test/admin-subjects.test.ts',
  'test/workspace-delete-own.test.ts',
  'test/setup-checklist.test.ts',
  'test/provider-failures.test.ts',
  // A refused Slack client secret is recorded as the Slack provider failing (provider_failures).
  'test/app-slack.test.ts',
  // A refused Jobber client secret is recorded as the Jobber provider failing (provider_failures).
  'test/app-jobber.test.ts',
  // Stores the Jobber client secret that signs the webhook (provider_settings).
  'test/app-jobber-webhook.test.ts',
  'test/setup-mcp.test.ts',
  'test/setup-mcp-workspace.test.ts',
  // Makes a server admin, who creates the white-label partners (partner setup links).
  'test/setup-mcp-partner.test.ts',
  'test/workspace-limit-retired.test.ts',
  // Makes server admins and switches the passkey check (personal keys carry Server admin).
  'test/personal-keys.test.ts',
  // Makes a server admin (an OAuth key never has Server admin).
  'test/mcp-oauth.test.ts',
  // Makes a server admin (Server admin › Users shows the terms accepted last).
  'test/terms-update.test.ts',
  // Every action and key read route for each role, a server admin among them (LIN-339).
  'test/every-action.test.ts',
  // Makes an instance admin, switches billing on and sets the protected names (instance_settings).
  'test/partner-brand.test.ts',
  'test/workspace-create-cli.test.ts',
  'test/install-setup.test.ts',
  'test/provider-health-check.test.ts',
  'test/first-admin.test.ts',
  'test/team-member-edit.test.ts',
  'test/admin-passkey-recovery.test.ts',
  'test/outbound.test.ts',
  // Switches calendar tools on and off for the install (instance_settings).
  'test/calendar-connections.test.ts',
  'test/calendar-tools.test.ts',
  // Counts public demo tokens and live demo calls across the install (demo-call.ts).
  'test/demo-call.test.ts',
  // Makes a server admin.
  'test/demo-workspace.test.ts',
  // Stripe keys and the billing switch; counts and prunes the install's Stripe events (stripe-webhook.ts).
  'test/stripe-webhook.test.ts',
  // Sets up the three stages through the environment; switches billing on (usage levels).
  'test/usage-levels.test.ts',
  // Sets up the three stages through the environment; switches billing on (the call gate, PR 4).
  'test/call-billing.test.ts',
  // Server admin › Billing: instance admins, the billing rules and self-serve settings, Stripe keys (PR 13).
  'test/billing-admin.test.ts',
  // The billing switch (Settings › Billing, PR 9).
  'test/billing-page.test.ts',
  // Opens self-serve sign-up and sets its rules and the Turnstile keys (instance_settings, provider_settings).
  'test/self-serve.test.ts',
  // Re-encrypts every stored secret of the install (rolled back, but it reads them all).
  'test/rotate-secrets-key.test.ts',
  // Makes server admins and switches billing on (white-label partners, LIN-452).
  'test/partners.test.ts',
  // The daily purges look at every workspace: deleted calls and canceled bills of other files must not be there.
  'test/data-purge.test.ts',
  // Writes white-label partner addresses: from the first one on, every request's host is checked (request-host.ts).
  'test/request-host.test.ts',
  // Sessions bound to partner addresses (host-sessions.ts): writes partner addresses too.
  'test/host-sessions.test.ts',
  // Makes a server admin, rotates every stored secret (rolled back) and reads white-label partner keys (S7).
  'test/partner-keys.test.ts',
  // Makes a server admin and sets SENDER_DOMAINS and EMAIL_FROM in process.env (S6).
  'test/partner-sender.test.ts',
]

// The API tests run against a real Postgres, in databases of their own (never the dev database): one
// per instance-wide file, one for everything else. global-setup.ts creates and drops each.
export default defineConfig(async () => {
  const base = await testDatabaseBase()
  const withDatabase = (name: string, files: { include?: string[]; exclude?: string[] }) => ({
    extends: true as const,
    test: { name, ...files, env: { DATABASE_URL: base ? runDatabaseUrl(base) : '' } },
  })
  return {
    test: {
      // On a developer machine Postgres shares a small Docker VM (2 CPUs by default in Colima): more files at once
      // only queue up there and time out, and the run takes as long. CI's Postgres has room for the default.
      maxWorkers: process.env.CI ? undefined : 2,
      // The tests that start many calls at once can still pass 5 s there while other packages' tests run beside them.
      testTimeout: process.env.CI ? undefined : 15_000,
      globalSetup: './test/global-setup.ts',
      projects: base
        ? [
            withDatabase('api', { exclude: [...configDefaults.exclude, ...INSTANCE_WIDE_FILES] }),
            ...INSTANCE_WIDE_FILES.map(file =>
              withDatabase(`instance:${file.replace(/^test\/|\.test\.ts$/g, '')}`, { include: [file] }),
            ),
          ]
        : [{ extends: true as const, test: { name: 'api', exclude: [...configDefaults.exclude, 'test/**'] } }],
      env: {
        BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret',
        BETTER_AUTH_URL: 'http://localhost:5173',
        WEB_ORIGIN: 'http://localhost:5173',
        AGENT_API_TOKEN: 'test-agent-token-test-agent-token-0000',
        ELECTRIC_URL: 'http://electric.test',
        ELECTRIC_SECRET: 'test-electric-secret',
        // Tests must never reach a carrier, whatever .env selects.
        TELEPHONY_PROVIDER: 'dev',
        // Email sign-in by code is on, as on a real server; tests read the codes from a spy on the sender.
        EMAIL_TO_LOG: 'true',
        SMTP_URL: '',
        // A fresh key per run: provider keys are only ever stored in the run's own database.
        SECRETS_KEY: randomBytes(32).toString('base64'),
        // No admins or provider keys from the developer's .env.
        INSTANCE_ADMIN_EMAILS: '',
        // Admin tests sign in with passwords; the passkey rule for admins has its own tests that turn it on.
        ADMIN_SECOND_FACTOR: 'off',
        // Webhook tests turn private addresses on for their local receiver themselves.
        WEBHOOK_ALLOW_PRIVATE_URLS: 'false',
        // The registry's variables (packages/actions/src/admin.ts) and LiveKit's.
        ...Object.fromEntries(
          [
            ...providerNames.flatMap(name => Object.values(providers[name].fields).map(field => field.env)),
            ...Object.values(categoryEnv),
            ...['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'],
          ].map(name => [name, '']),
        ),
      },
    },
  }
})
