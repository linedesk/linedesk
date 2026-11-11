// LiveKit is part of the install: its keys are set in env at install time, so this is a
// read-only status, loaded on its own because a server that is down takes seconds to say so.
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Card } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import { type LivekitStatus, loadLivekitStatus, type ServiceStatus } from './api.ts'

const LIVEKIT = 'admin.livekit'

function Service({ name, status }: { name: string; status: ServiceStatus | null }) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        <span
          className={cx('adm-tile-status', status && (status.ok ? 'adm-dot-muted' : 'adm-dot-danger'))}
          title={status?.message}
        >
          {!status ? 'Checking…' : status.ok ? status.message : `Problem: ${status.message}`}
        </span>
      </dd>
    </div>
  )
}

export function System() {
  const query = useQuery(LIVEKIT, loadLivekitStatus)
  const status = query.data ?? null
  const error = status ? null : query.error
  const check = () => {
    setQueryData<LivekitStatus | undefined>(LIVEKIT, undefined) // a check the operator asked for shows as checking
    return query.reload()
  }

  return (
    <Card
      title="LiveKit"
      description="Voice and phone calls."
      actions={
        <Button size="sm" variant="ghost" disabled={!status && !error} onClick={() => void check()}>
          {!status && !error ? 'Checking…' : 'Check again'}
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
            <dd className="adm-mono">{status ? (status.url ?? 'Not set') : '…'}</dd>
          </div>
          <Service name="Server" status={status?.server ?? null} />
          <Service name="SIP trunks" status={status?.sip ?? null} />
        </dl>
      )}
    </Card>
  )
}
