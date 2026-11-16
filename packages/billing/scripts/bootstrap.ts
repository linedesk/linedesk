/**
 * `pnpm --filter @linedesk/billing bootstrap --sandbox --webhook-url <url>` (docs/billing.md §9, runbook "Stripe
 * account setup"): creates or updates the Stripe objects billing expects (products, plan prices, tax default, portal,
 * "Linedesk Checkout", webhook endpoint). Idempotent; `--dry-run` only lists the changes.
 *
 * - The key comes from the environment (`STRIPE_SECRET_KEY`), never from an argument (every user of the machine can
 *   read process arguments). It is a key that may write products, prices, the portal and webhook endpoints, not the
 *   install's restricted key.
 * - `--sandbox` needs a test key; a live key needs `--live --i-know`.
 * - The ids go to `--out` (default `stripe-ids.<mode>.json` in packages/billing, git-ignored). The webhook signing
 *   secret, shown by Stripe once when the endpoint is created, goes to `--secret-out` (default
 *   `stripe-webhook-secret.<mode>.txt` in packages/billing, git-ignored), created new with mode 0600 (an existing file
 *   or a symlink there is refused) and never printed: paste it into Server admin › Providers › Billing, then delete it.
 * - A price whose amount changed is replaced only with `--replace-prices`. A webhook endpoint in an old API version
 *   is replaced with `--recreate-webhook` (the new one is made beside it) and deleted later with
 *   `--delete-old-webhooks`.
 */
import { closeSync, lstatSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { PLAN_PRICES, PLAN_PRODUCTS, STRIPE_TAX_CODE } from '@linedesk/db/types'
import { BootstrapRefused, bootstrapStripe } from '../src/stripe/bootstrap.ts'

const { values } = parseArgs({
  options: {
    sandbox: { type: 'boolean' },
    live: { type: 'boolean' },
    'i-know': { type: 'boolean' },
    'webhook-url': { type: 'string' },
    'site-url': { type: 'string', default: 'https://linedesk.ai' },
    'terms-url': { type: 'string' },
    'privacy-url': { type: 'string' },
    'return-url': { type: 'string' },
    'recreate-webhook': { type: 'boolean' },
    'delete-old-webhooks': { type: 'boolean' },
    'replace-prices': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    out: { type: 'string' },
    'secret-out': { type: 'string' },
  },
})

function fail(message: string): never {
  console.error(`bootstrap: ${message}`)
  process.exit(1)
}

if (values.sandbox === values.live) fail('give exactly one of --sandbox and --live')
const mode = values.live ? 'live' : 'test'
const key = process.env.STRIPE_SECRET_KEY?.trim()
if (!key) fail('set STRIPE_SECRET_KEY in the environment (never as an argument)')
const webhookUrl = values['webhook-url']
if (!webhookUrl || !/^https:\/\/[^/]+\/v1\/billing\/stripe\/webhook$/.test(webhookUrl))
  fail('--webhook-url https://<host>/v1/billing/stripe/webhook is required')
const site = values['site-url']!.replace(/\/$/, '')

/** The package folder: default output files land here, where .gitignore covers them, wherever the script runs from. */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const outPath = (given: string | undefined, fallback: string) =>
  given ? (isAbsolute(given) ? given : resolve(given)) : resolve(PACKAGE_DIR, fallback)

/** A symlink at an output path is refused: the write would follow it somewhere else (review of #866, L1). */
function refuseSymlink(path: string) {
  try {
    if (lstatSync(path).isSymbolicLink()) fail(`${path} is a symlink; remove it first`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** The signing secret: a new file, 0600 from its creation; never an existing file or a symlink (`wx`). */
function writeSecret(path: string, secret: string) {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      fail(`${path} exists (an earlier secret?): store or delete it, then run again`)
    throw error
  }
  try {
    writeSync(fd, `${secret}\n`)
  } finally {
    closeSync(fd)
  }
}

// Checked before Stripe is asked: the secret is shown once, so it must have somewhere to go.
const secretPath = outPath(values['secret-out'], `stripe-webhook-secret.${mode}.txt`)
try {
  lstatSync(secretPath)
  fail(`${secretPath} exists (an earlier secret?): store or delete it, then run again`)
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

try {
  const result = await bootstrapStripe(
    key,
    { products: PLAN_PRODUCTS, prices: PLAN_PRICES, taxCode: STRIPE_TAX_CODE },
    {
      mode,
      allowLive: !!values.live && !!values['i-know'],
      webhookUrl,
      termsUrl: values['terms-url'] ?? `${site}/terms`,
      privacyUrl: values['privacy-url'] ?? `${site}/privacy`,
      returnUrl: values['return-url'],
      recreateWebhook: !!values['recreate-webhook'],
      deleteOldWebhooks: !!values['delete-old-webhooks'],
      replacePrices: !!values['replace-prices'],
      dryRun: !!values['dry-run'],
    },
  )
  const { webhookSecret, changes, ...ids } = result
  console.log(`Stripe account ${ids.account} (${ids.mode})${values['dry-run'] ? ', dry run' : ''}`)
  console.log(changes.length ? changes.map(c => `  ${c}`).join('\n') : '  nothing to change')
  if (!values['dry-run']) {
    const out = outPath(values.out, `stripe-ids.${mode}.json`)
    refuseSymlink(out)
    writeFileSync(out, `${JSON.stringify(ids, null, 2)}\n`)
    console.log(`ids written to ${out}`)
  }
  if (webhookSecret) {
    const secretOut = secretPath
    writeSecret(secretOut, webhookSecret)
    console.log(
      ids.oldWebhookEndpoints.length
        ? `the new webhook signing secret is in ${secretOut} (0600): in Server admin › Providers › Billing, put the current secret into "Previous webhook signing secret" and this one into "Webhook signing secret", then delete the file. Once the new endpoint receives, run again with --delete-old-webhooks.`
        : `the new webhook signing secret is in ${secretOut} (0600): paste it into Server admin › Providers › Billing, then delete the file`,
    )
  } else if (ids.oldWebhookEndpoints.length)
    console.log(
      `old webhook endpoints still at the URL: ${ids.oldWebhookEndpoints.join(', ')} (delete them with --delete-old-webhooks once the pinned one receives)`,
    )
} catch (error) {
  if (error instanceof BootstrapRefused) fail(error.message)
  // Stripe's message, never the request (it carries the key in a header the SDK does not print).
  fail(error instanceof Error ? error.message : String(error))
}
