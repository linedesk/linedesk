// Server admin › Server (LIN-693): the server's own state, read-only. LiveKit and its SIP bridge are part of the
// install (their keys are set in env at install time), so this is a status, loaded on its own because a server that is
// down takes seconds to say so; while call audio does not work, the steps to set it up are under it. Settings that were
// under System are under Settings, Branding and Onboarding now (SettingsCards.tsx).
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Card } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type LivekitStatus, loadLivekitStatus, type ServiceStatus } from './api.ts'
import { CallAudioGuide } from './ProviderGroup.tsx'
import type { ProviderStatusState } from './providerStatus.ts'

const LIVEKIT = 'admin.livekit'

function Service({ name, status }: { name: string; status: ServiceStatus | null }) {
  const t = useT()
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        <span className={cx('adm-tile-status', status && !status.ok && 'adm-status-bad')}>
          <StatusMark state={!status ? 'checking' : status.ok ? 'works' : 'failing'} label={status?.message} />
          {!status
            ? t('admin.system.checking')
            : status.ok
              ? status.message
              : t('admin.system.problem', { message: status.message })}
        </span>
      </dd>
    </div>
  )
}

function Livekit() {
  const t = useT()
  const query = useQuery(LIVEKIT, loadLivekitStatus)
  const status = query.data ?? null
  const error = status ? null : query.error
  /** The operator pressed Check again: only then does the button spin (page data never does). */
  const [asked, setAsked] = useState(false)
  const check = async () => {
    setAsked(true)
    setQueryData<LivekitStatus | undefined>(LIVEKIT, undefined) // a check the operator asked for shows as checking
    try {
      await query.reload()
    } finally {
      setAsked(false)
    }
  }

  return (
    <Card
      title="LiveKit"
      actions={
        <Button busy={asked} size="sm" variant="ghost" disabled={!status && !error} onClick={() => void check()}>
          {asked ? t('admin.system.checking') : t('admin.system.checkAgain')}
        </Button>
      }
    >
      {error ? (
        <p className="k-field-msg" role="alert">
          {t('admin.system.couldNotCheck', { error })}
        </p>
      ) : (
        <dl className="adm-facts" aria-live="polite">
          <div>
            <dt>{t('admin.system.url')}</dt>
            <dd className="adm-mono">
              {status ? (
                (status.url ?? t('admin.system.notSet'))
              ) : (
                <Loading what={t('admin.system.urlWhat')} loading skeleton={<Skeleton shape="text" width={180} />} />
              )}
            </dd>
          </div>
          <Service name={t('admin.system.server')} status={status?.server ?? null} />
          <Service name={t('admin.system.sipTrunks')} status={status?.sip ?? null} />
        </dl>
      )}
    </Card>
  )
}

export function Server({ status }: { status: ProviderStatusState }) {
  const t = useT()
  const callAudio = status.status?.groups.find(g => g.id === 'call-audio')
  return (
    <>
      <Livekit />
      {callAudio && callAudio.state !== 'works' && (
        <Card title={t('admin.server.callAudioTitle')}>
          <CallAudioGuide open={callAudio.state === 'missing'} />
        </Card>
      )}
    </>
  )
}
