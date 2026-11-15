// Billing for Linedesk Cloud (docs/billing.md §7): which billing provider is in effect. `none` (every self-hosted
// install) unless Server admin › Providers › Billing has Stripe with both keys **and** an instance admin turned billing
// on (`billing.enabled`, off by default). A live key counts only where the server allows it (BILLING_LIVE_KEYS=1,
// production only): elsewhere it is refused when stored, by the provider test, and here.
//
// The keys decide where money goes, so (security review of #850): only an instance admin signed in as themselves and
// confirmed with their passkey changes them (never a setup link, an API key or an impersonation); they never come
// from `.env`; they cannot be swapped while billing is on; removing them turns billing off; and turning billing on
// binds it to that Stripe account and mode, so keys of another account need an explicit rebind. Every instance admin
// is emailed when the keys change and when billing is turned on or off.
import type { BillingEnabledData } from '@linedesk/actions'
import {
  type BillingProvider,
  LIVE_KEYS_REFUSED,
  liveKeysAllowed,
  loadBillingProvider,
  stripeKeyMode,
} from '@linedesk/billing'
import { instance_settings, type Tx, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { mayReceiveEnrolmentCode } from './admin-step-up.ts'
import { db } from './db.ts'
import { billingSwitchAlert } from './emails/alerts.ts'
import type { Actor } from './context.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { serverEnv } from './instance-env.ts'
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

/** The Stripe keys in effect, or null while one is missing. Stored keys only: `.env` is never read for them. */
async function stripeKeys(tx: Tx) {
  const config = await resolveProvider(tx, 'stripe')
  const secretKey = config.secret_key?.value
  const webhookSecret = config.webhook_secret?.value
  return secretKey && webhookSecret ? { secretKey, webhookSecret } : null
}

/** What Server admin › Providers › Billing shows next to the switch. */
export async function billingState(tx: Tx, env: Env = serverEnv()): Promise<BillingEnabledData> {
  const keys = await stripeKeys(tx)
  const mode = keys ? stripeKeyMode(keys.secretKey) : null
  const liveAllowed = liveKeysAllowed(env)
  const on = await billingSwitchOn(tx)
  const usable = !!keys && !!mode && (mode === 'test' || liveAllowed)
  return { on, inEffect: on && usable ? 'stripe' : 'none', connected: !!keys, mode, liveAllowed }
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

/** A live Stripe key where the server does not allow one: refused before it is stored (provider.setKeys). */
export function refusedStripeKey(secretKey: string | undefined, env: Env = serverEnv()): string | null {
  if (secretKey === undefined) return null
  return stripeKeyMode(secretKey) === 'live' && !liveKeysAllowed(env) ? LIVE_KEYS_REFUSED : null
}

/**
 * The billing keys are set, removed or picked only by an instance admin signed in as themselves who confirmed with
 * their passkey: never through an AI agent's setup link, an API key or an impersonation (like enrolment codes).
 */
export function refuseMoneyKeysChange(actor: Actor) {
  if (actor.setupKeyId || actor.apiKeyId || actor.impersonation)
    throw new Forbidden('only an instance admin signed in as themselves can change the billing keys')
  if (!mayReceiveEnrolmentCode(actor)) throw new Forbidden('confirm with your passkey to change the billing keys')
}

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

/**
 * A new secret key while billing is on would move every customer to another account: turn billing off first. The
 * webhook secret alone may be rotated while on (it moves no customer; the change is emailed like any key change).
 */
export async function refuseStripeKeysWhileOn(tx: Tx, values: Record<string, string>, actor: Actor, now: string) {
  await lockBillingSwitch(tx, actor, now)
  const onlyWebhookSecret = Object.keys(values).every(field => field === 'webhook_secret')
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

async function boundAccount(tx: Tx): Promise<Binding | null> {
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
  if (!keys || !mode) throw new Reject('Connect Stripe first: both keys under Providers › Billing.')
  let id: string | undefined
  try {
    id = (await (await loadBillingProvider(keys, stripeFetch)).account())?.id
  } catch {
    throw new Reject('Stripe did not confirm the account. Test the keys under Providers › Billing, then try again.')
  }
  if (!id)
    throw new Reject('Stripe did not confirm the account. Test the keys under Providers › Billing, then try again.')
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
      if (!state.connected) throw new Reject('Connect Stripe first: both keys under Providers › Billing.')
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
    if (input.on !== state.on) alertSwitch(onCommit, actor, input.on, binding)
    return { rows: {}, data: await billingState(tx) }
  },
}
