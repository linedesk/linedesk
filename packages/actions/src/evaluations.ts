// Call evaluations: after a call is summarized, the language model judges how the assistant did
// (score 1 to 5, up to three issues, the questions it could not answer). Owners and admins look at the low ones
// in the Assistant area ("How Maya did", #assistant/<id>/review) and mark each done. Only owners and admins see
// them (`settings:write`); members do not.
import { z } from 'zod'
import { defineAction } from './define.ts'

/** A score at or below this needs a person to look at the call. */
export const NEEDS_REVIEW_MAX_SCORE = 3

/** The score in words, as owners read it (no number needed): 5 Handled well … 1 and 2 Went wrong. */
export const scoreWords = (score: number) =>
  score >= 5 ? 'Handled well' : score === 4 ? 'Mostly fine' : score === 3 ? 'Missed something' : 'Went wrong'

/** How far back the unanswered questions of evaluations are counted ("asked 3×"). */
export const QUESTIONS_WINDOW_DAYS = 30

/** One evaluation: `data.evaluation` of `call.getEvaluation` (null when the call has none yet), each of `data.evaluations` of `call.listEvaluations`. */
export type CallEvaluation = {
  callId: string
  score: number
  issues: string[]
  /** Questions about the business the caller asked that the assistant could not answer. */
  unanswered: string[]
  model: string | null
  createdAt: string
  /** When it was marked done (null: open), and by whom (user id). */
  reviewedAt: string | null
  reviewedBy: string | null
}

/**
 * A question callers asked that the assistant could not answer, as `evaluation.listQuestions` groups it: one open
 * question (`knowledge_questions`, answered or dismissed with `knowledgeQuestion.answer` / `.dismiss`) and the
 * calls of the last QUESTIONS_WINDOW_DAYS days that asked it, newest first.
 */
export type QuestionGroup = {
  questionId: string
  assistantId: string
  question: string
  asked: number
  callIds: string[]
  lastAskedAt: string
}

const callId = z.object({ callId: z.string().min(1) })

export const callGetEvaluation = defineAction({
  name: 'call.getEvaluation',
  description:
    'How the assistant handled one call, as the language model judged it after the summary: score 1 (poor) to 5 (good) and up to three issues. null until it has been evaluated.',
  input: callId,
  permission: 'settings:write',
  readOnly: true,
})

export const callListEvaluations = defineAction({
  name: 'call.listEvaluations',
  description: `The workspace's call evaluations, newest first. \`needsReview\`: only scores of ${NEEDS_REVIEW_MAX_SCORE} or lower. \`open\`: true only those not marked done, false only those marked done. \`assistantId\`: only that assistant's calls (and calls without an assistant). \`data.total\` counts all that match, beyond \`limit\`.`,
  input: z.object({
    needsReview: z.boolean().default(false),
    open: z.boolean().optional(),
    assistantId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  permission: 'settings:write',
  readOnly: true,
})

export const evaluationMarkDone = defineAction({
  name: 'evaluation.markDone',
  description: "Mark a call's evaluation as looked at: it leaves the open list of How <assistant> did.",
  input: callId,
  permission: 'settings:write',
})

export const evaluationReopen = defineAction({
  name: 'evaluation.reopen',
  description: "Put a call's evaluation back on the open list (undo of evaluation.markDone).",
  input: callId,
  permission: 'settings:write',
})

export const evaluationListQuestions = defineAction({
  name: 'evaluation.listQuestions',
  description: `Open questions callers asked that the assistant could not answer, each with how often and on which calls it was asked in the last ${QUESTIONS_WINDOW_DAYS} days (same question, whatever the case or punctuation). Most asked first. Answer one with knowledgeQuestion.answer, hide it with knowledgeQuestion.dismiss.`,
  input: z.object({ assistantId: z.string().min(1).optional() }),
  permission: 'settings:write',
  readOnly: true,
})

export const callEvaluate = defineAction({
  name: 'call.evaluate',
  description:
    'Evaluate a call now (again): for a test call, which is not evaluated on its own, or after the assistant changed. Runs in the background; the result replaces the previous one.',
  input: callId,
  permission: 'settings:write',
})
