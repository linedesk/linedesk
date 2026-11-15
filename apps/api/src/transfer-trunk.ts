// The outbound trunk warm transfers of a workspace's own carrier account dial through. The API sets it
// up, never the agent, and no credential ever goes to the agent:
// - at the carrier, `linedesk-outbound-<workspace id>` in the workspace's account (Twilio: Elastic SIP
//   trunk + credential list; Telnyx: credential connection + a voice profile limited to the countries the workspace
//   may call, outbound-policy.ts), so workspaces that
//   share an account, or an account shared with the install, never rotate each other's passwords;
// - in LiveKit, `linedesk-outbound-<workspace id>-<account fingerprint>` with the workspace's own-account
//   numbers as caller IDs, so after a switch to another account a trunk of the old one is never used.
// It is set up when the carrier is set and when a number is connected or released, and again by the
// agent (carrier.provisionTransferTrunk) when it is missing or the carrier refused its credentials.
import { createHash } from 'node:crypto'
import type { CarrierProvisionData, CarrierTransferTrunkData, OwnCarrier } from '@linedesk/actions'
import { commands, phone_numbers, type Tx } from '@linedesk/db'
import { createTelnyxOutbound, createTwilioOutbound, type OutboundSip, TelephonyError } from '@linedesk/telephony'
import { and, eq } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'
import { livekitToken } from './livekit-status.ts'
import { workspaceDestinations } from './outbound-policy.ts'
import { createRateLimiter } from './rate-limit.ts'
import {
  CARRIER_TIMEOUT_MS,
  carrierLabel,
  lockWorkspaceCarrier,
  ownAccountNumbers,
  ownCarrierCredentials,
  readable,
} from './workspace-carrier.ts'

type Env = Record<string, string | undefined>
const PREFIX = 'linedesk-outbound'

/** The carrier-side name in the workspace's account: one per workspace, never the install's. */
export const carrierSideName = (workspaceId: string) => `${PREFIX}-${workspaceId}`

/** Which account credentials belong to, without the credentials: the Twilio account, or the Telnyx key. */
export function accountFingerprint(carrier: OwnCarrier, values: Record<string, string>): string {
  const account = carrier === 'twilio' ? values.account_sid : values.api_key
  return createHash('sha256').update(`${carrier}:${account}`).digest('hex').slice(0, 12)
}

const trunkPrefix = (workspaceId: string) => `${carrierSideName(workspaceId)}-`
export const livekitTrunkName = (workspaceId: string, fingerprint: string) =>
  `${trunkPrefix(workspaceId)}${fingerprint}`

/** Sets up outbound calling in the workspace's account and returns SIP credentials with a new password. */
function ownOutboundSip(
  workspaceId: string,
  carrier: OwnCarrier,
  values: Record<string, string>,
  doFetch: typeof fetch,
  destinations: string[],
): Promise<OutboundSip> {
  const name = carrierSideName(workspaceId)
  if (carrier === 'telnyx')
    return createTelnyxOutbound({ apiKey: values.api_key!, name, destinations, fetch: doFetch }).ensureOutboundSip()
  const auth =
    values.api_key_sid && values.api_key_secret
      ? { apiKeySid: values.api_key_sid, apiKeySecret: values.api_key_secret }
      : { authToken: values.auth_token! }
  return createTwilioOutbound({ accountSid: values.account_sid!, ...auth, name, fetch: doFetch }).ensureOutboundSip()
}

type TrunkInfo = { sipTrunkId: string; name: string; numbers?: string[] }

