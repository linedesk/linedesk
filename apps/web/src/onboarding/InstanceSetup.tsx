// For an instance admin on a fresh install: onboarding says which parts of the install are still missing and
// opens the setup checklist (Admin, Overview) in place, since onboarding covers the whole app until it is done.
import { useEffect, useState } from 'react'
import { ADMIN_SETUP_CHECKLIST, loadSetupChecklist } from '../admin/api.ts'
import type { Me } from '../auth.ts'
import { useQuery } from '../cachedQuery.ts'

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

/** "a, b or c" */
const listOf = (words: readonly string[], last: 'or' | 'and') =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} ${last} ${words.at(-1)}`

/**
 * "This server has no phone carrier yet.": only while a part is missing or failing; nothing for everyone else. A
 * failed read says so and offers to try again instead of hiding the notice.
 */
export function InstanceSetupNotice() {
  const { data, error, reload } = useQuery(ADMIN_SETUP_CHECKLIST, () => loadSetupChecklist())
  const link = (
    <a href="#admin" title="Admin › Overview: the steps for each part and a test">
      Open the setup checklist
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
  if (data.complete) return null
  const missing = data.items.filter(i => i.state === 'missing').map(i => i.label.toLowerCase())
  // LIN-111: name the reason of a failing part (providerFailureReasonLabels[reason]) once the checklist items carry
  // the recorded failure of GET /v1/admin/providers (`failures`); until then the state alone says it.
  const failing = data.items.filter(i => i.state === 'failing').map(i => i.label.toLowerCase())
  if (!missing.length && !failing.length) return null
  return (
    <p className="ob-instance" role="note">
      {missing.length > 0 && `This server has no ${listOf(missing, 'or')} yet. `}
      {failing.length > 0 && `${capitalize(listOf(failing, 'and'))} ${failing.length > 1 ? 'are' : 'is'} failing. `}
      {link}
    </p>
  )
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
