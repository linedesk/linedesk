// US-only numbers (transfer contacts, the owner's mobile, the business number a forwarding check calls) typed in the
// phone field, whose value is E.164 as far as typed.
import { onCallNumberProblem, phoneNumberProblem } from '@linedesk/actions'
import { toE164, type WhoHearsDraft, type WhoHearsProblem } from './flow.ts'

/**
 * The number in E.164 when it is a US one, else null. A number with another country code is never read as a US
 * one (toE164 alone takes "+4930123456", ten digits, for +1 493 012 3456).
 */
export const usE164 = (typed: string): string | null => (/^\s*\+(?!1)/.test(typed) ? null : toE164(typed))

/**
 * What is wrong with the owner's mobile in "Who hears about calls?" (NotifyStep.tsx), for a value of the phone
 * field: unfinished says so for its country ("This number doesn't look complete for Germany."), another country's
 * number that it is not a US one. Otherwise the step's own problem.
 */
export function withUnfinishedNumber(draft: WhoHearsDraft, problem: WhoHearsProblem | null): WhoHearsProblem | null {
  const mobile = draft.mobile.trim()
  if (draft.urgent !== 'transfer' || !mobile.startsWith('+')) return problem
  const own = phoneNumberProblem(mobile) ?? (usE164(mobile) ? null : onCallNumberProblem(mobile))
  return own ? { field: 'mobile', message: own } : problem
}
