// How <assistant> did on this call, as the language model judged it after the summary: the score in words, what
// went wrong, the questions it could not answer, and Mark as checked (the same as in the Assistant area, #assistant/<id>/review).
// Only owners and admins see it (the API refuses everyone else).
import type { CallEvaluation } from '@linedesk/actions'
import type { Call } from '@linedesk/db/types'
import { useState } from 'react'
import { refreshQuery, useQuery } from '../cachedQuery.ts'
import { DoneButton, ScoreBadge } from '../review/AssistantReview.tsx'
import { evaluationKey, REVIEW_KEY } from '../review/reviewData.ts'
import { needsALook, reviewTitle } from '../review/reviewModel.ts'
import { readAction } from '../settings/settings-api.ts'
import { useAssistants } from '../store.tsx'
import { workspaceHeaders } from '../tabWorkspace.ts'
import { Button, Note } from '../ui/kit.tsx'
import { useT } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'

async function requestEvaluation(callId: string) {
  const res = await fetch('/v1/actions/call.evaluate', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...workspaceHeaders() },
    body: JSON.stringify({ callId }),
  })
  if (!res.ok) throw new Error(i18n().t('call.evaluation.startFailed'))
}

export function EvaluationCard({ call }: { call: Call }) {
  const t = useT()
  const finished = call.status === 'completed'
  const assistants = useAssistants()
  const assistant = assistants.find(a => a.id === call.assistant_id) ?? assistants[0]
  const query = useQuery(finished ? evaluationKey(call.id) : null, () =>
    readAction<{ evaluation: CallEvaluation | null }>('call.getEvaluation', { callId: call.id }).then(
      d => d.evaluation,
    ),
  )
  const [asked, setAsked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!finished || query.data === undefined) return null
  const evaluation = query.data
  const title = t('call.evaluation.title', { review: reviewTitle(assistant?.name ?? '') })

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
      <section className="evc evc-empty" aria-label={title}>
        <span className="help">
          {asked ? t('call.evaluation.evaluating') : t('call.evaluation.testCalls')}
        </span>
        {!asked && (
          <Button size="sm" title={t('call.evaluation.evaluateTitle')} onClick={() => void evaluate()}>
            {t('call.evaluation.evaluate')}
          </Button>
        )}
        {error && <Note tone="danger">{error}</Note>}
      </section>
    )
  }

  return (
    <section className="evc" aria-label={title}>
      <div className="evc-h">
        <b>{title}</b>
        <ScoreBadge evaluation={evaluation} />
        <span className="evc-who">{t('call.evaluation.who')}</span>
        {/* Only a call worth a look is on the list, so only it has Mark as checked (and Reopen once checked). */}
        {needsALook(evaluation.score) && <DoneButton evaluation={evaluation} assistantId={assistant?.id ?? null} />}
      </div>
      {evaluation.issues.length > 0 && (
        <ul className="evc-issues">
          {evaluation.issues.map(issue => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {evaluation.unanswered.length > 0 && (
        <div className="evc-questions">
          <span className="evc-label">{t('call.evaluation.unanswered')}</span>
          <ul className="evc-issues">
            {evaluation.unanswered.map(q => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
