// What the caller's carrier said about the call, read from the SIP INVITE headers LiveKit SIP copies into the caller's
// participant attributes as `sip.h.<header>` (the inbound trunk passes all headers: sip-trunks.ts).
// - STIR/SHAKEN attestation: Telnyx adds `;verstat=…` to the P-Asserted-Identity URI; Twilio sends X-Twilio-VerStat.
//   Only headers the terminating carrier writes count: never From, never a display name (the caller's side sets those).
// - Spam screening: Telnyx inbound call screening in flag mode adds `X-Telnyx-Call-Screening: SPAM LIKELY`.
import type { CallerAttestation } from '@linedesk/actions'

type Attributes = Record<string, string>

/** Quoted display names, which the caller's side writes: `"verstat=TN-Validation-Passed" <sip:…>` names nothing. */
const QUOTED = /"(?:[^"\\]|\\.)*"/g
const VERSTAT_PARAM = /;\s*verstat=([A-Za-z-]+)/gi

/** The one verstat parameter of a header's URI; two different ones (a header written twice) count as none. */
function verstatParam(header: string | undefined): string | null | 'conflict' {
  if (!header) return null
  const values = new Set([...header.replace(QUOTED, '').matchAll(VERSTAT_PARAM)].map(m => m[1]!.toLowerCase()))
  if (values.size > 1) return 'conflict'
  const [only] = values
  return only ?? null
}

/** The verstat of the call: `TN-Validation-Passed-B`, `No-TN-Validation`, … ('conflict': more than one). */
function verstatOf(attributes: Attributes): string | null {
  const asserted = verstatParam(attributes['sip.h.p-asserted-identity'])
  if (asserted) return asserted
  // Twilio's header only on a call Twilio delivered: another carrier may pass a caller's X- headers on.
  const twilio = attributes['sip.h.x-twilio-verstat']?.trim()
  if (twilio && /(^|\.)twilio\.com$/i.test(attributes['sip.hostname'] ?? '')) return twilio
  return null
}

/**
 * The attestation the caller's carrier gave the caller ID. `TN-Validation-Passed` without a level is A (Telnyx);
 * Twilio's `-Diverted` (the call was forwarded, the original signature kept) keeps its level. No headers at all (a
 * trunk that does not pass them, a test room): undefined, nothing is known, and the server treats the number as not
 * verified (callerRecognized). Headers without a verstat: `none`, since an INVITE sent to us from a carrier's address by someone else (a
 * SIP dial from any account at that carrier) carries none, whatever caller ID it sets. Two different levels in one
 * header: `none`.
 */
export function callerAttestation(attributes: Attributes): CallerAttestation | undefined {
  const verstat = verstatOf(attributes)
  if (!verstat) return hasSipHeaders(attributes) ? 'none' : undefined
  const passed = verstat.match(/^TN-Validation-Passed(?:-([ABC]))?(?:-Diverted)?$/i)
  if (passed) return (passed[1]?.toUpperCase() as 'A' | 'B' | 'C' | undefined) ?? 'A'
  if (/^TN-Validation-Failed/i.test(verstat)) return 'failed'
  return 'none'
}

/** Whether LiveKit SIP passed the INVITE's headers at all; without them the carrier's check cannot be read. */
export const hasSipHeaders = (attributes: Attributes): boolean =>
  Object.keys(attributes).some(key => key.startsWith('sip.h.'))

let warnedNoHeaders = false
/**
 * Warns once per worker when a phone call arrives without SIP headers: the inbound trunk does not pass them (run
 * setup-sip, which sets it), so the carrier's check cannot be read and, while "Recognize callers only when their
 * carrier verified the number" is on, no phone caller is recognized.
 */
export function warnIfNoSipHeaders(attributes: Attributes) {
  if (warnedNoHeaders || hasSipHeaders(attributes)) return
  warnedNoHeaders = true
  console.warn(
    "caller ID: this call came without SIP headers, so the carrier's caller-ID check cannot be read and the caller counts as not verified (no contact, history or bookings while 'Recognize callers only when their carrier verified the number' is on). Run `pnpm --filter @linedesk/agent setup-sip <numbers>` so the inbound trunk passes all headers.",
  )
}

/** Whether the carrier's spam screening flagged the call. */
export const spamLikely = (attributes: Attributes): boolean =>
  /spam/i.test(attributes['sip.h.x-telnyx-call-screening'] ?? '')
