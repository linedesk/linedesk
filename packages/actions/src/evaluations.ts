// Call evaluations: after a call is summarized, the language model judges how the assistant did
// (score 1 to 5, up to three issues). Only owners and admins see them (`settings:write`); members do not.
import { z } from 'zod'
import { defineAction } from './define.ts'

/** A score at or below this needs a person to look at the call. */
export const NEEDS_REVIEW_MAX_SCORE = 3

/** One evaluation: `data.evaluation` of `call.getEvaluation` (null when the call has none yet), each of `data.evaluations` of `call.listEvaluations`. */
export type CallEvaluation = {
  callId: string
  score: number
  issues: string[]
  model: string | null
  createdAt: string
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
  description: `The workspace's call evaluations, newest first. \`needsReview\`: only scores of ${NEEDS_REVIEW_MAX_SCORE} or lower.`,
  input: z.object({ needsReview: z.boolean().default(false), limit: z.number().int().min(1).max(500).default(200) }),
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
