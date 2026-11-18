// Billing for Linedesk Cloud (docs/billing.md §7): which billing provider is in effect. `none` (every self-hosted
// install) unless Server admin › Billing › Stripe has Stripe with both keys **and** an instance admin turned billing
// on (`billing.enabled`, off by default). A live key counts only where the server allows it (BILLING_LIVE_KEYS=1,
// production only): elsewhere it is refused when stored, by the provider test, and here.
//
// The keys decide where money goes, so (security review of #850): only an instance admin signed in as themselves and
// confirmed with their passkey changes them (never a setup link, an API key or an impersonation); they never come
// from `.env`; they cannot be swapped while billing is on; removing them turns billing off; and turning billing on
// binds it to that Stripe account and mode, so keys of another account need an explicit rebind. Every instance admin
// is emailed when the keys change and when billing is turned on or off. Billing is not in effect while the ledger's
// database guards are missing or changed (ledger-guards.ts, checked at start and again before billing work).
import type { BillingEnabledData } from '@linedesk/actions'
import {
  type BillingProvider,
  LIVE_KEYS_REFUSED,
  liveKeysAllowed,
  loadBillingProvider,
  type StripeKeys,
  stripeKeyMode,
} from '@linedesk/billing'
import { instance_settings, provider_settings, type Tx, user } from '@linedesk/db'
import { and, eq, isNull } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { syncCatalogAfterCommit } from './billing-catalog.ts'
import { mayReceiveEnrolmentCode } from './admin-step-up.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { billingSwitchAlert } from './emails/alerts.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { serverEnv } from './instance-env.ts'
import { ledgerGuardsOk } from './ledger-guards.ts'
import { resolveProvider } from './provider-settings.ts'

/** The instance setting that turns billing on ('on'; anything else or no row: off). */
export const BILLING_ENABLED_KEY = 'billing.enabled'
/** The Stripe account and mode billing was turned on with (JSON `{ id, mode }`). */
export const BILLING_ACCOUNT_KEY = 'billing.stripeAccount'

type Env = Record<string, string | undefined>
type Binding = { id: string; mode: 'test' | 'live' }

/** How billing reaches Stripe; tests swap it for a fake. */
let stripeFetch: typeof fetch = (...args) => fetch(...args)
export function setBillingFetch(doFetch: typeof fetch | null) {
  stripeFetch = doFetch ?? ((...args) => fetch(...args))
}

export async function billingSwitchOn(tx: Tx): Promise<boolean> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, BILLING_ENABLED_KEY))
  return row?.value === 'on'
}

/**
 * How long the previous webhook signing secret is accepted after it was stored (docs/billing.md §5.1): Stripe's
 * longest overlap when a secret is rolled. After that it is ignored, so a rotation ends without a second step.
 */
export const WEBHOOK_ROTATION_DAYS = 7

/** The previous signing secret while its overlap lasts, else null. */
async function previousWebhookSecret(tx: Tx, value: string | undefined, now = new Date()) {
  if (!value) return null
  const [row] = await tx
    .select({ updated_at: provider_settings.updated_at })
    .from(provider_settings)
    .where(
      and(
        isNull(provider_settings.workspace_id),
        eq(provider_settings.provider, 'stripe'),
        eq(provider_settings.field, 'webhook_secret_previous'),
      ),
    )
  const storedAt = row ? new Date(row.updated_at).getTime() : 0
  return now.getTime() - storedAt < WEBHOOK_ROTATION_DAYS * 86_400_000 ? value : null
}

/** The Stripe keys in effect, or null while one is missing. Stored keys only: `.env` is never read for them. */
async function stripeKeys(tx: Tx): Promise<StripeKeys | null> {
  const config = await resolveProvider(tx, 'stripe')
  const secretKey = config.secret_key?.value
  const webhookSecret = config.webhook_secret?.value
  if (!secretKey || !webhookSecret) return null
  return {
    secretKey,
    webhookSecret,
    webhookSecretPrevious: await previousWebhookSecret(tx, config.webhook_secret_previous?.value),
  }
}

/** What Server admin › Billing › Stripe shows next to the switch. */
export async function billingState(tx: Tx, env: Env = serverEnv()): Promise<BillingEnabledData> {
  const keys = await stripeKeys(tx)
  const mode = keys ? stripeKeyMode(keys.secretKey) : null
  const liveAllowed = liveKeysAllowed(env)
  const on = await billingSwitchOn(tx)
  const usable = !!keys && !!mode && (mode === 'test' || liveAllowed)
  const guardsOk = await ledgerGuardsOk(tx)
  return { on, inEffect: on && usable && guardsOk ? 'stripe' : 'none', connected: !!keys, mode, liveAllowed, guardsOk }
}

