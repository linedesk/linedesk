/**
 * The language list (Account › Preferences, the sign-in page's footer): Automatic first, naming what it resolves to,
 * then each language in its own name and in the current one ("Español · Spanish", languageLabel), with "Beta" until
 * a native speaker reviewed it.
 */
import {
  BETA_LOCALES,
  isUiLocale,
  languageLabel,
  matchLocale,
  PSEUDO_LOCALE,
  UI_LOCALES,
  type UiLocale,
} from '@linedesk/i18n'
import { useLocale, useT } from '@linedesk/i18n/react'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { browserLanguages } from './locale.ts'

export const AUTOMATIC = 'auto'
export type LanguageChoice = UiLocale | typeof AUTOMATIC | typeof PSEUDO_LOCALE

export function useLanguageOptions(withAutomatic: boolean): SelectOption<LanguageChoice>[] {
  const t = useT()
  const ui = useLocale()
  const auto = matchLocale(browserLanguages())
  const beta = t('common.language.beta')
  return [
    ...(withAutomatic
      ? [{ value: AUTOMATIC, label: t('common.language.automatic', { language: languageLabel(auto, ui) }) } as const]
      : []),
    ...UI_LOCALES.map(locale => ({
      value: locale,
      label: languageLabel(locale, ui),
      ...(BETA_LOCALES.includes(locale) ? { description: beta } : {}),
    })),
    // Development builds: accented, longer text shows what is not translated yet and what overflows.
    ...(import.meta.env.DEV ? [{ value: PSEUDO_LOCALE, label: t('common.language.pseudo') } as const] : []),
  ]
}

type Props = {
  value: LanguageChoice
  onChange: (value: LanguageChoice) => void
  withAutomatic: boolean
  id?: string
  size?: 'sm' | 'md'
  align?: 'start' | 'end'
  disabled?: boolean
}

export function LanguageSelect({ value, onChange, withAutomatic, id, size, align, disabled }: Props) {
  const t = useT()
  const options = useLanguageOptions(withAutomatic)
  return (
    <Select
      id={id}
      value={value}
      options={options}
      onChange={onChange}
      label={t('common.language.label')}
      size={size}
      align={align}
      disabled={disabled}
    />
  )
}

export const choiceOf = (locale: string | null | undefined): LanguageChoice => (isUiLocale(locale) ? locale : AUTOMATIC)
