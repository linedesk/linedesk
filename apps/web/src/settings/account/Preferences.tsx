/**
 * Account › Preferences › Language (docs/translations.md, "Levels"): the member's own UI language, Automatic by
 * default. When the browser's first language is one Linedesk doesn't have, a note offers to ask for it.
 */
import { PSEUDO_LOCALE } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { brandName } from '../../brand.ts'
import { activate } from '../../i18n/index.tsx'
import { AUTOMATIC, choiceOf, type LanguageChoice, LanguageSelect } from '../../i18n/LanguageSelect.tsx'
import { browserLanguages, missingBrowserLanguage } from '../../i18n/locale.ts'
import { chooseLocale } from '../../i18n/user.ts'
import { Button, Note } from '../../ui/kit.tsx'
import { Field, Section } from '../fields.tsx'

const DISMISSED_KEY = 'linedesk.languageNoteDismissed'
/** Where people ask for a new language: the issue form, with the language filled in. */
export const LANGUAGE_REQUEST_URL = 'https://github.com/linedesk/linedesk/issues/new?template=language_request.yml'

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

/** The language's own name ("Italiano" for it-IT), else the tag. */
function ownName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag)
    return name ? name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) : tag
  } catch {
    return tag
  }
}

/** "Linedesk isn't available in Italiano yet. Ask for it", once per browser until dismissed. */
function MissingLanguageNote() {
  const t = useT()
  const missing = missingBrowserLanguage(browserLanguages())
  const [dismissed, setDismissed] = useState(readDismissed)
  if (!missing || dismissed === missing) return null
  const language = ownName(missing)
  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, missing)
    } catch {
      // Private mode: it shows again next time.
    }
    setDismissed(missing)
  }
  const url = `${LANGUAGE_REQUEST_URL}&language=${encodeURIComponent(`${language} (${missing})`)}`
  return (
    <Note
      tone="info"
      action={
        <Button size="sm" variant="ghost" onClick={dismiss}>
          {t('account.language.dismiss')}
        </Button>
      }
    >
      {t('account.language.missing', { brand: brandName(), language })}{' '}
      <a href={url} target="_blank" rel="noopener noreferrer">
        {t('account.language.ask')}
      </a>
    </Note>
  )
}

/** `saved`: reloads the account, so the choice shows when the section opens again. */
export function Preferences({ locale, saved }: { locale: string | null | undefined; saved: () => void }) {
  const t = useT()
  const [choice, setChoice] = useState<LanguageChoice>(() => choiceOf(locale))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pick = async (next: LanguageChoice) => {
    const before = choice
    setChoice(next)
    setError(null)
    // The pseudo-locale (development only) is for this browser, never saved on the account.
    if (next === PSEUDO_LOCALE) return activate(PSEUDO_LOCALE, { remember: false })
    setBusy(true)
    try {
      await chooseLocale(next === AUTOMATIC ? null : next)
      saved()
    } catch {
      setChoice(before)
      setError(t('account.language.saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section id="ac-preferences" title={t('account.nav.preferences.label')}>
      <MissingLanguageNote />
      <Field
        id="ac-language"
        label={t('common.language.label')}
        help={t('account.language.help', { brand: brandName() })}
      >
        <LanguageSelect
          id="ac-language"
          value={choice}
          onChange={next => void pick(next)}
          withAutomatic
          disabled={busy}
        />
      </Field>
      {error && <Note tone="danger">{error}</Note>}
    </Section>
  )
}
