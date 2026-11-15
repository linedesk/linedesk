/**
 * The member's UI language (Account › Preferences › Language): their choice, or Automatic (null), which follows the
 * browser. Saved on their account like the name; what Automatic resolves to is saved too, so emails use it.
 */
import type { UiLocale } from '@linedesk/i18n'
import { useEffect } from 'react'
import { auth, type Me } from '../auth.ts'
import { activate, i18n, languageFromAddress, localeFor } from './index.tsx'

/** Follows the signed-in member's language; tells the server what Automatic resolved to when that changed. */
export function useMemberLocale(me: Me | null) {
  const choice = me?.locale
  const knownAuto = me?.localeAuto
  const impersonating = Boolean(me?.impersonation)
  const signedIn = Boolean(me)
  useEffect(() => {
    if (!signedIn) return
    const { locale, auto } = localeFor(choice)
    void activate(locale, { remember: !languageFromAddress() })
    // Fire and forget: only the emails' language depends on it.
    if (choice == null && !impersonating && auto !== knownAuto)
      void auth.updateUser({ localeAuto: auto }).catch(() => {})
  }, [signedIn, choice, knownAuto, impersonating])
}

/** Saves the member's choice (null: Automatic) and shows it at once. */
export async function chooseLocale(choice: UiLocale | null) {
  const { locale, auto } = localeFor(choice)
  const result = await auth.updateUser({ locale: choice, localeAuto: auto })
  if (result.error) throw new Error(result.error.message || i18n().t('account.language.saveFailed'))
  await activate(locale)
}
