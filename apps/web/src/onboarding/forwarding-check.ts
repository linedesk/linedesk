// What the owner sees after a forwarding check (onboarding concept, 6c): one line on what happened and the one
// next thing to try. The check itself runs on the server (phoneNumber.checkForwarding).
import { type ForwardingCheckView, isRealCall, type LineLookupData } from '@linedesk/actions'
import type { Call, PhoneNumber } from '@linedesk/db/types'

/**
 * `fixes`: what the owner can switch to in one click when forwarding the missed calls doesn't work on their line:
 * forward every call (forward_all), or give out the Linedesk number itself (new).
 */
export type CheckResultText = { title: string; next: string | null; ok: boolean; fixes?: ('forward_all' | 'new')[] }

/**
 * `forwardsAll`: the number is set up to forward every call (forward_all), not only the ones nobody answers, so the
 * texts speak of every call.
 */
export function checkResultText(
  check: Pick<ForwardingCheckView, 'status' | 'ringSeconds' | 'detail'> & { simulated?: boolean },
  assistant: string,
  forwardsAll = false,
): CheckResultText {
  const which = forwardsAll ? 'calls to your business number' : 'calls you don’t answer'
  switch (check.status) {
    case 'dialing':
      return { title: 'Calling your business number. Let it ring, don’t pick up.', next: null, ok: false }
    case 'works':
      // Nothing was dialled (development carrier): never "verified", never the green of a real result.
      if (check.simulated) return { title: `Simulated: ${which} would reach ${assistant}.`, next: null, ok: false }
      return {
        title: check.ringSeconds
          ? `Verified: ${which} reach ${assistant} after about ${check.ringSeconds} seconds.`
          : `Verified: ${which} reach ${assistant}.`,
        next: null,
        ok: true,
      }
    case 'rang_through':
      return {
        title: 'It rang on your phone but was never forwarded.',
        next: forwardsAll
          ? 'Dial the forward-all code again and wait for the confirmation tone, then check again.'
          : 'Dial the code again and wait for the confirmation tone, then check again. If it still rings through, your line may not forward missed calls: forward every call instead, or give out your assistant’s number.',
        ok: false,
        fixes: forwardsAll ? undefined : ['forward_all', 'new'],
      }
    case 'answered':
      return {
        title: 'The call was picked up before it was forwarded.',
        next: 'Probably your voicemail. Turn off Live Voicemail and call screening on your phone, or set a shorter ring time, then check again. Don’t answer the test call.',
        ok: false,
      }
    case 'busy':
      return {
        title: 'Your line was busy.',
        next: 'Hang up any call on that line and check again. Busy calls forward only after you dial the busy code too.',
        ok: false,
      }
    case 'forwards_elsewhere':
      return {
        title: 'Your phone forwards to a different number.',
        next: `${check.detail ? `${check.detail} ` : ''}Dial the code shown here again from your business phone, then check again.`,
        ok: false,
      }
    case 'no_assistant':
      return {
        title: `Forwarding works, but ${assistant} did not pick up.`,
        next: 'The call reached Linedesk, but the assistant is not running right now. Whoever runs this server can check the voice agent; then check again.',
        ok: false,
      }
    case 'unreachable':
      return {
        title: 'Your business number could not be reached.',
        next: 'Check the number you entered and that the phone has a signal, then check again.',
        ok: false,
      }
    default:
      return {
        title: 'We could not check it this time.',
        next: `${check.detail ? `${check.detail} ` : ''}Call your business number from another phone and let it ring: ${assistant} should answer.`,
        ok: false,
      }
  }
}

/** What the owner sees instead of "Check forwarding" when this server cannot run a check. */
export const noCheckText = (assistant: string) =>
  `Automatic checks are not available on this server. To test forwarding, call your business number from another phone and let it ring: ${assistant} should answer.`

/** The quiet marker next to a carrier lookup or a check result made up by the development carrier. */
export const SIMULATED_MARK = 'Development mode: simulated'

const lineTypeText: Record<LineLookupData['lineType'], string | null> = {
  mobile: 'mobile',
  landline: 'landline',
  voip: 'phone system or app',
  toll_free: 'toll-free number',
  unknown: null,
}

/** "Verizon Wireless · mobile", or null when the lookup found nothing worth showing. */
export function lineText(found: LineLookupData): string | null {
  const parts = [found.carrier, lineTypeText[found.lineType]].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/** Who picked the guide remembered for a number: the owner in the picker, or a carrier lookup. */
export type GuidePickedBy = 'owner' | 'lookup'

/**
 * The guide picked by hand, from what this browser remembers for a number: the guide id and who picked it. A pick
 * saved without a source was made in the picker. null when nothing is remembered or a lookup picked it.
 */
export function ownerPick(saved: string | null, by: string | null): string | null {
  return saved && by !== 'lookup' ? saved : null
}

/**
 * What a carrier lookup does with the guide: preselect its carrier while the owner has not picked one by hand, or
 * suggest it when it differs from the owner's pick. Nothing when the lookup found no guide or agrees with the pick.
 */
export function lookupGuide(
  found: string | null,
  pickedByOwner: string | null,
): { preselect: string } | { suggest: string } | null {
  if (!found || found === pickedByOwner) return null
  return pickedByOwner ? { suggest: found } : { preselect: found }
}

export type ForwardedCall = Pick<Call, 'source' | 'direction' | 'from_own_number' | 'outcome' | 'to_number' | 'started_at'>

/**
 * A real caller reached this number since it was set up: the server's rule for "forwarding works"
 * (apps/api/src/go-live-checklist.ts, forwardingVerifiedFor): over the phone, incoming, not from the business's own
 * phones, not spam (isRealCall), to this number, at or after its `created_at`. In the browser it shows at once, as the
 * call arrives, before the server's checklist is read again.
 */
export function realCallReached(
  number: Pick<PhoneNumber, 'e164' | 'created_at'>,
  calls: readonly ForwardedCall[],
): boolean {
  const since = Date.parse(number.created_at)
  return calls.some(c => isRealCall(c) && c.to_number === number.e164 && !(Date.parse(c.started_at) < since))
}

/**
 * A number the business phone forwards to, whose forwarding nobody has seen work yet: no check verified it
 * (`verified_at`, set with the forwarding_verified milestone) and no real caller reached it (realCallReached). The same
 * rule as the go-live checklist's forwarding row; until then Settings › Phone numbers doesn't say "Answering" for it.
 */
export function forwardingUnverified(
  number: Pick<PhoneNumber, 'e164' | 'mode' | 'verified_at' | 'created_at'>,
  calls: readonly ForwardedCall[],
): boolean {
  if (number.mode !== 'forward_conditional' && number.mode !== 'forward_all') return false
  if (number.verified_at) return false
  return !realCallReached(number, calls)
}
