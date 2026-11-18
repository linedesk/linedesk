// The terms changed since a bill's owner last accepted them (LIN-420): asked once, in the app, with the links to the new
// texts. Accepting records it for every plan they own (account.acceptTerms). Later hides it for this session for this
// version; the next load asks again. Calls and billing go on either way.
import { T, useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import type { LegalTerms } from '../auth.ts'
import { callAction } from '../settings/settings-api.ts'
import { ExternalLink } from '../ui/AppLink.tsx'
import { Dialog, FormMessage } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'

const LATER_KEY = 'linedesk.termsUpdate.later'

/** Whether Later was chosen in this session for this terms version. */
export function laterChosenFor(version: string): boolean {
  try {
    return sessionStorage.getItem(LATER_KEY) === version
  } catch {
    return false
  }
}

function rememberLater(version: string) {
  try {
    sessionStorage.setItem(LATER_KEY, version)
  } catch {
    // Private mode: it asks again on the next load.
  }
}

/** The terms to ask about now: none, or a version Later was chosen for (in this tab or this session), ask nothing. */
export function termsToAsk(terms: LegalTerms | null, laterInTab: string | null): LegalTerms | null {
  if (!terms || laterInTab === terms.termsVersion || laterChosenFor(terms.termsVersion)) return null
  return terms
}

/** What the dialog says, with the links to both texts. */
export function TermsUpdateText({ terms }: { terms: LegalTerms }) {
  return (
    <p>
      <T
        k="shell.termsUpdate.text"
        values={{
          terms: chunks => <ExternalLink href={terms.termsUrl}>{chunks}</ExternalLink>,
          privacy: chunks => <ExternalLink href={terms.privacyUrl}>{chunks}</ExternalLink>,
        }}
      />
    </p>
  )
}

type Props = {
  /** `Me.termsUpdate`: the terms to accept, or null. */
  terms: LegalTerms | null
  /** After accepting, or when the terms changed again while open: `/v1/me` is read again. */
  onDone: () => void | Promise<void>
}

export function TermsUpdate({ terms, onDone }: Props) {
  const t = useT()
  const [later, setLater] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const asked = termsToAsk(terms, later)
  if (!asked) return null
  const version = asked.termsVersion

  function postpone() {
    rememberLater(version)
    setLater(version)
  }
  async function accept(e: FormEvent) {
    e.preventDefault()
    if (busy || !asked) return
    setBusy(true)
    setError(null)
    try {
      await callAction('account.acceptTerms', {
        termsVersion: asked.termsVersion,
        privacyVersion: asked.privacyVersion,
      })
      await onDone()
    } catch (err) {
      setBusy(false)
      // Changed again while open: the new links load, and the person reads them and accepts again.
      if ((err as { code?: string }).code === 'terms_changed') {
        setError(t('shell.termsUpdate.changed'))
        await onDone()
      } else setError(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <Dialog
      title={t('shell.termsUpdate.title')}
      size="sm"
      onClose={busy ? () => {} : postpone}
      onSubmit={accept}
      footer={
        <>
          <Button variant="ghost" onClick={postpone} disabled={busy}>
            {t('shell.termsUpdate.later')}
          </Button>
          <Button busy={busy} type="submit" variant="primary" disabled={busy}>
            {t('shell.termsUpdate.accept')}
          </Button>
        </>
      }
    >
      <TermsUpdateText terms={asked} />
      {error && <FormMessage>{error}</FormMessage>}
    </Dialog>
  )
}
