// Where admin mode is: `#admin/<section>` and `#admin/<section>/<id>` (a workspace or a user).
// Kept in the hash like the rest of the app, so reload and the browser's Back work.
import { useEffect, useState } from 'react'

export const adminSections = [
  {
    id: 'overview',
    label: 'Overview',
    description: 'How this install is used, roughly what it costs, and whether its parts work.',
  },
  { id: 'workspaces', label: 'Workspaces', description: 'Every business on this install.' },
  { id: 'users', label: 'Users', description: 'Everyone with an account, in any workspace.' },
  {
    id: 'usage',
    label: 'Usage',
    description: 'Answered minutes per month, from the length of each call. Months are in UTC.',
  },
  {
    id: 'providers',
    label: 'Providers',
    description:
      'Keys for telephony, speech, the language model and where recordings are stored, for the whole install.',
  },
  {
    id: 'system',
    label: 'System',
    description: 'Services that are part of this install. They are set up in the environment.',
  },
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
