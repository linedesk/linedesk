// The order and the short form of one provider list in a group (Admin › Providers and the install walkthrough's
// embedded panels). The pinned providers come first, in their order (pinnedProviders in @linedesk/actions: the
// recommended one leads), then the rest in their usual order. A list of more than three is short until "Show more":
// the pinned providers and every provider that is already set up, being tested or failing.
import type { ProviderName } from '@linedesk/actions'

/** Lists of up to this many show every provider. */
export const SHORT_LIST = 3

export type VisibleProviders = {
  /** In the order they are shown. */
  shown: ProviderName[]
  /** How many "Show more" reveals; 0 when the list is short or open. */
  hidden: number
  /** Whether the list can fold at all (more than SHORT_LIST providers). */
  foldable: boolean
}

export function orderProviders(providers: readonly ProviderName[], pinned: readonly ProviderName[]): ProviderName[] {
  const rank = (p: ProviderName) => (pinned.includes(p) ? pinned.indexOf(p) : pinned.length)
  // Array.prototype.sort is stable: the rest keep their usual order.
  return [...providers].sort((a, b) => rank(a) - rank(b))
}

export function visibleProviders(
  providers: readonly ProviderName[],
  {
    pinned,
    keep,
    expanded,
  }: {
    /** pinnedProvidersOf(category). */
    pinned: readonly ProviderName[]
    /** Set up, being tested or failing: always shown. */
    keep: (provider: ProviderName) => boolean
    expanded: boolean
  },
): VisibleProviders {
  const ordered = orderProviders(providers, pinned)
  const foldable = ordered.length > SHORT_LIST
  if (!foldable || expanded) return { shown: ordered, hidden: 0, foldable }
  const shown = ordered.filter(p => pinned.includes(p) || keep(p))
  return { shown, hidden: ordered.length - shown.length, foldable }
}
