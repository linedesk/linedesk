// Open questions: what is read from the server (owners and admins only) and the count in the navigation.
import type { CallEvaluation, QuestionGroup } from '@linedesk/actions'
import { readAction } from '../settings/settings-api.ts'
import { useRows } from '../store.tsx'
import { openGroupCount } from './reviewModel.ts'

export const questionsKey = (assistantId: string) => `evaluations:questions:${assistantId}`
export const evaluationKey = (callId: string) => `evaluation:${callId}`

export const loadQuestions = (assistantId: string) => () =>
  readAction<{ questions: QuestionGroup[] }>('evaluation.listQuestions', { assistantId }).then(d => d.questions)

export const loadEvaluation = (callId: string) => () =>
  readAction<{ evaluation: CallEvaluation | null }>('call.getEvaluation', { callId }).then(d => d.evaluation)

/** The number on the Assistant item: open question groups; null for members (nothing shown). */
export function useReviewCount(canReview: boolean): number | null {
  const questions = useRows('knowledge_questions')
  return canReview ? openGroupCount(questions) : null
}
