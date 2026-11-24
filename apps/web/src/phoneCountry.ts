// The country a phone field starts with (PhoneInput's defaultCountry): the workspace's country as the API works it out
// (workspace.getSettings, workspace-locale.ts: the same order as Workspace settings › General and the voice agent).
import { useMemo } from 'react'
import { browserPlace, phoneCountryFrom } from './countryHint.ts'
import { useWorkspaceSettings } from './settings/settings-api.ts'
import { useAssistant, useRows } from './store.tsx'

/** The phone field's starting country; follows the workspace settings once they load. */
export function useDefaultPhoneCountry(): string {
  const numbers = useRows('phone_numbers')
  const assistantNumber = useMemo(
    () => [...numbers].sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.e164 ?? null,
    [numbers],
  )
  const settings = useWorkspaceSettings().data
  const businessPhone = useAssistant()?.business_profile.phone ?? null
  return phoneCountryFrom(settings, { assistantNumber, businessPhone, ...browserPlace() })
}
