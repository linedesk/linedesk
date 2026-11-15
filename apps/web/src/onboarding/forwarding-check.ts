// What the owner sees after a forwarding check (onboarding concept, 6c): one line on what happened and the one
// next thing to try. The check itself runs on the server (phoneNumber.checkForwarding).
import { type ForwardingCheckView, isRealCall, type LineLookupData } from '@linedesk/actions'
import type { Call, PhoneNumber } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { brandName } from '../brand.ts'
import { i18n } from '../i18n/index.tsx'

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
  const { t } = i18n()
  // Which calls the texts speak of: every call to the business number, or the ones nobody answers.
  const calls = forwardsAll ? 'all' : 'missed'
  switch (check.status) {
    case 'dialing':
      return { title: t('onboarding.forwardingCheck.dialing'), next: null, ok: false }
    case 'works':
      // Nothing was dialled (development carrier): never "verified", never the green of a real result.
      if (check.simulated)
        return { title: t('onboarding.forwardingCheck.simulated', { calls, assistant }), next: null, ok: false }
      return {
        title: check.ringSeconds
          ? t('onboarding.forwardingCheck.verifiedAfter', { calls, assistant, seconds: check.ringSeconds })
          : t('onboarding.forwardingCheck.verified', { calls, assistant }),
        next: null,
        ok: true,
      }
    case 'rang_through':
      return {
        title: t('onboarding.forwardingCheck.rangThrough'),
        next: forwardsAll
          ? t('onboarding.forwardingCheck.rangThroughNextAll')
          : t('onboarding.forwardingCheck.rangThroughNext'),
        ok: false,
        fixes: forwardsAll ? undefined : ['forward_all', 'new'],
      }
    case 'answered':
      return {
        title: t('onboarding.forwardingCheck.answered'),
        next: t('onboarding.forwardingCheck.answeredNext'),
        ok: false,
      }
    case 'busy':
      return { title: t('onboarding.forwardingCheck.busy'), next: t('onboarding.forwardingCheck.busyNext'), ok: false }
    case 'forwards_elsewhere':
      return {
        title: t('onboarding.forwardingCheck.forwardsElsewhere'),
        next: check.detail
          ? t('onboarding.forwardingCheck.forwardsElsewhereNextDetail', { detail: check.detail })
          : t('onboarding.forwardingCheck.forwardsElsewhereNext'),
        ok: false,
      }
    case 'no_assistant':
      return {
        title: t('onboarding.forwardingCheck.noAssistant', { assistant }),
        next: t('onboarding.forwardingCheck.noAssistantNext', { brand: brandName() }),
        ok: false,
      }
    case 'unreachable':
      return {
        title: t('onboarding.forwardingCheck.unreachable'),
        next: t('onboarding.forwardingCheck.unreachableNext'),
        ok: false,
      }
    default:
      return {
        title: t('onboarding.forwardingCheck.notChecked'),
        next: check.detail
          ? t('onboarding.forwardingCheck.notCheckedNextDetail', { detail: check.detail, assistant })
          : t('onboarding.forwardingCheck.notCheckedNext', { assistant }),
        ok: false,
      }
  }
}

/** What the owner sees instead of "Check forwarding" when this server cannot run a check. */
export const noCheckText = (assistant: string) => i18n().t('onboarding.forwardingCheck.noCheck', { assistant })

/** The quiet marker next to a carrier lookup or a check result made up by the development carrier. */
export const simulatedMark = () => i18n().t('onboarding.forwardingCheck.simulatedMark')

const lineTypeText: Record<LineLookupData['lineType'], MessageKey | null> = {
  mobile: msg('onboarding.forwardingCheck.lineType.mobile'),
  landline: msg('onboarding.forwardingCheck.lineType.landline'),
  voip: msg('onboarding.forwardingCheck.lineType.voip'),
  toll_free: msg('onboarding.forwardingCheck.lineType.tollFree'),
  unknown: null,
}

/** "Verizon Wireless · mobile", or null when the lookup found nothing worth showing. */
export function lineText(found: LineLookupData): string | null {
  const type = lineTypeText[found.lineType]
  const parts = [found.carrier, type && i18n().t(type)].filter(Boolean)
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

export type ForwardedCall = Pick<
  Call,
  'source' | 'direction' | 'from_own_number' | 'outcome' | 'to_number' | 'started_at'
>

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
