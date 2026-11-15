// Where this install calls out to, and how much (packages/actions/src/outbound.ts has the rules). The countries depend
// on the route a call goes out through: a number in the install's carrier account calls on
// the operator's bill (the forwarding check too, held to installDestinations, the install's ceiling), so the countries of the workspace's install-account numbers plus the install's list (Server
// admin or OUTBOUND_COUNTRIES); a number in the workspace's own carrier account calls its own numbers' countries only.
// Plus the daily minutes (per workspace, and install-wide on the install's account), the caller ID of a transfer, and
// keeping the carriers' own destination lists in step (Telnyx voice profiles; Twilio's Geo permissions are only read
// and reported). docs/architecture.md, "Outbound destination policy".
import {
  allowedOutboundCountries,
  countriesOfNumbers,
  countryList,
  HIGH_RISK_COUNTRIES,
  isHighRiskCountry,
  type OutboundCountries,
  type OutboundCountriesData,
  type OutboundCountriesView,
  type OutboundRoute,
  type OutboundUse,
  OUTBOUND_MINUTES_INSTALL_DAY,
  OUTBOUND_MINUTES_PER_WORKSPACE_DAY,
  outboundNumberProblem,
  parseCountryList,
  routeCountries,
  TRANSFER_MAX_MINUTES,
  TRANSFER_MIN_MINUTES,
} from '@linedesk/actions'
import { calls, forwarding_checks, instance_settings, phone_numbers, type Tx } from '@linedesk/db'
import {
  installCarrierName,
  setTelnyxDestinations,
  TRANSFER_OUTBOUND_NAME,
  twilioBlockedCountries,
} from '@linedesk/telephony'
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import { db } from './db.ts'
import { CHECK_TRUNK_NAME } from './forwarding-check.ts'
import { type Handler, Reject } from './handler-context.ts'
import { installTelephony } from './provider-settings.ts'
import { CARRIER_TIMEOUT_MS } from './workspace-carrier.ts'

type Env = Record<string, string | undefined>
const KEY = 'outbound.countries'
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A minute limit from the env: unset or empty is the default; 0 turns transfers off; anything that is not a whole
 * number of minutes turns them off too (and says so), never quietly the default.
 */
function minutes(env: Env, name: string, fallback: number): number {
  const value = env[name]?.trim()
  if (!value) return fallback
  const n = Number(value)
  if (Number.isInteger(n) && n >= 0) return n
  console.warn(`outbound: ${name}=${value} is not a whole number of minutes; transfers are off until it is fixed`)
  return 0
}

/**
 * The cost limits, in minutes: `OUTBOUND_MINUTES_PER_WORKSPACE_DAY` (120), `OUTBOUND_MINUTES_INSTALL_DAY` (2000, all
 * workspaces' transfers through the install's carrier account) and `TRANSFER_MAX_MINUTES` (30). 0 turns transfers off.
 */
export function outboundLimits(env: Env = process.env) {
  return {
    minutesPerWorkspaceDay: minutes(env, 'OUTBOUND_MINUTES_PER_WORKSPACE_DAY', OUTBOUND_MINUTES_PER_WORKSPACE_DAY),
    minutesInstallDay: minutes(env, 'OUTBOUND_MINUTES_INSTALL_DAY', OUTBOUND_MINUTES_INSTALL_DAY),
    transferMaxMinutes: minutes(env, 'TRANSFER_MAX_MINUTES', TRANSFER_MAX_MINUTES),
  }
}

/** Whether OUTBOUND_COUNTRIES sets the install's list (then Server admin shows it and cannot change it). */
const fromEnv = (env: Env) => !!env.OUTBOUND_COUNTRIES?.trim()

/** The countries calls through the install's account may reach besides the numbers' own: OUTBOUND_COUNTRIES, else Server admin's list. */
export async function installOutboundCountries(tx: Tx, env: Env = process.env): Promise<string[]> {
  if (fromEnv(env)) return parseCountryList(env.OUTBOUND_COUNTRIES)
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, KEY))
  return parseCountryList(row?.value)
}

/** The workspace's Linedesk numbers by the carrier account they are in. */
async function workspaceNumbers(tx: Tx, workspaceId: string) {
  const rows = await tx
    .select({ e164: phone_numbers.e164, account: phone_numbers.carrier_account })
    .from(phone_numbers)
    .where(eq(phone_numbers.workspace_id, workspaceId))
  return {
    install: rows.filter(n => n.account !== 'workspace').map(n => n.e164),
    workspace: rows.filter(n => n.account === 'workspace').map(n => n.e164),
  }
}

