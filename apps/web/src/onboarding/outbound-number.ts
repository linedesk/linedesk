// Numbers Linedesk calls out to (transfer contacts, the owner's mobile, the business number a forwarding check calls)
// typed in the phone field, whose value is E.164 as far as typed; checked against the countries the workspace may call
// (outbound.countries, packages/actions/src/outbound.ts).
import { type OutboundCountries, type OutboundCountriesView, phoneNumberProblem } from '@linedesk/actions'
import { useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { readAction } from '../settings/settings-api.ts'
import type { WhoHearsDraft, WhoHearsProblem } from './flow.ts'

/**
 * What is wrong with the owner's mobile in the "Urgent calls" step (NotifyStep.tsx), for a value of the phone
 * field: unfinished says so for its country ("This number doesn't look complete for Canada."). Otherwise the step's
 * own problem (whoHearsProblem, which knows the countries the workspace may call).
 */
export function withUnfinishedNumber(draft: WhoHearsDraft, problem: WhoHearsProblem | null): WhoHearsProblem | null {
  const mobile = draft.mobile.trim()
  if (draft.urgent !== 'transfer' || !mobile.startsWith('+')) return problem
  const own = phoneNumberProblem(mobile, i18n())
  return own ? { field: 'mobile', message: own } : problem
}

const KEY = 'outbound.countries'
const loadCountries = async () => readAction<OutboundCountriesView>(KEY, {})

/**
 * The countries this workspace may call: its numbers' plus the install's. `any` while it has no number or before the
 * answer came (the server checks again on save and on every dial).
 */
export function useOutboundCountries(): OutboundCountries {
  const countries = useQuery(KEY, loadCountries).data?.countries
  return countries ?? 'any'
}
