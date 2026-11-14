// System: LiveKit, part of the install (its keys are set in env at install time, so this is a
// read-only status, loaded on its own because a server that is down takes seconds to say so), and
// whether workspaces may clone voices (off until an instance admin turns it on).
import type { VoiceCloningData } from '@linedesk/actions'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Switch } from '../ui/controls.tsx'
import { Card } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type LivekitStatus, loadLivekitStatus, runAdmin, type ServiceStatus } from './api.ts'
import { brandName } from '../brand.ts'

const LIVEKIT = 'admin.livekit'

function Service({ name, status }: { name: string; status: ServiceStatus | null }) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        <span className={cx('adm-tile-status', status && !status.ok && 'adm-status-bad')}>
          <StatusMark state={!status ? 'checking' : status.ok ? 'works' : 'failing'} label={status?.message} />
          {!status ? 'Checking…' : status.ok ? status.message : `Problem: ${status.message}`}
        </span>
      </dd>
    </div>
  )
}

function Livekit() {
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
          {asked ? 'Checking…' : 'Check again'}
        </Button>
      }
    >
      {error ? (
        <p className="k-field-msg" role="alert">
          Could not check: {error}
        </p>
      ) : (
        <dl className="adm-facts" aria-live="polite">
          <div>
            <dt>URL</dt>
            <dd className="adm-mono">
              {status ? (
                (status.url ?? 'Not set')
              ) : (
                <Loading what="The URL" loading skeleton={<Skeleton shape="text" width={180} />} />
              )}
            </dd>
          </div>
          <Service name="Server" status={status?.server ?? null} />
          <Service name="SIP trunks" status={status?.sip ?? null} />
        </dl>
      )}
    </Card>
  )
}

const CLONING = 'admin.voiceCloning'
const loadCloning = async () => (await runAdmin('voiceCloning.get', {})) as VoiceCloningData

/** Voice cloning for every workspace: off by default; existing clones keep working when it is turned off. */
function VoiceCloning() {
  const query = useQuery(CLONING, loadCloning)
  const [problem, setProblem] = useState<string | null>(null)
  const on = query.data?.on ?? false
  async function change(next: boolean) {
    setProblem(null)
    setQueryData<VoiceCloningData | undefined>(CLONING, { on: next })
    try {
      await runAdmin('voiceCloning.set', { on: next })
    } catch (e) {
      setQueryData<VoiceCloningData | undefined>(CLONING, { on: !next })
      setProblem(e instanceof Error ? e.message : 'Could not change voice cloning.')
    }
  }
  return (
    <Card
      title="Voice cloning"
      help={`Lets workspaces create a voice from a recording of a real person, who must have agreed to it; ${brandName()} keeps who confirmed that and when. Turning this off stops new clones, but existing ones keep working.`}
    >
      <div className="swrow">
        <div>
          <b>Allow voice cloning</b>
        </div>
        <Loading
          what="Voice cloning"
          loading={!query.data}
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<Skeleton width={34} height={20} className="sk-round" />}
        >
          <Switch on={on} onChange={v => void change(v)} label="Allow voice cloning" disabled={!query.data} />
        </Loading>
      </div>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </Card>
  )
}

export function System() {
  return (
    <>
      <Livekit />
      <VoiceCloning />
    </>
  )
}
