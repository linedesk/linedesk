// The page a partner team invitation link opens (`#partner-invite=<token>`, docs/white-label.md), once signed in: the
// partner and the role, then Join. A new address gets its account with an email code on the sign-in page first (the
// invitation lets it in, apps/api/src/signup-gate.ts). The link only works for the address it was sent to.
import type { PartnerInvitationView } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { signOutAndForget } from '../localData.ts'
import { callAction } from '../settings/settings-api.ts'
import { Button } from '../ui/kit.tsx'
import { SignedInAuthPage } from '../shell/SignedInAuthPage.tsx'
import { partnerErrorText, refreshMyPartners } from './partner-api.ts'

type Props = {
  token: string
  /** Joined, or left the page: the app opens as it is now (the partner area after a join). */
  onDone: (joined: boolean) => void
}

export function PartnerInvite({ token, onDone }: Props) {
  const t = useT()
  const [view, setView] = useState<PartnerInvitationView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    callAction<PartnerInvitationView>('partnerInvitation.view', { token }).then(setView, err =>
      setProblem(partnerErrorText(err)),
    )
  }, [token])

  async function join() {
    setBusy(true)
    setProblem(null)
    try {
      await callAction('partnerInvitation.accept', { token })
      await refreshMyPartners()
      onDone(true)
    } catch (err) {
      setProblem(partnerErrorText(err))
      setBusy(false)
    }
  }

  const role = view?.role === 'owner' ? t('team.partner.role.owner') : t('team.partner.role.admin')
  return (
    <SignedInAuthPage install>
      <div className="auth-card">
        <h1>
          {view ? t('team.partner.invite.title', { partner: view.partnerName }) : t('team.partner.invite.loading')}
        </h1>
        {view?.state === 'open' && <p>{t('team.partner.invite.body', { partner: view.partnerName, role })}</p>}
        {view?.state === 'other_email' && <p>{t('team.partner.invite.otherEmail', { email: view.email })}</p>}
        {view?.state === 'member' && <p>{t('team.partner.invite.member', { partner: view.partnerName })}</p>}
        {problem && (
          <p className="k-field-msg" role="alert">
            {problem}
          </p>
        )}
        {view?.state === 'open' && (
          <Button variant="primary" busy={busy} onClick={() => void join()}>
            {t('team.partner.invite.join')}
          </Button>
        )}
        {view?.state === 'member' && (
          <Button variant="primary" onClick={() => onDone(true)}>
            {t('team.partner.invite.open')}
          </Button>
        )}
        {view?.state === 'other_email' ? (
          <button
            type="button"
            className="auth-switch"
            onClick={() => void signOutAndForget().then(() => onDone(false))}
          >
            {t('auth.differentAccount')}
          </button>
        ) : (
          <button type="button" className="auth-switch" onClick={() => onDone(false)}>
            {t('team.partner.invite.notNow')}
          </button>
        )}
      </div>
    </SignedInAuthPage>
  )
}
