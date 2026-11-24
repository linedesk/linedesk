// While a new workspace is made: a quiet line that says what is happening, so a few seconds of waiting
// never look stuck. The spinner is in the button; this line only says what it waits for.
// Used by "New workspace…" and the "Name your business" page.
import { useEffect, useState } from 'react'
import { useT } from '@linedesk/i18n/react'

/** `creating`: the request runs. `opening`: the workspace exists, the app loads into it. */
export type CreatingPhase = 'idle' | 'creating' | 'opening'

/** A quick answer shows nothing extra: the line appears only after this long. */
const QUIET_MS = 800

export function CreatingStatus({ phase, name }: { phase: CreatingPhase; name: string }) {
  const t = useT()
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (phase === 'idle') return setShown(false)
    const timer = setTimeout(() => setShown(true), QUIET_MS)
    return () => clearTimeout(timer)
  }, [phase])
  if (phase === 'idle' || !shown) return null
  return (
    <p className="ws-creating" role="status" aria-live="polite">
      {phase === 'creating' ? t('auth.create.creating', { name }) : t('shell.boot.opening', { name })}
    </p>
  )
}
