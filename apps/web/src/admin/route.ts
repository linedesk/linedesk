// Where admin mode is: `#admin/<section>` and `#admin/<section>/<id>` (a workspace, a user, a bill, or on Providers a
// group or a provider).
// Kept in the hash like the rest of the app, so reload and the browser's Back work. Labels are message keys (t()).
import {
  groupOfCategory,
  groupOfProvider,
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
  // White-label partners (docs/white-label.md): after Billing, so no section's number key moves (none of its own).
  {
    id: 'partners',
    label: msg('admin.sections.partners.label'),
    description: msg('admin.sections.partners.description'),
  },
  // Calls the evaluation flagged, with the reviewer's notes (staff only): last, so no section's number key moves.
  {
    id: 'call-reviews',
    label: msg('admin.sections.callReviews.label'),
    description: msg('admin.sections.callReviews.description'),
  },
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
export const BILLING_TABS = ['overview', 'bills', 'review', 'events', 'signup', 'rules', 'stripe'] as const
export type BillingTab = (typeof BILLING_TABS)[number]

/** The section of Billing that `#admin/billing/<id>` shows; null when `id` is a bill. */
export function billingTab(id: string | null): BillingTab | null {
  if (!id) return 'overview'
  return id !== 'overview' && (BILLING_TABS as readonly string[]).includes(id) ? (id as BillingTab) : null
}

/** The place's own list or section page, when it shows one: a list that the list keys (J, K, Enter, /) move in. */
export const isListPlace = (place: AdminPlace) =>
  !place.id || (place.section === 'billing' && billingTab(place.id) !== null)

/**
 * One step up from a place (Esc and the crumb): a bill to Billing's list of bills, a Billing section to its overview,
 * any other detail to its list; null on a section's own page.
 */
export function placeUp(place: AdminPlace): AdminPlace | null {
  if (!place.id) return null
  if (place.section === 'billing' && billingTab(place.id) === null) return { section: 'billing', id: 'bills' }
  return { section: place.section, id: null }
}

/**
 * Where an address of Server admin › Providers' Billing group goes now (LIN-556): Stripe and the billing switch to
 * Billing › Stripe, the bot check (Turnstile) to Billing › Sign-up; null for every other place. Links from before
 * (emails, the setup agent's `providers_billing`, the overview's card) keep working.
 */
export function movedPlace(place: AdminPlace): AdminPlace | null {
  if (place.section !== 'providers' || !place.id) return null
  const target = providersTarget(place.id)
  if (!target) return null
  if (place.id === 'bot_check') return { section: 'billing', id: 'signup' }
  if ('group' in target) return target.group === 'billing' ? { section: 'billing', id: 'stripe' } : null
  if (groupOfProvider(target.provider) !== 'billing') return null
  return { section: 'billing', id: providerRegistry[target.provider].category === 'bot_check' ? 'signup' : 'stripe' }
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