/**
 * The billing provider in effect: `none` unless billing is on with usable Stripe keys. The Stripe SDK is loaded only
 * then (@linedesk/billing imports it lazily).
 */
export async function billingProvider(
  tx: Tx,
  env: Env = serverEnv(),
  doFetch: typeof fetch = stripeFetch,
): Promise<BillingProvider> {
  const state = await billingState(tx, env)
  if (state.inEffect === 'none') return loadBillingProvider(null)
  return loadBillingProvider(await stripeKeys(tx), doFetch)
}

/** How long the webhook route reuses the provider it built (security review of #865, L3). */
export const WEBHOOK_PROVIDER_TTL_MS = 30_000
let webhookCache: { provider: Promise<BillingProvider>; at: number } | null = null

/**
 * The provider for the Stripe webhook route: built once and reused for WEBHOOK_PROVIDER_TTL_MS, so an unauthenticated
 * request costs no key decryption or query. Forgotten when the keys or the switch change here; another API process
 * picks a change up within the TTL (a delivery refused meanwhile is retried by Stripe).
 */
export function webhookBillingProvider(now = Date.now()): Promise<BillingProvider> {
  if (!webhookCache || now - webhookCache.at >= WEBHOOK_PROVIDER_TTL_MS) {
    const provider = billingProvider(db)
    webhookCache = { provider, at: now }
    // A failed build is not kept.
    provider.catch(() => {
      if (webhookCache?.provider === provider) webhookCache = null
    })
  }
  return webhookCache.provider
}

/** Forgets the webhook route's provider (a key or switch change, after commit; tests). */
export function forgetWebhookBillingProvider() {
  webhookCache = null
}

/** A live Stripe key where the server does not allow one: refused before it is stored (provider.setKeys). */
export function refusedStripeKey(secretKey: string | undefined, env: Env = serverEnv()): string | null {
  if (secretKey === undefined) return null
  return stripeKeyMode(secretKey) === 'live' && !liveKeysAllowed(env) ? LIVE_KEYS_REFUSED : null
}

/**
 * Money is changed only by an instance admin signed in as themselves who confirmed with their passkey: never through
 * an AI agent's setup link, an API key, a personal key or an impersonation (like enrolment codes). A personal key made
 * after the passkey check carries that check until it is revoked, so it is refused by name. One check for the billing
 * keys and the Server admin › Billing writes, so the two never drift apart again (security review of #919, H1).
 */
function refuseUnlessSignedInWithPasskey(actor: Actor, what: string) {
  if (actor.setupKeyId || actor.apiKeyId || actor.personalKeyId || actor.impersonation)
    throw new Forbidden(`only an instance admin signed in as themselves can change ${what}`)
  if (!mayReceiveEnrolmentCode(actor)) throw new Forbidden(`confirm with your passkey to change ${what}`)
}

/** The billing keys are set, removed or picked only by an instance admin as themselves, with their passkey. */
export const refuseMoneyKeysChange = (actor: Actor) => refuseUnlessSignedInWithPasskey(actor, 'the billing keys')

/** Every Server admin › Billing write (billing-admin.ts) and reprocessing a Stripe event: the same rule. */
export const refuseMoneyChange = (actor: Actor) => refuseUnlessSignedInWithPasskey(actor, 'billing')

/**
 * Locks the switch's row (made first if missing) until the transaction ends: a key change and the switch never run
 * side by side, so billing cannot end up on with keys it was not turned on with.
 */
async function lockBillingSwitch(tx: Tx, actor: Actor, now: string) {
  await tx
    .insert(instance_settings)
    .values({ key: BILLING_ENABLED_KEY, value: 'off', updated_at: now, updated_by: actor.actorId })
    .onConflictDoNothing()
  await tx.select().from(instance_settings).where(eq(instance_settings.key, BILLING_ENABLED_KEY)).for('update')
}

/** The fields that may change while billing is on: the webhook signing secrets (a rotation moves no customer). */
const ROTATABLE_WHILE_ON = ['webhook_secret', 'webhook_secret_previous']

/**
 * A new secret key while billing is on would move every customer to another account: turn billing off first. The
 * webhook signing secrets alone may be rotated while on (they move no customer; the change is emailed like any key
 * change): the new one as `webhook_secret`, the old one as `webhook_secret_previous` for the overlap.
 */
