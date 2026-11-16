// Where admin mode is: `#admin/<section>` and `#admin/<section>/<id>` (a workspace, a user, a bill, or on Providers a
// group or a provider).
// Kept in the hash like the rest of the app, so reload and the browser's Back work. Labels are message keys (t()).
import {
  groupOfCategory,
  isProviderGroupId,
  type ProviderCategory,
  providerCategoryKeys,
  type ProviderGroupId,
  type ProviderName,
  providers as providerRegistry,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useEffect, useState } from 'react'

export const adminSections = [
  { id: 'overview', label: msg('admin.sections.overview.label'), description: null },
  {
    id: 'workspaces',
    label: msg('admin.sections.workspaces.label'),
    description: msg('admin.sections.workspaces.description'),
  },
  { id: 'users', label: msg('admin.sections.users.label'), description: msg('admin.sections.users.description') },
  { id: 'usage', label: msg('admin.sections.usage.label'), description: msg('admin.sections.usage.description') },
  {
    id: 'onboarding',
    label: msg('admin.sections.onboarding.label'),
    description: msg('admin.sections.onboarding.description'),
  },
  { id: 'providers', label: msg('admin.sections.providers.label'), description: null },
  {
    id: 'branding',
    label: msg('admin.sections.branding.label'),
    description: msg('admin.sections.branding.description'),
  },
  { id: 'system', label: msg('admin.sections.system.label'), description: msg('admin.sections.system.description') },
  { id: 'prompt', label: msg('admin.sections.prompt.label'), description: msg('admin.sections.prompt.description') },
  { id: 'audit', label: msg('admin.sections.audit.label'), description: msg('admin.sections.audit.description') },
  // Last, so the sections before it keep their number keys. It is the eleventh, so it has none (sectionKey).
  { id: 'billing', label: msg('admin.sections.billing.label'), description: msg('admin.sections.billing.description') },
] as const satisfies readonly { id: string; label: MessageKey; description: MessageKey | null }[]
export type AdminSection = (typeof adminSections)[number]['id']
export type AdminPlace = { section: AdminSection; id: string | null }

/**
 * The digit that opens the section at `index`: 1 to 9, then 0 for the tenth. A section past the tenth has none (there
 * is no eleventh digit); Tab and the list reach it.
 */
export const sectionKey = (index: number) => (index < 10 ? String((index + 1) % 10) : undefined)
/** The index of the section a digit opens: `sectionKey`'s opposite. */
export const sectionIndexOfKey = (key: string) => (Number(key) + 9) % 10

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
  if (id in providerCategoryKeys) return { group: groupOfCategory(id as ProviderCategory) }
  // Links from before the groups: the setup checklist's parts.
  if (id === 'livekit') return { group: 'call-audio' }
  if (id === 'ai') return { group: 'answering' }
  return null
}
