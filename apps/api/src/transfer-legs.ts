// The legs of a warm transfer (transfers.ts): a leg is open from its dial until a result other than `connected` ends
// it, or the call ends. Shared by call.transfer (closing a leg), the day's transfer minutes and rating a billed call
// (ledger.ts: the inbound leg plus every transfer leg, the bridged one up to the call's end; security review of #864, H1).
import type { Call } from '@linedesk/db'

/** Whether a leg of this call is open: dialled and not ended by a result other than `connected`. */
export const legOpen = (call: Pick<Call, 'transfer_result' | 'transfer_at'>) =>
  !!call.transfer_at && (call.transfer_result === 'dialing' || call.transfer_result === 'connected')

/**
 * The call's `transfer_seconds` once its open leg ends at `now` (at the call's end when that came first): the seconds
 * from that leg's dial added, ringing included (as the day's minutes count it). Unchanged when no leg is open (a contact
 * that could not be dialled, a second result for the same leg).
 */
export function closedLegSeconds(
  call: Pick<Call, 'transfer_result' | 'transfer_at' | 'transfer_seconds' | 'ended_at'>,
  now: string,
) {
  if (!legOpen(call)) return call.transfer_seconds
  const end = Math.min(Date.parse(now), call.ended_at ? Date.parse(call.ended_at) : Number.POSITIVE_INFINITY)
  const seconds = Math.ceil((end - Date.parse(call.transfer_at!)) / 1000)
  return call.transfer_seconds + Math.max(0, seconds)
}