/** LiveKit's SIP API (Twirp), with a short-lived token that may only manage SIP. */
export function livekitSip(env: Env = process.env, doFetch: typeof fetch = fetch) {
  const url = env.LIVEKIT_URL
  const key = env.LIVEKIT_API_KEY
  const secret = env.LIVEKIT_API_SECRET
  if (!url || !key || !secret) return null
  const base = `${url.replace(/^ws/, 'http').replace(/\/$/, '')}/twirp`
  async function call(method: string, body: object, timeoutMs = CARRIER_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const res = await doFetch(`${base}/livekit.SIP/${method}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${livekitToken(key!, secret!, { sip: { admin: true, call: true } }, undefined, { ttlSec: Math.ceil(timeoutMs / 1000) + 60 })}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = ((await res.json().catch(() => null)) as Record<string, unknown> | null) ?? {}
    if (!res.ok) throw new LivekitError(`LiveKit ${method} answered HTTP ${res.status}`, res.status, json)
    return json
  }
  return {
    async outboundTrunks(): Promise<TrunkInfo[]> {
      return ((await call('ListSIPOutboundTrunk', {})).items as TrunkInfo[] | undefined) ?? []
    },
    async createOutboundTrunk(name: string, numbers: string[], sip: OutboundSip): Promise<string> {
      const trunk = await call('CreateSIPOutboundTrunk', {
        trunk: {
          name,
          address: sip.address,
          numbers,
          authUsername: sip.username,
          authPassword: sip.password,
          headers: sip.headers,
          transport: 'SIP_TRANSPORT_TCP',
        },
      })
      return String(trunk.sipTrunkId)
    },
    async deleteTrunk(sipTrunkId: string) {
      await call('DeleteSIPTrunk', { sipTrunkId })
    },
    /**
     * Dials out through an outbound trunk into `roomName` (forwarding checks). With `waitUntilAnswered` it returns
     * once the callee answered; a refusal (busy, no answer) is a LivekitError whose body says the SIP status.
     */
    async createSipParticipant(request: SipParticipantRequest, timeoutMs: number): Promise<void> {
      await call('CreateSIPParticipant', request, timeoutMs)
    },
  }
}

/** A refused LiveKit request: the HTTP status and LiveKit's (Twirp) error body, which may name a SIP status. */
export class LivekitError extends Error {
  readonly status: number
  readonly body: Record<string, unknown>
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** LiveKit's CreateSIPParticipant request (protobuf JSON: durations as "40s"). */
export type SipParticipantRequest = {
  sipTrunkId: string
  sipCallTo: string
  sipNumber: string
  roomName: string
  participantIdentity: string
  participantName?: string
  waitUntilAnswered: boolean
  ringingTimeout: string
  maxCallDuration: string
}

type Deps = { env?: Env; fetch?: typeof fetch }
/** Deletes the workspace's LiveKit outbound trunks of its own accounts, all but `keep` (after a carrier change). */
export async function removeTransferTrunks(workspaceId: string, deps: Deps = {}, keep?: string) {
  const sip = livekitSip(deps.env, deps.fetch)
  if (!sip) return
  for (const trunk of await sip.outboundTrunks())
    if (trunk.name.startsWith(trunkPrefix(workspaceId)) && trunk.sipTrunkId !== keep)
      await sip.deleteTrunk(trunk.sipTrunkId)
}

/**
 * Sets the transfer trunk of the workspace's own account up (again): the carrier side with a new
 * password, then a new LiveKit trunk, and only then the old trunks go, so a transfer that is dialling
 * keeps a trunk as long as possible. Without own-account numbers it only removes old trunks. Carrier and
 * LiveKit requests each give up after 8 s. Returns the new trunk's id, null when nothing was set up.
 */
export async function provisionTransferTrunk(tx: Tx, workspaceId: string, deps: Deps = {}): Promise<string | null> {
  const doFetch = deps.fetch ?? fetch
  const sip = livekitSip(deps.env, doFetch)
  if (!sip) return null
  const own = await readable(() => ownCarrierCredentials(tx, workspaceId))
  const numbers = (await ownAccountNumbers(tx, workspaceId)).map(n => n.e164)
  if (!own || !numbers.length) {
    await removeTransferTrunks(workspaceId, { env: deps.env, fetch: doFetch })
    return null
  }
  const timed: typeof fetch = (input, init) =>
    doFetch(input, { ...init, signal: AbortSignal.timeout(CARRIER_TIMEOUT_MS) })
  let credentials: OutboundSip
  try {
    credentials = await ownOutboundSip(
      workspaceId,
      own.carrier,
      own.values,
      timed,
      await workspaceDestinations(tx, workspaceId, deps.env),
    )
  } catch (e) {
    // The adapters keep credentials out of their messages.
    throw e instanceof TelephonyError
      ? new Reject(`outbound setup at ${carrierLabel[own.carrier]} failed: ${e.message}`)
      : e
  }
  const name = livekitTrunkName(workspaceId, accountFingerprint(own.carrier, own.values))
  const trunkId = await sip.createOutboundTrunk(name, numbers, credentials)
  await removeTransferTrunks(workspaceId, { env: deps.env, fetch: doFetch }, trunkId)
  return trunkId
}

/**
 * Writes an audit entry (a command row, kind `keys`) for a set-up that another command caused: a new
 * SIP password in the workspace's carrier account. No credential is in it.
 */
async function recordProvision(tx: Tx, workspaceId: string, cause: Cause, trunkId: string) {
  await tx.insert(commands).values({
    id: `cmd_${crypto.randomUUID().replaceAll('-', '')}`,
    workspace_id: workspaceId,
    actor_id: cause.actorId,
    action: 'carrier.provisionTransferTrunk',
    input: { trigger: cause.trigger },
    result: { ok: true, rows: {}, data: { trunkId } },
    impersonated_by: cause.impersonatedBy ?? null,
  })
}

/** Which command set the trunk up as a side effect, for the audit entry. */
export type Cause = { actorId: string; trigger: string; impersonatedBy?: string | null }

/**
 * The same, for the side effects of carrier.set and phoneNumber.setup/release: a failure is logged and
 * does not undo the change (the agent sets the trunk up when it is missing). Never logs a credential.
 * A set-up that rotated the carrier-side password is recorded in the audit log under `cause`.
 */
export async function refreshTransferTrunk(tx: Tx, workspaceId: string, cause: Cause, deps: Deps = {}) {
  try {
    const trunkId = await provisionTransferTrunk(tx, workspaceId, deps)
    if (trunkId) await recordProvision(tx, workspaceId, cause, trunkId)
  } catch (e) {
    console.warn(`transfer trunk of workspace ${workspaceId} not set up: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** The agent may ask for a new set-up a few times; each one rotates a password at the carrier. */
export const PROVISIONS_PER_10_MIN = 3
const allowProvision = createRateLimiter({ max: PROVISIONS_PER_10_MIN, windowMs: 10 * 60_000 })

export function transferTrunkHandlers(deps: () => Deps = () => ({})): Record<string, Handler> {
  return {
    // Only the workspace of the call the agent names (x-workspace-id); the number must be that workspace's,
    // and the account it is in decides (install numbers stay with the install's trunk).
    'carrier.transferTrunk': async ({ tx, actor }, input) => {
      if (!actor.workspaceId) throw new Reject('no workspace (send x-workspace-id)')
      const [number] = await tx
        .select({ account: phone_numbers.carrier_account })
        .from(phone_numbers)
        .where(and(eq(phone_numbers.workspace_id, actor.workspaceId), eq(phone_numbers.e164, input.from)))
      if (!number) throw new Reject(`${input.from} is not a number of this workspace`)
      if (number.account === 'install') {
        return { rows: {}, data: { carrier: 'default', trunkName: null } satisfies CarrierTransferTrunkData }
      }
      const own = await readable(() => ownCarrierCredentials(tx, actor.workspaceId!))
      // Never the install's trunk for a number in the workspace's account: no transfer then.
      if (!own)
        throw new Reject(`${input.from} is in the workspace's own carrier account, which is not set up any more`)
      const trunkName = livekitTrunkName(actor.workspaceId, accountFingerprint(own.carrier, own.values))
      return { rows: {}, data: { carrier: own.carrier, trunkName } satisfies CarrierTransferTrunkData }
    },

    // Logged by the action runner like every command that is not read-only: the audit log shows it.
    'carrier.provisionTransferTrunk': async ({ tx, actor }) => {
      if (!actor.workspaceId) throw new Reject('no workspace (send x-workspace-id)')
      // Serialised with carrier.set and number setup, so it never provisions with a carrier being switched.
      await lockWorkspaceCarrier(tx, actor.workspaceId)
      if (!allowProvision(actor.workspaceId))
        throw new Reject('The transfer trunk was set up too often. Try again in a few minutes.')
      const trunkId = await provisionTransferTrunk(tx, actor.workspaceId, deps())
      return { rows: {}, data: { trunkId } satisfies CarrierProvisionData }
    },
  }
}
