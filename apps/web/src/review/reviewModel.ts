// Open questions (the first rows of Business info's questions and answers, LIN-797): the pure part. The questions callers asked that the
// assistant could not answer, grouped (`questionKey`: the same question however it was worded), each answered once
// into About the business or dismissed. How the assistant itself did on a call is for staff only (Server admin ›
// Call reviews, and the call view's card for server admins).
import { NEEDS_REVIEW_MAX_SCORE, type QuestionGroup, questionKey } from '@linedesk/actions'
import type { KnowledgeQuestion } from '@linedesk/db/types'
import { i18n } from '../i18n/index.tsx'

/** "How Maya did": the evaluation of one call, as staff read it (call view, Server admin › Call reviews). */
export const reviewTitle = (assistantName: string) =>
  assistantName.trim()
    ? i18n().t('settings.review.title', { name: assistantName.trim() })
    : i18n().t('settings.review.titleDefault')

/** The score in words, in the active language (the API's `scoreWords` is English, for the setup MCP and logs). */
export const scoreWords = (score: number) =>
  i18n().t(
    score >= 5
      ? 'settings.review.score.handledWell'
      : score === 4
        ? 'settings.review.score.mostlyFine'
        : score === 3
          ? 'settings.review.score.missedSomething'
          : 'settings.review.score.wentWrong',
  )

/** A score the evaluation flags (Missed something, Went wrong). */
export const needsALook = (score: number) => score <= NEEDS_REVIEW_MAX_SCORE

/** "Asked once", "Asked 3 times". */
export const askedLabel = (n: number) => i18n().t('settings.review.questions.asked', { count: Math.max(1, n) })

/**
 * The question groups still open on this device: a group answered or dismissed here (or in another tab, the rows are
 * synced) leaves at once, before the server's list is read again. A group stays while one of its questions is open
 * (or not here yet).
 */
export function openGroups(groups: readonly QuestionGroup[], rows: readonly KnowledgeQuestion[]): QuestionGroup[] {
  const status = new Map(rows.map(r => [r.id, r.status]))
  return groups.filter(g => (g.questionIds ?? [g.questionId]).some(id => (status.get(id) ?? 'open') === 'open'))
}

/**
 * The count on the Assistant item in the navigation and on the section: open question groups (one per assistant and
 * `questionKey`), from the synced rows, so an answer drops it at once. `assistantId`: only that assistant's.
 */
export function openGroupCount(questions: readonly KnowledgeQuestion[], assistantId?: string): number {
  const keys = new Set<string>()
  for (const q of questions)
    if (q.status === 'open' && (!assistantId || q.assistant_id === assistantId))
      keys.add(`${q.assistant_id}\n${questionKey(q.question)}`)
  return keys.size
}

/** The rest of a group's questions, closed with the one shown (knowledgeQuestion.answer / .dismiss `alsoIds`). */
export const otherIds = (group: QuestionGroup) => (group.questionIds ?? []).filter(id => id !== group.questionId)
