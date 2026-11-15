// Where admin mode is: `#admin/<section>` and `#admin/<section>/<id>` (a workspace, a user, or on Providers a group
// or a provider).
// Kept in the hash like the rest of the app, so reload and the browser's Back work.
import {
  groupOfCategory,
  isProviderGroupId,
  type ProviderCategory,
  providerCategories,
  type ProviderGroupId,
  type ProviderName,
  providers as providerRegistry,
} from '@linedesk/actions'
import { useEffect, useState } from 'react'

export const adminSections = [
  { id: 'overview', label: 'Overview', description: '' },
  { id: 'workspaces', label: 'Workspaces', description: 'Every workspace on this server.' },
  { id: 'users', label: 'Users', description: 'Everyone who can sign in.' },
  { id: 'usage', label: 'Usage', description: 'Calls and costs per workspace.' },
  {
    id: 'onboarding',
    label: 'Onboarding',
    description: 'New workspaces on their way to their first real call, and who is stuck.',
  },
  { id: 'providers', label: 'Providers', description: '' },
  { id: 'branding', label: 'Branding', description: 'Your name and logo instead of Linedesk.' },
  { id: 'system', label: 'System', description: 'Set on the server.' },
  { id: 'audit', label: 'Audit log', description: 'Who changed what, newest first.' },
] as const
export type AdminSection = (typeof adminSections)[number]['id']
export type AdminPlace = { section: AdminSection; id: string | null }

/** The section after `section` (Tab) or before it (⇧Tab), going round. */
export function nextSection(section: AdminSection, back: boolean): AdminSection {
  const at = adminSections.findIndex(s => s.id === section)
  return adminSections[(at + (back ? adminSections.length - 1 : 1)) % adminSections.length]!.id
}

/**
 * Tab switches sections only while focus is on the page itself (nothing focused: the body). On a field, button, link,
 * menu or dialog it moves focus as in any page, the inbox's rule too (decision Q11).
 */
export const tabSwitchesSection = (active: Element | null) =>
  !active || active === active.ownerDocument.body || active === active.ownerDocument.documentElement

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

/** What `#admin/providers/<id>` points at: a group to scroll to, or a provider whose dialog opens. */
export function providersTarget(id: string | null): { group: ProviderGroupId } | { provider: ProviderName } | null {
  if (!id) return null
  if (isProviderGroupId(id)) return { group: id }
  if (id in providerRegistry) return { provider: id as ProviderName }
  if (id in providerCategories) return { group: groupOfCategory(id as ProviderCategory) }
  // Links from before the groups: the setup checklist's parts.
  if (id === 'livekit') return { group: 'call-audio' }
  if (id === 'ai') return { group: 'answering' }
  return null
}
