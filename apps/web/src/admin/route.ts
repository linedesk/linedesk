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

/** The nav's groups, in order: what to watch, who uses the server, what it does, and what it is connected to. */
export const adminGroups = {
  watch: msg('admin.groups.watch'),
  people: msg('admin.groups.people'),
  configuration: msg('admin.groups.configuration'),
  connections: msg('admin.groups.connections'),
} as const
export type AdminGroup = keyof typeof adminGroups

// One place for each thing (LIN-693): Providers only connects services, every setting is under Settings, the server's
// own state under Server. The number keys follow this order (1 to 9, then 0); the last sections have none.
export const adminSections = [
  { id: 'overview', group: 'watch', label: msg('admin.sections.overview.label'), description: null },
  { id: 'usage', label: msg('admin.sections.usage.label'), description: msg('admin.sections.usage.description') },
  {
    id: 'onboarding',
    label: msg('admin.sections.onboarding.label'),
    description: msg('admin.sections.onboarding.description'),
  },
  {
    id: 'call-reviews',
    label: msg('admin.sections.callReviews.label'),
    description: msg('admin.sections.callReviews.description'),
  },
  {
    id: 'workspaces',
    group: 'people',
    label: msg('admin.sections.workspaces.label'),
    description: msg('admin.sections.workspaces.description'),
  },
  { id: 'users', label: msg('admin.sections.users.label'), description: msg('admin.sections.users.description') },
  {
    id: 'partners',
    label: msg('admin.sections.partners.label'),
    description: msg('admin.sections.partners.description'),
  },
  {
    id: 'settings',
    group: 'configuration',
    label: msg('admin.sections.settings.label'),
    description: msg('admin.sections.settings.description'),
  },
  {
    id: 'branding',
    label: msg('admin.sections.branding.label'),
    description: msg('admin.sections.branding.description'),
  },
  { id: 'prompt', label: msg('admin.sections.prompt.label'), description: msg('admin.sections.prompt.description') },
  { id: 'billing', label: msg('admin.sections.billing.label'), description: msg('admin.sections.billing.description') },
  {
    id: 'providers',
    group: 'connections',
    label: msg('admin.sections.providers.label'),
    description: msg('admin.sections.providers.description'),
  },
  { id: 'server', label: msg('admin.sections.server.label'), description: msg('admin.sections.server.description') },
  { id: 'audit', label: msg('admin.sections.audit.label'), description: msg('admin.sections.audit.description') },
] as const satisfies readonly {
  id: string
  group?: AdminGroup
  label: MessageKey
  description: MessageKey | null
}[]
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
  // System was split up (LIN-693): its address opens Server, which says where its settings went.
  if (section === 'system') return { section: 'server', id: null }
  if (!isSection(section)) return { section: 'overview', id: null }
  return { section, id: id ? decodeURIComponent(id) : null }
}

export const adminHash = ({ section, id }: AdminPlace) => `#admin/${section}${id ? `/${encodeURIComponent(id)}` : ''}`

/**
 * The place an address shows, after `movedPlace`: an old address of something that moved is replaced in the history,
 * so Back never returns to it.
 */
function currentPlace(): AdminPlace {
  const place = parseAdminHash(window.location.hash)
  const moved = movedPlace(place)
  if (!moved) return place
  window.history.replaceState(window.history.state, '', adminHash(moved))
  return moved
}

export function useAdminPlace() {
  const [place, setPlace] = useState(currentPlace)
  useEffect(() => {
    const onHash = () => setPlace(currentPlace())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  /** A new history entry, so Back returns to the list or the previous section. */
  const go = (next: AdminPlace) => {
    window.location.hash = adminHash(next)
  }
  return { place, go }
}

/**
 * Server admin › Billing's sections: `#admin/billing` is its overview, `#admin/billing/<tab>` one section, anything else
 * after `billing/` a bill (`#admin/billing/<bill id>`).
 */
export const BILLING_TABS = ['overview', 'bills', 'review', 'events', 'rules', 'stripe'] as const
export type BillingTab = (typeof BILLING_TABS)[number]

/** The section of Billing that `#admin/billing/<id>` shows; null when `id` is a bill. */
export function billingTab(id: string | null): BillingTab | null {
  if (!id) return 'overview'
  return id !== 'overview' && (BILLING_TABS as readonly string[]).includes(id) ? (id as BillingTab) : null
}

/**
 * Server admin › Settings' tabs (`#admin/settings/<tab>`; `#admin/settings` is the first): what the server does for
 * calls, which phone numbers it offers, who may sign up, and which tools workspaces may connect.
 */
export const SETTINGS_TABS = ['calls', 'numbers', 'signup', 'integrations'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

/** The tab `#admin/settings/<id>` shows: the first for none or an unknown one. */
export const settingsTab = (id: string | null): SettingsTab =>
  (SETTINGS_TABS as readonly string[]).includes(id ?? '') ? (id as SettingsTab) : 'calls'

/** The place's own list or section page, when it shows one: a list that the list keys (J, K, Enter, /) move in. */
export const isListPlace = (place: AdminPlace) =>
  !place.id || place.section === 'settings' || (place.section === 'billing' && billingTab(place.id) !== null)

/**
 * One step up from a place (Esc and the crumb): a bill to Billing's list of bills, a Billing section to its overview,
 * any other detail to its list; null on a section's own page.
 */
export function placeUp(place: AdminPlace): AdminPlace | null {
  if (!place.id) return null
  if (place.section === 'billing' && billingTab(place.id) === null) return { section: 'billing', id: 'bills' }
  // Settings' tabs are one page: Esc leaves admin mode from any of them, as from a section's own page.
  if (place.section === 'settings') return null
  return { section: place.section, id: null }
}

/**
 * Where an old address goes now; null for every other place. Links from before (emails, the setup agent's links, the
 * overview's card) keep working:
 * - Billing › Sign-up is Settings › Sign-up (LIN-693); its bot check is connected under Providers again.
 * - Providers' call audio (LiveKit and the SIP trunk) is a status, shown under Server (LIN-693).
 * Stripe and the bot check are connected under Providers again (LIN-693, before under Billing since LIN-556); the
 * billing switch stays under Billing › Stripe.
 */
export function movedPlace(place: AdminPlace): AdminPlace | null {
  if (place.section === 'billing' && place.id === 'signup') return { section: 'settings', id: 'signup' }
  if (place.section !== 'providers' || !place.id) return null
  const target = providersTarget(place.id)
  if (target && 'group' in target && target.group === 'call-audio') return { section: 'server', id: null }
  return null
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