export async function refuseStripeKeysWhileOn(tx: Tx, values: Record<string, string>, actor: Actor, now: string) {
  await lockBillingSwitch(tx, actor, now)
  const onlyWebhookSecret = Object.keys(values).every(field => ROTATABLE_WHILE_ON.includes(field))
  if (!onlyWebhookSecret && (await billingSwitchOn(tx)))
    throw new Reject('Turn billing off before changing the Stripe secret key.')
}

/** Removing the Stripe keys turns billing off with them, so adding keys later does not switch it on unasked. */
export async function billingOffWithKeys(tx: Tx, actor: Actor, now: string) {
  await lockBillingSwitch(tx, actor, now)
  if (!(await billingSwitchOn(tx))) return false
  await writeSetting(tx, BILLING_ENABLED_KEY, 'off', actor, now)
  return true
}

async function writeSetting(tx: Tx, key: string, value: string, actor: Actor, now: string) {
  await tx
    .insert(instance_settings)
    .values({ key, value, updated_at: now, updated_by: actor.actorId })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actor.actorId } })
}

export async function boundAccount(tx: Pick<Tx, 'select'>): Promise<Binding | null> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, BILLING_ACCOUNT_KEY))
  try {
    return row ? (JSON.parse(row.value) as Binding) : null
  } catch {
    return null
  }
}

/** The Stripe account the stored keys belong to (one request to Stripe). */
async function connectedAccount(tx: Tx): Promise<Binding> {
  const keys = await stripeKeys(tx)
  const mode = keys && stripeKeyMode(keys.secretKey)
  if (!keys || !mode) throw new Reject('Connect Stripe first: both keys under Billing › Stripe.')
  let id: string | undefined
  try {
    id = (await (await loadBillingProvider(keys, stripeFetch)).account())?.id
  } catch {
    throw new Reject('Stripe did not confirm the account. Test the keys under Billing › Stripe, then try again.')
  }
  if (!id) throw new Reject('Stripe did not confirm the account. Test the keys under Billing › Stripe, then try again.')
  return { id, mode }
}

/** Every instance admin hears that billing was turned on or off, once it committed. */
function alertSwitch(
  onCommit: ((work: () => Promise<void>) => void) | undefined,
  actor: Actor,
  on: boolean,
  binding: Binding | null,
) {
  const apply = async () => {
    const [who] =
      actor.actorId === 'cli' ? [] : await db.select({ email: user.email }).from(user).where(eq(user.id, actor.actorId))
    await alertInstanceAdmins(
      billingSwitchAlert({
        on,
        actor: actor.actorId === 'cli' ? { operator: true } : { email: who?.email ?? null },
        account: binding?.id ?? null,
        mode: binding?.mode ?? null,
      }),
    )
  }
  if (onCommit) onCommit(apply)
  else void apply().catch(e => console.error('billing switch alert:', e))
}

export const billingSettingsHandlers: Record<string, Handler> = {
  'billingEnabled.get': async ({ tx }) => ({ rows: {}, data: await billingState(tx) }),

  'billingEnabled.set': async ({ tx, actor, now, onCommit }, input: { on: boolean; rebind?: boolean }) => {
    // Turning on (and rebinding) decides which Stripe account takes the money: the same check as a key change. Off
    // stays open to every instance admin, so billing can always be stopped.
    if (input.on || input.rebind) refuseMoneyKeysChange(actor)
    await lockBillingSwitch(tx, actor, now)
    const state = await billingState(tx)
    let binding: Binding | null = null
    if (input.on) {
      if (!state.connected) throw new Reject('Connect Stripe first: both keys under Billing › Stripe.')
      if (state.mode === 'live' && !state.liveAllowed) throw new Reject(LIVE_KEYS_REFUSED)
      binding = await connectedAccount(tx)
      const bound = await boundAccount(tx)
      if (bound && (bound.id !== binding.id || bound.mode !== binding.mode) && !input.rebind)
        throw new Reject(
          `These keys belong to another Stripe account or mode (${binding.id}, ${binding.mode}) than billing was turned on with (${bound.id}, ${bound.mode}). Its customers and subscriptions are not there. Turn it on with rebind only if that is intended.`,
        )
      await writeSetting(tx, BILLING_ACCOUNT_KEY, JSON.stringify(binding), actor, now)
    }
    await writeSetting(tx, BILLING_ENABLED_KEY, input.on ? 'on' : 'off', actor, now)
    onCommit?.(async () => forgetWebhookBillingProvider())
    if (input.on !== state.on) alertSwitch(onCommit, actor, input.on, binding)
    // The products and plan prices in this account, before the first Checkout needs them (review of #1040, M-1).
    if (input.on) syncCatalogAfterCommit(onCommit)
    return { rows: {}, data: await billingState(tx) }
  },
}
