// The website import's review: what the proposal would change in the draft. Nothing is overwritten
// without a choice: a different About text shows as a word diff, services and FAQs that are new or
// differ are listed to pick from, and only what is picked goes into the draft (saved with Save).
import {
  DOCUMENTS_INLINE_MAX,
  type Faq,
  FAQS_MAX,
  type KnowledgeImportData,
  type Service,
  SERVICES_MAX,
} from '@linedesk/actions'
import type { Draft } from './assistantDraft.ts'

export type DiffPart = { kind: 'same' | 'added' | 'removed'; text: string }

/** Word-level diff (longest common subsequence); long texts are compared by line to stay cheap. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const split = (text: string): string[] => text.match(/\s+|[^\s]+/g) ?? []
  let a = split(before)
  let b = split(after)
  if (a.length * b.length > 4_000_000) {
    a = before.split(/(?<=\n)/)
    b = after.split(/(?<=\n)/)
  }
  const n = a.length
  const m = b.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const parts: DiffPart[] = []
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts[parts.length - 1]
    if (last?.kind === kind) last.text += text
    else parts.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i]!)
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push('removed', a[i++]!)
    else push('added', b[j++]!)
  }
  while (i < n) push('removed', a[i++]!)
  while (j < m) push('added', b[j++]!)
  return parts
}

const key = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

export type Proposed<T> = { item: T; status: 'new' | 'changed'; was?: T }

export type ImportReview = {
  about: 'empty' | 'same' | 'different'
  services: Proposed<Service>[]
  faqs: Proposed<Faq>[]
  /** Proposed items the draft already has as they are. */
  unchanged: number
}

/** What the proposal adds or changes compared with the draft. */
export function reviewImport(
  draft: Pick<Draft, 'instructions' | 'services' | 'faqs'>,
  proposal: KnowledgeImportData,
): ImportReview {
  const about =
    !proposal.about.trim() || proposal.about.trim() === draft.instructions.trim()
      ? 'same'
      : draft.instructions.trim()
        ? 'different'
        : 'empty'
  let unchanged = 0
  const services = proposal.services.flatMap((item): Proposed<Service>[] => {
    const was = draft.services.find(s => key(s.name) === key(item.name))
    if (!was) return [{ item, status: 'new' }]
    if (
      was.price.trim() === item.price.trim() &&
      (was.description.trim() === item.description.trim() || !item.description.trim())
    ) {
      unchanged++
      return []
    }
    return [{ item, status: 'changed', was }]
  })
  const faqs = proposal.faqs.flatMap((item): Proposed<Faq>[] => {
    const was = draft.faqs.find(f => key(f.q) === key(item.q))
    if (!was) return [{ item, status: 'new' }]
    if (key(was.a) === key(item.a)) {
      unchanged++
      return []
    }
    return [{ item, status: 'changed', was }]
  })
  return { about, services, faqs, unchanged }
}

/** What the owner picked: whether the About text is taken over, and which services and FAQs (by index in the review). */
export type ImportPicks = { about: boolean; services: Set<number>; faqs: Set<number> }

/** By default: an empty About is filled, new items are added, changes to what the owner has stay unpicked. */
export const defaultPicks = (review: ImportReview): ImportPicks => ({
  about: review.about === 'empty',
  services: new Set(review.services.flatMap((p, i) => (p.status === 'new' ? [i] : []))),
  faqs: new Set(review.faqs.flatMap((p, i) => (p.status === 'new' ? [i] : []))),
})

/** The draft with the picked parts of the proposal: changed items replace theirs in place, new ones are added within the limits. */
export function applyImport(
  draft: Draft,
  proposal: KnowledgeImportData,
  review: ImportReview,
  picks: ImportPicks,
): Draft {
  const services = draft.services.map(s => ({ ...s }))
  review.services.forEach((p, i) => {
    if (!picks.services.has(i)) return
    const at = p.was ? services.findIndex(s => key(s.name) === key(p.was!.name)) : -1
    if (at >= 0) services[at] = { ...p.item }
    else if (services.length < SERVICES_MAX) services.push({ ...p.item })
  })
  const faqs = draft.faqs.map(f => ({ ...f }))
  review.faqs.forEach((p, i) => {
    if (!picks.faqs.has(i)) return
    const at = p.was ? faqs.findIndex(f => key(f.q) === key(p.was!.q)) : -1
    if (at >= 0) faqs[at] = { ...p.item }
    else if (faqs.length < FAQS_MAX) faqs.push({ ...p.item })
  })
  return {
    ...draft,
    instructions: picks.about ? proposal.about.trim() : draft.instructions,
    services,
    faqs,
    website: proposal.website ?? draft.website,
  }
}

/** Whether the assistant has any knowledge yet: drives the empty state that starts with the import. */
export const hasKnowledge = (d: Pick<Draft, 'instructions' | 'services' | 'faqs'>, documents: number) =>
  !!d.instructions.trim() || d.services.length > 0 || d.faqs.length > 0 || documents > 0

/** How the assistant uses the documents: all in every call while they are short, else looked up. */
export const documentsUse = (totalChars: number) =>
  totalChars <= DOCUMENTS_INLINE_MAX ? 'read on every call' : 'looked up when a caller asks'

export const fileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
