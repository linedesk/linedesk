// A workspace's own carrier account (Settings, Phone numbers, Carrier). The choice is
// workspace_settings.carrier; the credentials are provider_settings rows with the workspace's id,
// AES-256-GCM with SECRETS_KEY, each ciphertext bound to its workspace, carrier and field, so a value
// copied to another workspace's row does not decrypt. Only this file reads those rows, always by the
// workspace id of the actor; nothing here ever returns a secret to the browser.
import {
  type CarrierFieldStatus,
  type CarrierStatusData,
  type CarrierTestData,
  carrierFields,
  type OwnCarrier,
  type WorkspaceCarrier,
} from '@linedesk/actions'
import { provider_settings, type Tx, workspace_settings } from '@linedesk/db'
import { createTelnyxProvider, createTwilioProvider, TelephonyError, type TelephonyProvider } from '@linedesk/telephony'
import { and, eq } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'
import { DEFAULT_TIME_ZONE } from './bookings.ts'
import { createRateLimiter } from './rate-limit.ts'
import { decryptSecret, encryptSecret, hasSecretsKey, SecretsKeyError } from './secrets.ts'

export const CARRIER_TIMEOUT_MS = 8000
/** "Test connection" asks the carrier each time: a few in a row are normal, more per workspace are refused. */
export const CARRIER_TESTS_PER_10_MIN = 10
const allowCarrierTest = createRateLimiter({ max: CARRIER_TESTS_PER_10_MIN, windowMs: 10 * 60_000 })
/** Until numbers can be set up in a workspace's own account (next step), phoneNumber.setup says so. */
export const OWN_CARRIER_NOT_YET =
  'Numbers cannot be connected through your own carrier account yet. Switch the carrier back to Linedesk default to add a number.'
/** How many numbers "Test connection" lists at most. */
const LIST_LIMIT = 20
const MAX_MESSAGE = 200