/**
 * The route a call to the workspace's number `e164` goes out through (the account the number is in, as the transfer
 * trunk is picked: transfer-trunk.ts). A number that is not the workspace's: the install's route.
 */
export async function numberRoute(tx: Tx, workspaceId: string, e164: string): Promise<OutboundRoute> {
  const [row] = await tx
    .select({ account: phone_numbers.carrier_account })
    .from(phone_numbers)
    .where(and(eq(phone_numbers.workspace_id, workspaceId), eq(phone_numbers.e164, e164)))
  return row?.account === 'workspace' ? 'workspace' : 'install'
}

type CountryOptions = { strict?: boolean; env?: Env; route?: OutboundRoute }

/**
 * The countries the workspace may call. With a `route` (a dial, the forwarding check): that route's countries. Without
 * one (saving a contact, which is used from every number): any route's. `strict`: a workspace without a number may
 * call nowhere (a dial); else it is `any` (saving settings before the first number: the dial is checked again).
 */
export async function workspaceOutboundCountries(
  tx: Tx,
  workspaceId: string,
  { strict = false, env = process.env, route }: CountryOptions = {},
): Promise<OutboundCountries> {
  const numbers = await workspaceNumbers(tx, workspaceId)
  const install = await installOutboundCountries(tx, env)
  const none = !numbers.install.length && !numbers.workspace.length
  if (none) return strict ? [] : 'any'
  return route ? routeCountries(route, numbers, install) : allowedOutboundCountries(numbers, install)
}

/** Why the workspace may not call this number (outboundNumberProblem with its countries), or null. */
export async function outboundRefusal(
  tx: Tx,
  workspaceId: string,
  e164: string,
  use: OutboundUse,
  options: CountryOptions = {},
): Promise<string | null> {
  return outboundNumberProblem(e164, await workspaceOutboundCountries(tx, workspaceId, options), use)?.message ?? null
}

/** A call that went out through the install's account: its number is not one of the workspace's own-account numbers. */
const onInstallRoute = sql`not exists (select 1 from ${phone_numbers} where ${phone_numbers.e164} = ${calls.to_number} and ${phone_numbers.workspace_id} = ${calls.workspace_id} and ${phone_numbers.carrier_account} = 'workspace')`

/**
 * Minutes of transferred calls in the 24 hours before `now`: from each dial (`transfer_at`) to the call's end, or to
 * `now` while it runs. Phone calls only (test calls never dial). Ring time counts too: an upper bound of the bill.
 * One workspace's, or all; `route: 'install'`: only those through the install's carrier account.
 */
export async function transferMinutesUsed(
  tx: Tx,
  now: string,
  { workspaceId, route }: { workspaceId?: string; route?: OutboundRoute } = {},
): Promise<number> {
  const since = new Date(Date.parse(now) - DAY_MS).toISOString()
  const [row] = await tx
    .select({
      seconds: sql<number>`coalesce(sum(greatest(0, extract(epoch from (coalesce(${calls.ended_at}, ${now}::timestamptz) - ${calls.transfer_at})))), 0)::float`,
    })
    .from(calls)
    .where(
      and(
        workspaceId ? eq(calls.workspace_id, workspaceId) : undefined,
        route === 'install' ? onInstallRoute : undefined,
        eq(calls.source, 'phone'),
        gte(calls.transfer_at, since),
        inArray(calls.transfer_result, ['dialing', 'connected']),
      ),
    )
  return (row?.seconds ?? 0) / 60
}

/**
 * How long a transfer of the workspace starting now may last, in minutes: the workspace's minutes left today and, on
 * the install's route, the install's; at most the limit for one call. Throws a Reject when transfers are off or fewer
 * than TRANSFER_MIN_MINUTES are left (logged for the operator; the install's cap with an ALERT line).
 */
export async function transferMinutesAllowed(
  tx: Tx,
  workspaceId: string,
  now: string,
  route: OutboundRoute,
  env: Env = process.env,
): Promise<number> {
  const limits = outboundLimits(env)
  if (
    !limits.minutesPerWorkspaceDay ||
    !limits.transferMaxMinutes ||
    (route === 'install' && !limits.minutesInstallDay)
  )
    throw new Reject('transfers are off on this server')
  const left = limits.minutesPerWorkspaceDay - (await transferMinutesUsed(tx, now, { workspaceId }))
  if (left < TRANSFER_MIN_MINUTES) {
    console.warn(
      `outbound: workspace ${workspaceId} used its ${limits.minutesPerWorkspaceDay} transfer minutes of the day; transfer refused`,
    )
    throw new Reject(`transfer limit reached: ${limits.minutesPerWorkspaceDay} minutes of transferred calls a day`)
  }
  let installLeft = Number.POSITIVE_INFINITY
  if (route === 'install') {
    // Install-wide: one transfer at a time reads and books the install's minutes, so workspaces dialling at the same
    // moment cannot both slip under the cap (taken after the workspace's lock, always in this order).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('transfer:install'))`)
    installLeft = limits.minutesInstallDay - (await transferMinutesUsed(tx, now, { route: 'install' }))
    if (installLeft < TRANSFER_MIN_MINUTES) {
      console.error(
        `ALERT outbound: the install-wide cap of ${limits.minutesInstallDay} transfer minutes a day is reached; transfer refused for workspace ${workspaceId}`,
      )
      throw new Reject("transfer limit reached: this server's minutes of transferred calls for today are used up")
    }
  }
  return Math.min(limits.transferMaxMinutes, Math.floor(left), Math.floor(installLeft))
}

