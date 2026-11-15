// For an instance admin on a fresh install: onboarding says which provider groups a call needs are still missing or
// failing (GET /v1/admin/setup-checklist, the same status as Server admin › Providers) and links to Server admin ›
// Providers.
import { T, useFormat, useT } from '@linedesk/i18n/react'
import { AppLink, appLink, LinkButton } from '../ui/AppLink.tsx'
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
  const t = useT()
  const format = useFormat()
  const { data, error, reload } = useQuery(SETUP_STATUS, () => loadSetupChecklist())
  const link = (
    <AppLink to="#admin/providers" title={t('onboarding.instance.openTip')}>
      {t('onboarding.instance.open')}
    </AppLink>
  )
  if (!data)
    return error ? (
      <p className="ob-instance" role="alert">
        <T
          k="onboarding.instance.checkFailed"
          values={{
            retry: chunks => (
              <LinkButton onClick={() => void reload()} title={t('onboarding.instance.retryTip')}>
                {chunks}
              </LinkButton>
            ),
            link: appLink('#admin/providers', { title: t('onboarding.instance.openTip') }),
          }}
        />
      </p>
    ) : null
  // The group names come from the server (English, like Server admin › Providers).
  const missing = data.groups
    .filter(g => g.needed && (g.state === 'missing' || g.state === 'partly'))
    .map(g => g.label.toLowerCase())
  const failing = data.groups.filter(g => g.state === 'failing').map(g => g.label.toLowerCase())
  if (!missing.length && !failing.length) return null
  return (
    <p className="ob-instance" role="note">
      {missing.length > 0 &&
        `${t('onboarding.instance.missing', { groups: format.list(missing, { type: 'disjunction' }) })} `}
      {failing.length > 0 &&
        `${t('onboarding.instance.failing', { groups: capitalize(format.list(failing)), count: failing.length })} `}
      {link}
    </p>
  )
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
