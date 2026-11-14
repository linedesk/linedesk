// How <assistant> did: what is read from the server (evaluations are not synced: owners and admins only) and the
// Mark as checked / Reopen writes. Each write puts its result into every cached list at once (CLAUDE.md, core rule 3), then
// reads them again.
import type { CallEvaluation, QuestionGroup } from '@linedesk/actions'
import { refreshQuery, setQueryData, useQuery } from '../cachedQuery.ts'
import { callAction, readAction } from '../settings/settings-api.ts'
import { useRows } from '../store.tsx'
import { openItemCount, type ReviewList, withCall, withoutCall } from './reviewModel.ts'

/** The workspace's open calls to look at (every assistant): the count on the Assistant item in the navigation. */
export const REVIEW_KEY = 'evaluations:review'
/** One assistant's open (or done) calls to look at, for its section. */
export const reviewListKey = (assistantId: string, open: boolean) =>
  `evaluations:${open ? 'open' : 'done'}:${assistantId}`
export const questionsKey = (assistantId: string) => `evaluations:questions:${assistantId}`
export const evaluationKey = (callId: string) => `evaluation:${callId}`

const loadList = (input: object) => readAction<ReviewList>('call.listEvaluations', { needsReview: true, ...input })
export const loadReview = () => loadList({ open: true })
export const loadReviewList = (assistantId: string, open: boolean) => () =>
  loadList({ open, assistantId, limit: open ? 200 : 50 })
export const loadQuestions = (assistantId: string) => () =>
  readAction<{ questions: QuestionGroup[] }>('evaluation.listQuestions', { assistantId }).then(d => d.questions)

/** The number on the Assistant item: open calls to look at and open questions; null for members (nothing shown). */
export function useReviewCount(canReview: boolean): number | null {
  const open = useQuery(canReview ? REVIEW_KEY : null, loadReview).data
  const questions = useRows('knowledge_questions')
  return canReview ? openItemCount(open?.total ?? 0, questions) : null
}

/** Every cached list that may hold the call: the workspace's and those of each assistant. */
const listKeys = (assistantId: string | null) =>
  assistantId ? [REVIEW_KEY, reviewListKey(assistantId, true), reviewListKey(assistantId, false)] : [REVIEW_KEY]

/**
 * Marks the call's evaluation done (or open again). The lists and the call's card change at once; on a refusal
 * they are read again and the error is thrown for a toast.
 */
export async function setEvaluationDone(evaluation: CallEvaluation, assistantId: string | null, done: boolean) {
  const changed: CallEvaluation = done
    ? { ...evaluation, reviewedAt: new Date().toISOString(), reviewedBy: evaluation.reviewedBy }
    : { ...evaluation, reviewedAt: null, reviewedBy: null }
  setQueryData<ReviewList | undefined>(REVIEW_KEY, l =>
    done ? withoutCall(l, evaluation.callId) : withCall(l, changed),
  )
  if (assistantId) {
    setQueryData<ReviewList | undefined>(reviewListKey(assistantId, true), l =>
      done ? withoutCall(l, evaluation.callId) : withCall(l, changed),
    )
    setQueryData<ReviewList | undefined>(reviewListKey(assistantId, false), l =>
      done ? withCall(l, changed) : withoutCall(l, evaluation.callId),
    )
  }
  setQueryData<CallEvaluation | null>(evaluationKey(evaluation.callId), changed)
  try {
    const result = await callAction<{ evaluation: CallEvaluation }>(
      done ? 'evaluation.markDone' : 'evaluation.reopen',
      { callId: evaluation.callId },
    )
    setQueryData<CallEvaluation | null>(evaluationKey(evaluation.callId), result.evaluation)
  } finally {
    for (const key of [...listKeys(assistantId), evaluationKey(evaluation.callId)]) void refreshQuery(key)
  }
}
