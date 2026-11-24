// How <assistant> did on this call, as the language model judged it after the summary: the score in words, what
// went wrong and the questions it could not answer. Staff only (server admins, as in Server admin › Call reviews):
// what the assistant itself did wrong is ours to fix, not the business's. The questions reach the business as Open
// questions (Assistant area). The API reads it for owners and admins of the workspace.
import type { Call } from '@linedesk/db/types'
import { useState } from 'react'
import { refreshQuery, useQuery } from '../cachedQuery.ts'
import { evaluationKey, loadEvaluation } from '../review/reviewData.ts'
import { reviewTitle } from '../review/reviewModel.ts'
import { ScoreBadge } from '../review/ScoreBadge.tsx'
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
  const query = useQuery(finished ? evaluationKey(call.id) : null, loadEvaluation(call.id))
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
      setTimeout(() => void refreshQuery(evaluationKey(call.id)), 8000)
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
        <ScoreBadge score={evaluation.score} model={evaluation.model} />
        <span className="evc-who">{t('call.evaluation.whoStaff')}</span>
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
