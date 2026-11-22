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

// Eight sections for the daily work, then three quiet ones under a line (LIN-747): one place for each thing, no
// group headings. Usage and Onboarding are views of Workspaces, Sign-up a part of Billing, Calls, Phone numbers and
// Tools one Features page, Server status the call audio group of Providers, Stripe events and setup reports kinds of
// the Audit log. The number keys follow this order (1 to 9, then 0); the last section has none.
export const adminSections = [
  { id: 'overview', label: msg('admin.sections.overview.label'), description: null },
  {
    id: 'workspaces',
    label: msg('admin.sections.workspaces.label'),
    description: msg('admin.sections.workspaces.description'),
  },
  { id: 'users', label: msg('admin.sections.users.label'), description: msg('admin.sections.users.description') },
  { id: 'billing', label: msg('admin.sections.billing.label'), description: msg('admin.sections.billing.description') },
  {
    id: 'prompt',
    label: msg('admin.sections.prompt.label'),
    description: msg('admin.sections.prompt.description'),
  },
  {
    id: 'call-reviews',
    label: msg('admin.sections.callReviews.label'),
    description: msg('admin.sections.callReviews.description'),
  },
  {
    id: 'features',
    label: msg('admin.sections.features.label'),
    description: msg('admin.sections.features.description'),
  },
  {
    id: 'providers',
    label: msg('admin.sections.providers.label'),
    description: msg('admin.sections.providers.description'),
  },
  {
    id: 'partners',
    quiet: true,
    label: msg('admin.sections.partners.label'),
    description: msg('admin.sections.partners.description'),
  },
  {
    id: 'branding',
    quiet: true,
    label: msg('admin.sections.branding.label'),
    description: msg('admin.sections.branding.description'),
  },
  {
    id: 'audit',
    quiet: true,
    label: msg('admin.sections.audit.label'),
    description: msg('admin.sections.audit.description'),
  },
] as const satisfies readonly {
  id: string
  /** Below the line, in a quieter type: set up once, rarely opened. */
  quiet?: true
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
  if (!isSection(section)) return { section: 'overview', id: null }
  return { section, id: id ? decodeURIComponent(id) : null }
}

export const adminHash = ({ section, id }: AdminPlace) => `#admin/${section}${id ? `/${encodeURIComponent(id)}` : ''}`

/**
 * The place an address shows, after `movedHash`: an old address of something that moved is replaced in the history,
 * so Back never returns to it.
 */
function currentPlace(): AdminPlace {
  const moved = movedHash(window.location.hash)
  if (moved) window.history.replaceState(window.history.state, '', moved)
  return parseAdminHash(moved ?? window.location.hash)
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
export const BILLING_TABS = ['overview', 'bills', 'review', 'signup', 'rules', 'stripe'] as const
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

/** Workspaces' views (`#admin/workspaces?view=`): the list, the ones at risk (was Onboarding), usage by month. */
export const WORKSPACE_VIEWS = ['all', 'at-risk', 'usage'] as const
export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number]

/** The Audit log's kinds that are lists of their own (`#admin/audit?kind=`): Stripe's events, the setup reports. */
export const AUDIT_LISTS = ['stripe', 'setup-reports'] as const
export type AuditList = (typeof AUDIT_LISTS)[number]

const queryOf = (hash: string) => new URLSearchParams(hash.split('?')[1] ?? '')

export const workspaceViewOfHash = (hash: string): WorkspaceView => {
  const view = queryOf(hash).get('view')
  return (WORKSPACE_VIEWS as readonly string[]).includes(view ?? '') ? (view as WorkspaceView) : 'all'
}
export const workspacesHref = (view: WorkspaceView) => `#admin/workspaces${view === 'all' ? '' : `?view=${view}`}`

/** Stripe's events in the Audit log, optionally only those in one state (`all`, `waiting`, `failed`, `unhandled`). */
export const stripeEventsHref = (filter = 'all') =>
  `#admin/audit?kind=stripe${filter === 'all' ? '' : `&filter=${encodeURIComponent(filter)}`}`

/**
 * Where an old address goes now (a hash), null for every other one. Links from before (emails, the setup agent's links,
 * bookmarks) keep working:
 * - LIN-747: Usage and Onboarding are views of Workspaces; Sign-up is a part of Billing; Calls, Phone numbers and Tools
 *   are Features; Server (and System before it) is the call audio group of Providers; Billing's Stripe events are in
 *   the Audit log.
 * - LIN-693: Settings' tabs (`#admin/settings/<tab>`) became sections, which LIN-747 moved again.
 */
export function movedHash(hash: string): string | null {
  const path = hash.replace(/^#/, '').split('?')[0]!
  const [page, section = '', id = ''] = path.split('/')
  if (page !== 'admin') return null
  switch (section) {
    case 'usage':
      return workspacesHref('usage')
    case 'onboarding':
      return workspacesHref('at-risk')
    case 'signup':
      return '#admin/billing/signup'
    case 'calls':
    case 'numbers':
    case 'tools':
      return '#admin/features'
    case 'server':
    case 'system':
      return '#admin/providers/call-audio'
    case 'settings':
      return id === 'signup' ? '#admin/billing/signup' : '#admin/features'
    case 'billing':
      if (id === 'events') return stripeEventsHref(queryOf(hash).get('filter') ?? 'all')
      return null
    default:
      return null
  }
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
