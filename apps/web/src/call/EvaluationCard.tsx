// How the assistant handled this call, as the language model judged it after the summary. Only
// owners and admins see it (the API refuses everyone else). Calm: a score and at most three issues.
import { type CallEvaluation, NEEDS_REVIEW_MAX_SCORE } from '@linedesk/actions'
import type { Call } from '@linedesk/db/types'
import { useState } from 'react'
import { refreshQuery, useQuery } from '../cachedQuery.ts'
import { readAction } from '../settings/settings-api.ts'
import { workspaceHeaders } from '../tabWorkspace.ts'
import { Badge, Button, Note } from '../ui/kit.tsx'

export const evaluationKey = (callId: string) => `evaluation:${callId}`
export const REVIEW_KEY = 'evaluations:review'

/** The calls whose evaluation needs a person (score of NEEDS_REVIEW_MAX_SCORE or lower), for the inbox. */
export const loadReview = () =>
  readAction<{ evaluations: CallEvaluation[] }>('call.listEvaluations', { needsReview: true }).then(d => d.evaluations)

async function requestEvaluation(callId: string) {
  const res = await fetch('/v1/actions/call.evaluate', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...workspaceHeaders() },
    body: JSON.stringify({ callId }),
  })
  if (!res.ok) throw new Error('The evaluation could not be started. Try again.')
}

const label = (score: number) =>
  score >= 5 ? 'Handled well' : score === 4 ? 'Mostly fine' : score === 3 ? 'Worth a look' : 'Needs review'

export function EvaluationCard({ call }: { call: Call }) {
  const finished = call.status === 'completed'
  const query = useQuery(finished ? evaluationKey(call.id) : null, () =>
    readAction<{ evaluation: CallEvaluation | null }>('call.getEvaluation', { callId: call.id }).then(
      d => d.evaluation,
    ),
  )
  const [asked, setAsked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!finished || query.data === undefined) return null
  const evaluation = query.data

  async function evaluate() {
    setError(null)
    try {
      await requestEvaluation(call.id)
      setAsked(true)
      // The job takes a few seconds; look again then.
      setTimeout(() => {
        void refreshQuery(evaluationKey(call.id))
        void refreshQuery(REVIEW_KEY)
      }, 8000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!evaluation) {
    // Phone calls are evaluated on their own; a test call (or one from before evaluations) only when asked.
    if (call.source !== 'test' && !asked) return null
    return (
      <section className="evc evc-empty" aria-label="Evaluation">
        <span className="help">
          {asked ? 'Evaluating… this takes a few seconds.' : 'Test calls are not evaluated on their own.'}
        </span>
        {!asked && (
          <Button size="sm" title="Have the language model judge how the assistant did" onClick={() => void evaluate()}>
            Evaluate
          </Button>
        )}
        {error && <Note tone="danger">{error}</Note>}
      </section>
    )
  }

  const low = evaluation.score <= NEEDS_REVIEW_MAX_SCORE
  return (
    <section className="evc" aria-label="Evaluation">
      <div className="evc-h">
        <b>Evaluation</b>
        <Badge
          tone={low ? 'outline' : 'neutral'}
          title={`Score ${evaluation.score} of 5, judged by ${evaluation.model ?? 'the language model'}`}
        >
          {evaluation.score}/5 · {label(evaluation.score)}
        </Badge>
        <span className="evc-who">Only owners and admins see this.</span>
      </div>
      {evaluation.issues.length > 0 && (
        <ul className="evc-issues">
          {evaluation.issues.map(issue => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
