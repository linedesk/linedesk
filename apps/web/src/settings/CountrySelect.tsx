// The country field, one for every place that sets the workspace's country: New workspace (the dialog and the first
// workspace's page), onboarding's Business step, Workspace settings › General and the prompt that asks to confirm a
// guessed country. Every country of the phone field (flags, common ones first); "Automatic (…)" first only where it is
// offered (Workspace settings).
import type { WorkspaceCountrySource } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useMemo } from 'react'
import { SearchSelect } from '../ui/SearchSelect.tsx'
import { countryOptions, searchCountries } from './workspaceLocaleModel.ts'

type Props = {
  id: string
  /** The country picked (ISO 3166-1 alpha-2); AUTOMATIC ('') for Automatic, or nothing picked yet. */
  value: string
  onChange: (country: string) => void
  disabled?: boolean
  /** Offer "Automatic", saying what it stands for now; left out: a country must be picked. */
  automatic?: { country: string; source: WorkspaceCountrySource }
}

export function CountrySelect({ id, value, onChange, disabled, automatic }: Props) {
  const t = useT()
  const automaticCountry = automatic?.country
  const automaticSource = automatic?.source
  const options = useMemo(
    () =>
      automaticCountry && automaticSource
        ? countryOptions(automaticCountry, automaticSource)
        : countryOptions('US', 'explicit').slice(1),
    [automaticCountry, automaticSource],
  )
  return (
    <SearchSelect
      id={id}
      label={t('settings.general.country.label')}
      value={value}
      options={options}
      search={searchCountries}
      placeholder={t('settings.general.country.search')}
      onChange={onChange}
      disabled={disabled}
      empty={t('settings.general.country.choose')}
    />
  )
}
