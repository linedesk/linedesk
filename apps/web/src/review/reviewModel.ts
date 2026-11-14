// How <assistant> did (Assistant area, #assistant/<id>/review): the pure part. The low-scored calls owners and
// admins look at and mark as checked, and the questions callers asked that the assistant could not answer.
import { type CallEvaluation, NEEDS_REVIEW_MAX_SCORE, type QuestionGroup, scoreWords } from '@linedesk/actions'
import type { KnowledgeQuestion } from '@linedesk/db/types'

export { scoreWords }

/** The section's id in the Assistant area, and its title, named after the assistant ("How Maya did"). */
export const REVIEW_SECTION = 'review'
export const reviewTitle = (assistantName: string) => `How ${assistantName.trim() || 'the assistant'} did`

/** A score worth a look (Missed something, Went wrong): the list holds only these. */
export const needsALook = (score: number) => score <= NEEDS_REVIEW_MAX_SCORE

/**
 * The words for the checked state. Not "Done": on a call that is the inbox's Done (E), which finishes the call itself.
 */
export const checkLabel = (checked: boolean) => (checked ? 'Reopen' : 'Mark as checked')
export const listToggleLabel = (showingChecked: boolean) => (showingChecked ? 'Show open' : 'Show checked')

/** "Asked once", "Asked 3×". */
export const askedLabel = (n: number) => (n <= 1 ? 'Asked once' : `Asked ${n}×`)

/** An open list after one of its calls was marked as checked (or reopened elsewhere): the call is gone, the total one less. */
export function withoutCall(list: ReviewList | undefined, callId: string): ReviewList | undefined {
  if (!list?.evaluations.some(e => e.callId === callId)) return list
  return { evaluations: list.evaluations.filter(e => e.callId !== callId), total: Math.max(0, list.total - 1) }
}

/** A list with this evaluation in its place, newest first (put back by Reopen, or marked as checked into the checked list). */
export function withCall(list: ReviewList | undefined, evaluation: CallEvaluation): ReviewList | undefined {
  if (!list) return list
  const rest = list.evaluations.filter(e => e.callId !== evaluation.callId)
  const evaluations = [...rest, evaluation].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { evaluations, total: list.total + (rest.length === list.evaluations.length ? 1 : 0) }
}

export type ReviewList = { evaluations: CallEvaluation[]; total: number }

/**
 * The question groups still open on this device: one answered or dismissed here (or in another tab, the rows are
 * synced) leaves at once, before the server's list is read again. A group whose row is not here yet stays.
 */
export function openGroups(groups: readonly QuestionGroup[], rows: readonly KnowledgeQuestion[]): QuestionGroup[] {
  const status = new Map(rows.map(r => [r.id, r.status]))
  return groups.filter(g => (status.get(g.questionId) ?? 'open') === 'open')
}

/**
 * The count on the Assistant item in the navigation: open calls to look at plus open questions. Questions are the
 * synced rows (`knowledge_questions`), so an answer drops the count at once.
 */
export const openItemCount = (openEvaluations: number, questions: readonly KnowledgeQuestion[]) =>
  openEvaluations + questions.filter(q => q.status === 'open').length
