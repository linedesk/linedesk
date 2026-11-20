// The "Start your free trial" link (trialLink.ts): the owner of a workspace waiting for its trial
// lands right in the Start your free trial dialog, over whatever the setup shows, with the interval the link names
// preselected, so nobody has to look for the row. Someone who cannot start it reads who can. A trial or plan that
// runs already: Settings › Billing opens as the link says, with a short note there (Billing.tsx). The link's flag is
// taken out of the address at once.
import { useFormat, useT } from '@linedesk/i18n/react'
import { useEffect, useRef, useState } from 'react'
import type { Me } from '../auth.ts'
import { useMembers } from '../team/members.ts'
import { markAlreadyRunning, readTrialLink, takeTrialLink } from '../trialLink.ts'
import { Dialog } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { StartTrialDialog } from './SetupRowActions.tsx'

type Request = { kind: 'start'; interval: 'month' | 'year' | null } | { kind: 'notOwner' }

/** What the link in `hash` asks of this member; null when it is no trial link or nothing is to open here. */
export function trialLinkRequest(me: Me, hash: string): Request | null {
  const found = readTrialLink(hash)
  if (!found || me.workspace?.billingState !== 'pending_payment') return null
  // The activation facts come only to whoever may start it (the bill's owner, or who manages it).
  return me.workspace.activation ? { kind: 'start', interval: found.interval } : { kind: 'notOwner' }
}

/** Takes the link out of the address: a waiting workspace has no Settings page yet, so the app's start instead. */
function takeLink(me: Me) {
  takeTrialLink(me.workspace?.billingState === 'pending_payment' ? '' : undefined)
}

export function TrialLink({ me, byHand, onTermsChanged }: { me: Me; byHand: boolean; onTermsChanged: () => void }) {
  const [request, setRequest] = useState<Request | null>(() => {
    // A trial or plan that runs: Settings › Billing says so once. Marked while rendering, before the page under this
    // renders (it may come from the local cache at once); setting the mark twice is harmless.
    if (readTrialLink(window.location.hash) && me.workspace?.billingState !== 'pending_payment') markAlreadyRunning()
    return trialLinkRequest(me, window.location.hash)
  })
  const meNow = useRef(me)
  meNow.current = me
  useEffect(() => {
    takeLink(meNow.current)
    // Opened again in this tab (only the hash changes): read it again.
    const follow = () => {
      const next = trialLinkRequest(meNow.current, window.location.hash)
      if (readTrialLink(window.location.hash) && meNow.current.workspace?.billingState !== 'pending_payment')
        markAlreadyRunning()
      takeLink(meNow.current)
      if (next) setRequest(next)
    }
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  const activation = me.workspace?.activation
  if (!request) return null
  const close = () => setRequest(null)
  if (request.kind === 'notOwner') return <NotOwner onClose={close} />
  // The trial started meanwhile (another tab): nothing to start here.
  if (!activation || me.workspace?.billingState !== 'pending_payment') return null
  return (
    <StartTrialDialog
      me={me}
      activation={activation}
      onTermsChanged={onTermsChanged}
      onClose={close}
      interval={request.interval}
      byHand={byHand}
    />
  )
}

/** A member who cannot start the trial: who can (the workspace's owners), and nothing to do here. */
function NotOwner({ onClose }: { onClose: () => void }) {
  const t = useT()
  const format = useFormat()
  const owners = useMembers()
    .filter(m => m.role === 'owner' && !m.disabled)
    .map(m => m.name)
  return (
    <Dialog
      title={t('onboarding.trialLink.title')}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common.action.close')}
        </Button>
      }
    >
      <p>
        {owners.length
          ? t('onboarding.trialLink.notOwner', { names: format.list(owners), count: owners.length })
          : t('onboarding.trialLink.notOwnerUnknown')}
      </p>
    </Dialog>
  )
}
