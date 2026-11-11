// Warm transfers dial out through the carrier account the called number is in: the install's
// "linedesk-outbound" trunk, or, for a number in the workspace's own Twilio or Telnyx account, the
// workspace's LiveKit trunk ("linedesk-outbound-<workspace id>-<account fingerprint>"). The API sets
// that trunk up (carrier.transferTrunk names it, carrier.provisionTransferTrunk repairs it); the agent
// never sees the carrier credentials and never dials a workspace number through another trunk.
import {
  type CarrierProvisionData,
  type CarrierTransferTrunkData,
  carrierProvisionTransferTrunk,
  carrierTransferTrunk,
} from '@linedesk/actions'
import type { SipClient } from 'livekit-server-sdk'
import type { ApiClient } from './api-client.ts'
import { type DialRequest, NotAnsweredError, type OnCallDialer } from './on-call-dialer.ts'

/** How a transfer from the call to `from` dials out (`default`: the install's trunk). */
export const transferRoute = async (api: ApiClient, workspaceId: string, from: string) =>
  (await api.run(carrierTransferTrunk, { from }, workspaceId)).data as CarrierTransferTrunkData

/** Asks the API to set the workspace's trunk up again; its id. */
export async function reprovisionTrunk(api: ApiClient, workspaceId: string): Promise<string> {
  const { trunkId } = (await api.run(carrierProvisionTransferTrunk, {}, workspaceId)).data as CarrierProvisionData
  if (!trunkId) throw new Error('the workspace has no trunk of its own account to dial through')
  return trunkId
}

/** The workspace's trunk by its exact name (which carries the account) with `from` as a caller ID, else set up anew. */
export async function ownTransferTrunk(
  api: ApiClient,
  sip: SipClient,
  workspaceId: string,
  trunkName: string,
  from: string,
): Promise<string> {
  const trunk = (await sip.listSipOutboundTrunk()).find(t => t.name === trunkName)
  if (trunk?.numbers.includes(from)) return trunk.sipTrunkId
  return reprovisionTrunk(api, workspaceId)
}

/**
 * The carrier refused the trunk's credentials (SIP 401/407): worth setting it up once more. Not 403: Twilio
 * also answers 403 for a destination the account may not call, which a new password does not change.
 */
export const isCredentialRefusal = (e: unknown) =>
  !(e instanceof NotAnsweredError) &&
  e instanceof Error &&
  /\b(401|407)\b|unauthori[sz]ed|proxy authentication/i.test(e.message)

/**
 * A dialer that finds its trunk when it dials, not before the greeting. When the carrier refuses the
 * credentials (rotated elsewhere, account changed) it asks the API to set the trunk up again and dials once more.
 */
export function workspaceTrunkDialer(
  trunk: () => Promise<string>,
  reprovision: () => Promise<string>,
  dialer: (trunkId: string) => OnCallDialer,
): OnCallDialer {
  return {
    async dial(request: DialRequest) {
      try {
        return await dialer(await trunk()).dial(request)
      } catch (e) {
        if (!isCredentialRefusal(e) || request.signal.aborted) throw e
        return dialer(await reprovision()).dial(request)
      }
    },
  }
}
