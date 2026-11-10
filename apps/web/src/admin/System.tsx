// LiveKit is part of the install: its keys are set in env at install time, so this is a
// read-only status, loaded on its own because a server that is down takes seconds to say so.
import { useCallback, useEffect, useState } from 'react'
import { Section } from '../settings/fields.tsx'
import { Button } from '../ui/kit.tsx'
import { type LivekitStatus, loadLivekitStatus, type ServiceStatus } from './api.ts'

function Service({ name, status }: { name: string; status: ServiceStatus | null }) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        {!status ? (
          'Checking…'
        ) : status.ok ? (
          status.message
        ) : (
          <>
            <b>Problem.</b> {status.message}
          </>
        )}
      </dd>
    </div>
  )
}

export function System() {
  const [status, setStatus] = useState<LivekitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const check = useCallback(async () => {
    setStatus(null)
    setError(null)
    try {
      setStatus(await loadLivekitStatus())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])
  useEffect(() => void check(), [check])

  return (
    <Section
      id="adm-system"
      title="System"
      description="Services that are part of this install. They are set up in the environment, not here."
    >
      <div className="adm-prov">
        <div className="adm-prov-head">
          <b>LiveKit</b>
          <span className="adm-prov-actions">
            <Button size="sm" variant="ghost" disabled={!status && !error} onClick={() => void check()}>
              Check again
            </Button>
          </span>
        </div>
        {error ? (
          <p className="adm-test" role="alert">
            Could not check: {error}
          </p>
        ) : (
          <dl className="adm-prov-fields" aria-live="polite">
            <div>
              <dt>URL</dt>
              <dd className="adm-mono">{status ? (status.url ?? 'Not set') : '…'}</dd>
            </div>
            <Service name="Server" status={status?.server ?? null} />
            <Service name="SIP trunks" status={status?.sip ?? null} />
          </dl>
        )}
      </div>
    </Section>
  )
}