const slot = (workspaceId: string, carrier: OwnCarrier, field: string) => `workspace:${workspaceId}:${carrier}.${field}`
const newId = () => `ps_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const lastFour = (value: string) => (value.length >= 12 ? value.slice(-4) : null)
const ownCarriers = Object.keys(carrierFields) as OwnCarrier[]
const carrierLabel: Record<OwnCarrier, string> = { twilio: 'Twilio', telnyx: 'Telnyx' }

/** The owner sees this instead of the operator's SECRETS_KEY text. */
const UNREADABLE = 'The saved carrier credentials cannot be read on this server. Enter them again.'

/** The carrier account the workspace uses; `default` without a settings row. */
export async function workspaceCarrier(tx: Tx, workspaceId: string): Promise<WorkspaceCarrier> {
  const [row] = await tx
    .select({ carrier: workspace_settings.carrier })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  return row?.carrier ?? 'default'
}

/** The workspace's stored credential rows of one carrier. */
const credentialRows = (tx: Tx, workspaceId: string, carrier: OwnCarrier) =>
  tx
    .select()
    .from(provider_settings)
    .where(and(eq(provider_settings.workspace_id, workspaceId), eq(provider_settings.provider, carrier)))

/** The workspace's own carrier with its credentials in clear, or null when it uses the install's. */
export async function ownCarrierCredentials(
  tx: Tx,
  workspaceId: string,
): Promise<{ carrier: OwnCarrier; values: Record<string, string> } | null> {
  const carrier = await workspaceCarrier(tx, workspaceId)
  if (carrier === 'default') return null
  const rows = await credentialRows(tx, workspaceId, carrier)
  const values = Object.fromEntries(
    rows.map(row => [row.field, decryptSecret(row.value_encrypted, slot(workspaceId, carrier, row.field))]),
  )
  return { carrier, values }
}

/** The adapter for a carrier and its credentials. Throws when a needed value is missing. */
export function carrierProvider(
  carrier: OwnCarrier,
  values: Record<string, string>,
  doFetch: typeof fetch = fetch,
): TelephonyProvider {
  if (carrier === 'telnyx') {
    if (!values.api_key) throw new Reject('The Telnyx API key is not set')
    return createTelnyxProvider({ apiKey: values.api_key, fetch: doFetch })
  }
  if (!values.account_sid) throw new Reject('The Twilio Account SID is not set')
  if (values.api_key_sid && values.api_key_secret) {
    return createTwilioProvider({
      accountSid: values.account_sid,
      apiKeySid: values.api_key_sid,
      apiKeySecret: values.api_key_secret,
      fetch: doFetch,
    })
  }
  if (!values.auth_token) throw new Reject('The Twilio API key or auth token is not set')
  return createTwilioProvider({ accountSid: values.account_sid, authToken: values.auth_token, fetch: doFetch })
}

/**
 * The adapter of the workspace's own carrier account, or null when the workspace uses the install's.
 * Built only from this workspace's rows.
 */
export async function ownCarrierProvider(
  tx: Tx,
  workspaceId: string,
  doFetch: typeof fetch = fetch,
): Promise<TelephonyProvider | null> {
  const own = await readable(() => ownCarrierCredentials(tx, workspaceId))
  return own && carrierProvider(own.carrier, own.values, doFetch)
}

async function readable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    throw e instanceof SecretsKeyError ? new Reject(UNREADABLE) : e
  }
}

/** What Settings shows: the carrier, which fields are set, never a secret. */
export async function carrierStatus(tx: Tx, workspaceId: string): Promise<CarrierStatusData> {
  const carrier = await workspaceCarrier(tx, workspaceId)
  if (carrier === 'default') return { carrier, canStore: hasSecretsKey(), fields: [], updatedAt: null }
  const rows = await credentialRows(tx, workspaceId, carrier)
  const fields = Object.entries(carrierFields[carrier]).map(([field, spec]): CarrierFieldStatus => {
    const row = rows.find(r => r.field === field)
    let value: string | null = null
    if (row && !spec.secret) {
      try {
        value = decryptSecret(row.value_encrypted, slot(workspaceId, carrier, field))
      } catch {
        value = null // still shown as set; using it reports the problem
      }
    }
    return {
      field,
      label: spec.label,
      secret: spec.secret,
      set: !!row,
      value,
      last4: spec.secret ? (row?.last4 ?? null) : null,
    }
  })
  const updated = rows.map(r => new Date(r.updated_at).toISOString()).sort()
  return { carrier, canStore: hasSecretsKey(), fields, updatedAt: updated.at(-1) ?? null }
}

/** Stores the choice; an own carrier's credentials replace every credential the workspace had. */
export async function setWorkspaceCarrier(
  tx: Tx,
  workspaceId: string,
  carrier: WorkspaceCarrier,
  values: Record<string, string | undefined>,
  actorId: string,
  now: string,
) {
  if (carrier !== 'default' && !hasSecretsKey()) {
    throw new Reject('This server cannot store carrier credentials yet. Ask whoever runs your Linedesk.')
  }
  for (const own of ownCarriers) {
    await tx
      .delete(provider_settings)
      .where(and(eq(provider_settings.workspace_id, workspaceId), eq(provider_settings.provider, own)))
  }
  if (carrier !== 'default') {
    for (const [field, value] of Object.entries(values)) {
      if (!value) continue
      const secret = carrierFields[carrier][field]!.secret
      await tx.insert(provider_settings).values({
        id: newId(),
        workspace_id: workspaceId,
        provider: carrier,
        field,
        value_encrypted: encryptSecret(value, slot(workspaceId, carrier, field)),
        last4: secret ? lastFour(value) : null,
        updated_at: now,
        updated_by: actorId,
      })
    }
  }
  await tx
    .insert(workspace_settings)
    .values({ workspace_id: workspaceId, timezone: DEFAULT_TIME_ZONE, carrier })
    .onConflictDoUpdate({ target: workspace_settings.workspace_id, set: { carrier } })
}

/**
 * "Test connection": lists the numbers of the account, nothing else. The answer never carries a
 * credential: on 401/403 a fixed text, otherwise the carrier's text with every credential removed.
 */
export async function testOwnCarrier(
  carrier: OwnCarrier,
  values: Record<string, string>,
  doFetch: typeof fetch = fetch,
): Promise<CarrierTestData> {
  const label = carrierLabel[carrier]
  const scrub = (text: string) =>
    Object.values(values)
      .filter(value => value.length >= 4)
      .reduce((t, value) => t.replaceAll(value, '[redacted]'), text)
      .slice(0, MAX_MESSAGE)
  const timed: typeof fetch = (input, init) =>
    doFetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(CARRIER_TIMEOUT_MS) })
  try {
    const numbers = await carrierProvider(carrier, values, timed).listNumbers(LIST_LIMIT)
    const count =
      numbers.length >= LIST_LIMIT
        ? `${LIST_LIMIT} or more numbers`
        : `${numbers.length} ${numbers.length === 1 ? 'number' : 'numbers'}`
    return { ok: true, message: `Connected. ${count} in the account.` }
  } catch (e) {
    if (e instanceof Reject) return { ok: false, message: e.message }
    if (e instanceof TelephonyError && (e.status === 401 || e.status === 403))
      return { ok: false, message: `${label} rejected the credentials (HTTP ${e.status})` }
    if (e instanceof Error && e.name === 'TimeoutError')
      return { ok: false, message: `${label} did not answer within ${CARRIER_TIMEOUT_MS / 1000} seconds` }
    const text = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)
    return { ok: false, message: scrub(`Could not reach ${label}: ${text}`) }
  }
}

/** `fetch` is replaced in tests. */
export function carrierHandlers(doFetch: () => typeof fetch = () => fetch): Record<string, Handler> {
  return {
    'carrier.get': async ({ tx, actor }) => {
      if (!actor.workspaceId) throw new Reject('no workspace')
      return { rows: {}, data: await carrierStatus(tx, actor.workspaceId) }
    },

    'carrier.set': async ({ tx, actor, now }, input) => {
      if (!actor.workspaceId) throw new Reject('no workspace')
      await setWorkspaceCarrier(tx, actor.workspaceId, input.carrier, input.values ?? {}, actor.actorId, now)
      return { rows: {}, data: await carrierStatus(tx, actor.workspaceId) }
    },

    'carrier.test': async ({ tx, actor }) => {
      if (!actor.workspaceId) throw new Reject('no workspace')
      if (!allowCarrierTest(actor.workspaceId))
        throw new Reject('Too many connection tests. Try again in a few minutes.')
      const own = await readable(() => ownCarrierCredentials(tx, actor.workspaceId!))
      if (!own) return { rows: {}, data: { ok: false, message: 'The workspace uses the default carrier.' } }
      return { rows: {}, data: await testOwnCarrier(own.carrier, own.values, doFetch()) }
    },
  }
}