/**
 * The caller ID for a call from the workspace's number `from` to `to`: another number of the workspace in `to`'s
 * country, in the same carrier account and with the same carrier (the trunk the call goes out through carries that
 * account's numbers), so the person sees a local number; null when `from` is already in that country or the workspace
 * has none there.
 */
export async function outboundCallerId(tx: Tx, workspaceId: string, from: string, to: string): Promise<string | null> {
  const [country] = countriesOfNumbers([to])
  if (!country || countriesOfNumbers([from])[0] === country) return null
  const numbers = await tx
    .select({
      e164: phone_numbers.e164,
      account: phone_numbers.carrier_account,
      provider: phone_numbers.provider,
      created_at: phone_numbers.created_at,
    })
    .from(phone_numbers)
    .where(eq(phone_numbers.workspace_id, workspaceId))
  const source = numbers.find(n => n.e164 === from)
  if (!source) return null
  return (
    numbers
      .filter(
        n =>
          n.account === source.account &&
          n.provider === source.provider &&
          n.e164 !== from &&
          countriesOfNumbers([n.e164])[0] === country,
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.e164 ?? null
  )
}

// ─── The carriers' own destination lists ─────────────────────────────────────────────────────────────────────

/**
 * What the install's own outbound profiles (warm transfers from install-account numbers, forwarding checks) may call:
 * the countries of the install-account numbers plus the install's list. Numbers in workspaces' own accounts never
 * count. Each workspace is still held to its own countries by Linedesk before every dial; this is the carrier's
 * ceiling under it.
 */
export async function installDestinations(tx: Tx, env: Env = process.env): Promise<string[]> {
  const numbers = (
    await tx
      .select({ e164: phone_numbers.e164 })
      .from(phone_numbers)
      .where(sql`${phone_numbers.carrier_account} is distinct from 'workspace'`)
  ).map(n => n.e164)
  return [...new Set([...countriesOfNumbers(numbers), ...(await installOutboundCountries(tx, env))])].sort()
}

/**
 * What the workspace's own-account Telnyx profile may call: the countries of its own-account numbers (none without
 * numbers: left as it is). The install's list never widens an account the business pays for.
 */
export async function workspaceDestinations(tx: Tx, workspaceId: string, env: Env = process.env): Promise<string[]> {
  return [...(await workspaceOutboundCountries(tx, workspaceId, { strict: true, env, route: 'workspace' }))]
}

type Deps = { env?: Env; fetch?: typeof fetch }
const timedFetch =
  (doFetch: typeof fetch): typeof fetch =>
  (input, init) =>
    doFetch(input, { ...init, signal: AbortSignal.timeout(CARRIER_TIMEOUT_MS) })

/**
 * Puts the allowed countries on the install's Telnyx voice profiles (transfers and forwarding checks) that exist; the
 * next set-up creates a missing one with them. Twilio: nothing is changed (account-wide Geo permissions). Runs after
 * the change committed (`onCommit`), with its own short read, so no carrier request holds a transaction. Logs and
 * never throws: a carrier that is down never undoes the change that caused this; the ALERT line says the carrier's
 * ceiling may now be wider than Linedesk's list (Linedesk still checks every dial).
 */
export async function syncInstallDestinations(deps: Deps = {}) {
  try {
    const { carrier, destinations } = await db.transaction(async tx => ({
      carrier: await installTelephony(tx),
      destinations: await installDestinations(tx, deps.env),
    }))
    if ('named' in carrier || carrier.provider !== 'telnyx') return
    const apiKey = carrier.config.api_key?.value
    if (!apiKey || !destinations.length) return
    for (const base of [TRANSFER_OUTBOUND_NAME, CHECK_TRUNK_NAME])
      await setTelnyxDestinations({
        apiKey,
        name: installCarrierName(base),
        destinations,
        fetch: timedFetch(deps.fetch ?? fetch),
      })
  } catch (e) {
    console.error(
      `ALERT outbound: the install's Telnyx destinations were not updated: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/** Which allowed countries the install's Twilio account blocks (Geo permissions); null when not Twilio or not known. */
async function twilioBlocked(tx: Tx, deps: Deps): Promise<string[] | null> {
  try {
    const carrier = await installTelephony(tx)
    if ('named' in carrier || carrier.provider !== 'twilio') return null
    const accountSid = carrier.config.account_sid?.value
    const authToken = carrier.config.auth_token?.value
    if (!accountSid || !authToken) return null
    const countries = await installDestinations(tx, deps.env)
    return await twilioBlockedCountries(
      { accountSid, authToken, fetch: deps.fetch, timeoutMs: CARRIER_TIMEOUT_MS },
      countries,
    )
  } catch (e) {
    console.warn(`outbound: Twilio Geo permissions could not be read: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

async function adminView(tx: Tx, now: string, deps: Deps): Promise<OutboundCountriesData> {
  const env = deps.env ?? process.env
  const since = new Date(Date.parse(now) - DAY_MS).toISOString()
  const [transfers] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(calls)
    .where(and(eq(calls.source, 'phone'), gte(calls.transfer_at, since)))
  const [checks] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(forwarding_checks)
    .where(and(gte(forwarding_checks.started_at, since), isNotNull(forwarding_checks.dialed_at)))
  return {
    countries: await installOutboundCountries(tx, env),
    fromEnv: fromEnv(env),
    usage: {
      transferMinutes: Math.round(await transferMinutesUsed(tx, now)),
      installTransferMinutes: Math.round(await transferMinutesUsed(tx, now, { route: 'install' })),
      transfers: transfers?.count ?? 0,
      forwardingChecks: checks?.count ?? 0,
    },
    limits: outboundLimits(env),
    twilioBlocked: await twilioBlocked(tx, deps),
    highRisk: HIGH_RISK_COUNTRIES,
  }
}

export function outboundHandlers(deps: () => Deps = () => ({})): Record<string, Handler> {
  return {
    'outbound.countries': async ({ tx, actor }) => {
      if (!actor.workspaceId) throw new Reject('no workspace')
      const allowed = await workspaceOutboundCountries(tx, actor.workspaceId, { env: deps().env })
      return { rows: {}, data: { countries: allowed === 'any' ? null : [...allowed] } satisfies OutboundCountriesView }
    },

    'outboundCountries.get': async ({ tx, now }) => ({ rows: {}, data: await adminView(tx, now, deps()) }),

    // Logged by the action runner (the audit log shows who widened where the install may call).
    'outboundCountries.set': async (
      { tx, actor, now, onCommit },
      input: { countries: string[]; confirmHighRisk?: string[] },
    ) => {
      const env = deps().env ?? process.env
      if (fromEnv(env)) throw new Reject('OUTBOUND_COUNTRIES is set on this server: change it there')
      const countries = parseCountryList(input.countries)
      const unknown = input.countries.filter(c => !countries.includes(c.trim().toUpperCase()))
      if (unknown.length) throw new Reject(`not a country code: ${unknown.join(', ')}`)
      // A frequent toll-fraud destination needs a second, explicit confirmation when it is added.
      const before = await installOutboundCountries(tx, env)
      const confirmed = parseCountryList(input.confirmHighRisk ?? [])
      const unconfirmed = countries.filter(c => isHighRiskCountry(c) && !before.includes(c) && !confirmed.includes(c))
      if (unconfirmed.length)
        throw new Reject(
          `${countryList(unconfirmed)} ${unconfirmed.length === 1 ? 'is a' : 'are'} frequent toll-fraud destination${unconfirmed.length === 1 ? '' : 's'}. Confirm to allow calls there.`,
        )
      const value = countries.join(',')
      await tx
        .insert(instance_settings)
        .values({ key: KEY, value, updated_at: now, updated_by: actor.actorId })
        .onConflictDoUpdate({
          target: instance_settings.key,
          set: { value, updated_at: now, updated_by: actor.actorId },
        })
      if (countries.some(isHighRiskCountry))
        console.warn(
          `outbound: high-risk countries allowed by ${actor.actorId}: ${countries.filter(isHighRiskCountry).join(', ')}`,
        )
      // Workspaces' own carrier accounts are not touched: the install's list never applies to them.
      const sync = () => syncInstallDestinations(deps())
      if (onCommit) onCommit(sync)
      else await sync()
      return { rows: {}, data: await adminView(tx, now, deps()) }
    },
  }
}
