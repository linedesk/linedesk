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
import { SIPTransport } from '@livekit/protocol'
import { sipTlsFromEnv } from '@linedesk/telephony'
import type { SipClient } from 'livekit-server-sdk'
import type { ApiClient, CallScope } from './api-client.ts'
import { type DialRequest, NotAnsweredError, type OnCallDialer } from './on-call-dialer.ts'

/** How a transfer from the call to `from` dials out (`default`: the install's trunk). */
export const transferRoute = async (api: ApiClient, call: CallScope, from: string) =>
  (await api.run(carrierTransferTrunk, { from }, call)).data as CarrierTransferTrunkData

/** Asks the API to set the workspace's trunk up again; its id. */
export async function reprovisionTrunk(api: ApiClient, call: CallScope): Promise<string> {
  const { trunkId } = (await api.run(carrierProvisionTransferTrunk, {}, call)).data as CarrierProvisionData
  if (!trunkId) throw new Error('the workspace has no trunk of its own account to dial through')
  return trunkId
}

/**
 * The workspace's trunk by its exact name (which carries the account) with `from` as a caller ID and the transport
 * LIVEKIT_SIP_TLS asks for (a trunk made before the setting changed dials the old way), else set up anew.
 */
export async function ownTransferTrunk(
  api: ApiClient,
  sip: SipClient,
  call: CallScope,
  trunkName: string,
  from: string,
  secure = sipTlsFromEnv(),
): Promise<string> {
  const trunk = (await sip.listSipOutboundTrunk()).find(t => t.name === trunkName)
  if (trunk?.numbers.includes(from) && (trunk.transport === SIPTransport.SIP_TRANSPORT_TLS) === secure) return trunk.sipTrunkId
  return reprovisionTrunk(api, call)
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
