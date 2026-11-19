// Write with help's review: what the proposal would change in the draft. Nothing is overwritten without a
// choice: a different About text shows as a word diff, and only what is picked goes into the draft (saved with Save).
import type { KnowledgeImportData } from '@linedesk/actions'
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

export type ImportReview = { about: 'empty' | 'same' | 'different' }

/** Whether the proposed About text is new, the same as the draft's, or different from it. */
export function reviewImport(draft: Pick<Draft, 'instructions'>, proposal: KnowledgeImportData): ImportReview {
  const about =
    !proposal.about.trim() || proposal.about.trim() === draft.instructions.trim()
      ? 'same'
      : draft.instructions.trim()
        ? 'different'
        : 'empty'
  return { about }
}

/** What the owner picked: whether the About text is taken over, and which use cases (by index in the proposal). */
export type ImportPicks = { about: boolean; useCases: Set<number> }

/** By default: an empty About is filled, every use case is added. */
export const defaultPicks = (review: ImportReview, proposal: KnowledgeImportData): ImportPicks => ({
  about: review.about === 'empty',
  useCases: new Set(proposal.useCases.map((_, i) => i)),
})

/** The draft with the picked parts of the proposal. */
export function applyImport(draft: Draft, proposal: KnowledgeImportData, picks: ImportPicks): Draft {
  const about = picks.about ? proposal.about.trim() : draft.instructions.trim()
  const useCases = proposal.useCases.filter((_, i) => picks.useCases.has(i))
  // i18n-ignore: the assistant's About text, which it reads (CLAUDE.md rule 11: wording needs Tim's or Janik's OK)
  const instructions = useCases.length
    ? [about, `Common calls:\n${useCases.map(u => `- ${u}`).join('\n')}`].filter(Boolean).join('\n\n')
    : picks.about
      ? about
      : draft.instructions
  return { ...draft, instructions, website: proposal.website ?? draft.website }
}

/** Whether the assistant knows anything yet: drives the empty state that points to Write with help. */
export const hasKnowledge = (d: Pick<Draft, 'instructions'>) => !!d.instructions.trim()
