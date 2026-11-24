import type { Call, CallMissingInfo } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'
import { Badge } from '../ui/kit.tsx'

/** What a message or call back lacks for the team to act on it (the agent's after-call check, LIN-513). */
export const missingInfoOf = (call: Pick<Call, 'missing_info'>): CallMissingInfo[] => call.missing_info ?? []

/** The flag's word and its tooltip for one missing piece. */
export function missingInfoText(missing: CallMissingInfo, t = i18n().t): { label: string; title: string } {
  return missing === 'reason'
    ? { label: t('call.missingInfo.reason'), title: t('call.missingInfo.reasonTitle') }
    : { label: t('call.missingInfo.callbackNumber'), title: t('call.missingInfo.callbackNumberTitle') }
}

/**
 * Amber flags, one per missing piece (a warning: the team cannot act on the message as it is); nothing when none is
 * missing. `row`: the small chip of an inbox row; else a badge.
 */
export function MissingInfoFlags({ call, row }: { call: Pick<Call, 'missing_info'>; row?: boolean }) {
  const t = useT()
  return missingInfoOf(call).map(missing => {
    const { label, title } = missingInfoText(missing, t)
    return row ? (
      <span key={missing} className="r-sample r-missing" title={title}>
        {label}
      </span>
    ) : (
      <Badge key={missing} tone="warning" title={title}>
        {label}
      </Badge>
    )
  })
}
