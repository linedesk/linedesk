// For an instance admin on a fresh install: onboarding says which provider groups a call needs are still missing or
// failing (GET /v1/admin/setup-checklist, the same status as Admin › Providers) and links to Admin › Providers.
import { listWords } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import { loadSetupChecklist } from '../admin/api.ts'
import type { Me } from '../auth.ts'
import { useQuery } from '../cachedQuery.ts'

/** Cache key of the server's group status (onboarding's notice). */
const SETUP_STATUS = 'admin.setupStatus'

export const isInstanceAdmin = (me: Me) => me.permissions.includes('instance:admin')

/** The address bar's hash, kept up to date. */
export function useHash() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

/**
 * "This server has no phone carrier yet.": only while a group calls need is missing or something fails; nothing for
 * everyone else. A failed read says so and offers to try again instead of hiding the notice.
 */
export function InstanceSetupNotice() {
  const { data, error, reload } = useQuery(SETUP_STATUS, () => loadSetupChecklist())
  const link = (
    <a href="#admin/providers" title="Admin › Providers: every provider with its status, steps and a test">
      Open Providers
    </a>
  )
  if (!data)
    return error ? (
      <p className="ob-instance" role="alert">
        Could not check this server’s setup.{' '}
        <button type="button" className="k-link" onClick={() => void reload()} title="Check the setup again">
          Try again
        </button>{' '}
        or {link}.
      </p>
    ) : null
  const missing = data.groups
    .filter(g => g.needed && (g.state === 'missing' || g.state === 'partly'))
    .map(g => g.label.toLowerCase())
  const failing = data.groups.filter(g => g.state === 'failing').map(g => g.label.toLowerCase())
  if (!missing.length && !failing.length) return null
  return (
    <p className="ob-instance" role="note">
      {missing.length > 0 && `This server has no ${listWords(missing, 'or')} yet. `}
      {failing.length > 0 && `${capitalize(listWords(failing))} ${failing.length > 1 ? 'are' : 'is'} failing. `}
      {link}
    </p>
  )
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
