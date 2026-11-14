// The order and the short form of one provider list in a group (Admin › Providers and the install walkthrough's
// embedded panels). The pinned providers come first, in their order (pinnedProviders in @linedesk/actions: the
// recommended one leads), then the rest in their usual order. A list of more than three is short until "Show more":
// the pinned providers and every provider that is already set up, being tested or failing.
import {
  type GroupStatus,
  type ProviderCategory,
  type ProviderGroupId,
  type ProviderLine,
  type ProviderName,
  pinnedProvidersOf,
  providerSpec,
  providersOfGroup,
  STAGE_CATEGORIES,
  type VoicePipeline,
} from '@linedesk/actions'
import type { AdminData } from './api.ts'
import { isConfigured } from './model.ts'

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

/** One provider list on the page: a group's providers of one category (Answering has four, the others one). */
export type ProviderListSpec = {
  key: string
  group: ProviderGroupId
  category: ProviderCategory
  providers: ProviderName[]
}

/** The lists of a group, in the order they are shown; call audio has none (LiveKit is set on the server). */
export function listsOfGroup(group: ProviderGroupId): ProviderListSpec[] {
  if (group === 'call-audio') return []
  const providers = providersOfGroup(group)
  const categories = [...new Set(providers.map(p => providerSpec(p).category))]
  return categories.map(category => ({
    key: `${group}/${category}`,
    group,
    category,
    providers: providers.filter(p => providerSpec(p).category === category),
  }))
}

/** Set up, being tested or failing: never folded away. */
export const keepShown =
  (data: Pick<AdminData, 'providers'>, lines: Partial<Record<ProviderName, ProviderLine>>) => (name: ProviderName) => {
    const status = data.providers.find(p => p.provider === name)
    return (!!status && isConfigured(status)) || (!!lines[name] && lines[name].state !== 'missing')
  }

/**
 * The lists "Show all providers" opens: those that fold something away now, and those open already. `open` holds the
 * keys of the lists that are open.
 */
export function foldableLists(
  lists: readonly ProviderListSpec[],
  keep: (provider: ProviderName) => boolean,
  open: ReadonlySet<string>,
): string[] {
  return lists
    .filter(
      l =>
        open.has(l.key) ||
        visibleProviders(l.providers, { pinned: pinnedProvidersOf(l.category), keep, expanded: false }).hidden > 0,
    )
    .map(l => l.key)
}

/** Whether every list that can fold is open (the top button then reads "Show fewer"). */
export const allOpen = (foldable: readonly string[], open: ReadonlySet<string>) =>
  foldable.length > 0 && foldable.every(key => open.has(key))

/**
 * Answering calls has two ways, shown as two tabs: one realtime model, or three parts (speech to text, a language
 * model, a voice). The tab is only a view: which way answers is the "Which one answers calls" setting (LIN-192).
 */
export const answeringWays: readonly VoicePipeline[] = ['realtime', 'three_stage']
export const wayOfCategory = (category: ProviderCategory): VoicePipeline =>
  category === 'realtime' ? 'realtime' : 'three_stage'
const categoriesOfWay = (way: VoicePipeline): readonly ProviderCategory[] =>
  way === 'realtime' ? ['realtime'] : STAGE_CATEGORIES

/**
 * The tab that opens: the way that answers calls now (the realtime model when both do, as it is the default), else
 * the way that is partly set up, else the recommended one, the realtime model.
 */
export function defaultAnsweringWay(group: Pick<GroupStatus, 'answeredWith'>, data: AdminData): VoicePipeline {
  const used = group.answeredWith ?? []
  if (used.length) return used.includes('realtime') ? 'realtime' : 'three_stage'
  const started = (way: VoicePipeline) => categoriesOfWay(way).some(c => !!data.activeProviders[c]?.provider)
  return !started('realtime') && started('three_stage') ? 'three_stage' : 'realtime'
}

/** What a tab carries: "In use" while its way answers calls, a check while it works but doesn't, else nothing. */
export function answeringWayMark(
  way: VoicePipeline,
  group: Pick<GroupStatus, 'answeredWith'>,
  data: AdminData,
  lines: Partial<Record<ProviderName, ProviderLine>>,
): 'in_use' | 'works' | null {
  if (group.answeredWith?.includes(way)) return 'in_use'
  const works = categoriesOfWay(way).every(c => {
    const provider = data.activeProviders[c]?.provider
    return !!provider && lines[provider]?.state === 'works'
  })
  return works ? 'works' : null
}

/** The tab an arrow key, Home or End moves to; null for any other key. */
export function wayAfterKey(current: VoicePipeline, key: string): VoicePipeline | null {
  const i = answeringWays.indexOf(current)
  const n = answeringWays.length
  if (key === 'ArrowRight' || key === 'ArrowDown') return answeringWays[(i + 1) % n]!
  if (key === 'ArrowLeft' || key === 'ArrowUp') return answeringWays[(i - 1 + n) % n]!
  if (key === 'Home') return answeringWays[0]!
  if (key === 'End') return answeringWays[n - 1]!
  return null
}
