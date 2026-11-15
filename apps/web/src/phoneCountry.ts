// The country a phone field starts with (PhoneInput's defaultCountry): the workspace's country, else the browser's.
import { defaultPhoneCountry } from '@linedesk/actions'
import { useMemo } from 'react'
import { useWorkspaceSettings } from './settings/settings-api.ts'
import { browserLocale } from './ui/phoneInputModel.ts'
import { useAssistant, useRows } from './store.tsx'

/**
 * The country set in Workspace settings › General, else the country of the number the assistant answers (the
 * oldest), else the workspace's holiday calendar country, else the business phone's (when written with its country
 * code), else the browser's locale, else the US. Follows the workspace settings once they load.
 */
export function useDefaultPhoneCountry(): string {
  const numbers = useRows('phone_numbers')
  const assistantNumber = useMemo(
    () => [...numbers].sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.e164 ?? null,
    [numbers],
  )
  const settings = useWorkspaceSettings().data
  const businessNumber = useAssistant()?.business_profile.phone ?? null
  return defaultPhoneCountry({
    country: settings?.country ?? null,
    assistantNumber,
    workspaceCountry: settings?.holidays?.country ?? null,
    businessNumber,
    locale: browserLocale(),
  })
}
