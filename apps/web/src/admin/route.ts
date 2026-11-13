// Where admin mode is: `#admin/<section>` and `#admin/<section>/<id>` (a workspace or a user).
// Kept in the hash like the rest of the app, so reload and the browser's Back work.
import { useEffect, useState } from 'react'

export const adminSections = [
  { id: 'overview', label: 'Overview', description: '' },
  { id: 'workspaces', label: 'Workspaces', description: '' },
  { id: 'users', label: 'Users', description: '' },
  { id: 'usage', label: 'Usage', description: 'Answered minutes per month, UTC.' },
  {
    id: 'onboarding',
    label: 'Onboarding',
    description: 'New workspaces on their way to their first real call, and who is stuck.',
  },
  { id: 'providers', label: 'Providers', description: '' },
  { id: 'branding', label: 'Branding', description: 'Your name and logo instead of Linedesk.' },
  { id: 'system', label: 'System', description: 'Set on the server.' },
  { id: 'audit', label: 'Audit log', description: 'Kept forever.' },
] as const
export type AdminSection = (typeof adminSections)[number]['id']
export type AdminPlace = { section: AdminSection; id: string | null }

const isSection = (value: string): value is AdminSection => adminSections.some(s => s.id === value)

/** `#admin`, `#admin/users`, `#admin/users/<id>`. Anything else in admin mode is the overview. */
export function parseAdminHash(hash: string): AdminPlace {
  const [, section = '', id = ''] = hash.replace(/^#/, '').split('?')[0]!.split('/')
  if (!isSection(section)) return { section: 'overview', id: null }
  return { section, id: id ? decodeURIComponent(id) : null }
}

export const adminHash = ({ section, id }: AdminPlace) => `#admin/${section}${id ? `/${encodeURIComponent(id)}` : ''}`

export function useAdminPlace() {
  const [place, setPlace] = useState(() => parseAdminHash(window.location.hash))
  useEffect(() => {
    const onHash = () => setPlace(parseAdminHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  /** A new history entry, so Back returns to the list or the previous section. */
  const go = (next: AdminPlace) => {
    window.location.hash = adminHash(next)
  }
  return { place, go }
}
