// How <assistant> did (Assistant area, #assistant/<id>/review; G R): the calls the language model scored low,
// each with what went wrong and Mark as checked, and the questions callers asked that the assistant could not answer, each
// answered once into About the business or dismissed. Owners and admins only (the API refuses everyone else).
import type { CallEvaluation, QuestionGroup } from '@linedesk/actions'
import type { Assistant, Call, Contact } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { callerName, callTitle } from '../inbox-model.ts'
import { Section } from '../settings/fields.tsx'
import { useWriteAction } from '../settings/settings-api.ts'
import { useRows, useTable } from '../store.tsx'
import { listTime, parseTs } from '../time.ts'
import { Input } from '../ui/form.tsx'
import { AppLink } from '../ui/AppLink.tsx'
import { Badge, Button, Note } from '../ui/kit.tsx'
import { Loading, SkeletonList } from '../ui/LoadStates.tsx'
import { loadQuestions, loadReviewList, questionsKey, reviewListKey, setEvaluationDone } from './reviewData.ts'
import {
  askedLabel,
  checkLabel,
  listToggleLabel,
  needsALook,
  openGroups,
  reviewTitle,
  scoreWords,
} from './reviewModel.ts'
import './review.css'

type Props = {
  assistant: Assistant
  toast: (text: string) => void
  /** After an answer was added to About the business on the server: the page's unsaved draft gets it too. */
  onAnswered: (question: string, answer: string) => void
}

export function AssistantReview({ assistant, toast, onAnswered }: Props) {
  return (
    <>
      <CallsCard assistant={assistant} toast={toast} />
      <QuestionsCard assistant={assistant} toast={toast} onAnswered={onAnswered} />
    </>
  )
}

/** The score in words, as a quiet badge; the number and the judge in its tooltip. */
export function ScoreBadge({ evaluation }: { evaluation: CallEvaluation }) {
  const t = useT()
  return (
    <Badge
      tone={needsALook(evaluation.score) ? 'outline' : 'neutral'}
      title={
        evaluation.model
          ? t('settings.review.scoreTip', { score: evaluation.score, model: evaluation.model })
          : t('settings.review.scoreTipDefault', { score: evaluation.score })
      }
    >
      {scoreWords(evaluation.score)}
    </Badge>
  )
}

/**
 * Mark as checked (or Reopen, once checked): the evaluation leaves the open list, the count in the navigation drops. Without
 * `toast` (the call view) the button's new label is the answer, and a refusal shows next to it.
 */
export function DoneButton({
  evaluation,
  assistantId,
  toast,
}: {
  evaluation: CallEvaluation
  assistantId: string | null
  toast?: (text: string) => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = evaluation.reviewedAt !== null
  async function toggle() {
    setBusy(true)
    setError(null)
    try {
      await setEvaluationDone(evaluation, assistantId, !done)
      toast?.(done ? t('settings.review.backOnList') : t('settings.review.markedChecked'))
    } catch (e) {
      if (toast) toast((e as Error).message)
      else setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant={done ? 'ghost' : 'secondary'}
        icon={done ? undefined : 'check'}
        busy={busy}
        onClick={() => void toggle()}
        title={done ? t('settings.review.reopenTip') : t('settings.review.checkTip')}
      >
        {checkLabel(done)}
      </Button>
      {error && <Note tone="danger">{error}</Note>}
    </>
  )
}

function CallsCard({ assistant, toast }: { assistant: Assistant; toast: (text: string) => void }) {
  const t = useT()
  const [showDone, setShowDone] = useState(false)
  const query = useQuery(reviewListKey(assistant.id, !showDone), loadReviewList(assistant.id, !showDone))
  const calls = useTable('calls')
  const contacts = useTable('contacts')
  const name = assistant.name.trim()
  const list = query.data?.evaluations.filter(e => !calls.get(e.callId)?.deleted_at)
  return (
    <Section
      id="rv-calls"
      title={reviewTitle(assistant.name)}
      description={
        name ? t('settings.review.calls.description', { name }) : t('settings.review.calls.descriptionDefault')
      }
      actions={
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={showDone}
          onClick={() => setShowDone(s => !s)}
          title={showDone ? t('settings.review.calls.showOpenTip') : t('settings.review.calls.showCheckedTip')}
        >
          {listToggleLabel(showDone)}
        </Button>
      }
    >
      <Loading
        what={t('settings.review.calls.loading')}
        loading={list === undefined}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonList rows={3} action />}
      >
        {list === undefined ? null : list.length === 0 ? (
          <p className="help rv-empty">
            {showDone
              ? t('settings.review.calls.noneChecked')
              : name
                ? t('settings.review.calls.none', { name })
                : t('settings.review.calls.noneDefault')}
          </p>
        ) : (
          <ul className="kn-list rv-list">
            {list.map(e => (
              <CallRow
                key={e.callId}
                evaluation={e}
                call={calls.get(e.callId)}
                contacts={contacts}
                assistantId={assistant.id}
                toast={toast}
              />
            ))}
          </ul>
        )}
      </Loading>
    </Section>
  )
}

function CallRow({
  evaluation,
  call,
  contacts,
  assistantId,
  toast,
}: {
  evaluation: CallEvaluation
  call: Call | undefined
  contacts: ReadonlyMap<string, Contact>
  assistantId: string
  toast: (text: string) => void
}) {
  const t = useT()
  const who = call
    ? callerName(call, call.contact_id ? contacts.get(call.contact_id) : undefined)
    : t('settings.review.calls.unknownCaller')
  const when = listTime(parseTs(call?.started_at ?? evaluation.createdAt))
  return (
    <li className="kn-row rv-row">
      <div className="kn-main">
        <a className="rv-call" href={`#call/${evaluation.callId}`} title={t('settings.review.openCall')}>
          <b>{call ? callTitle(call) : t('settings.review.calls.untitled')}</b>
          <span className="kn-sub">
            {who} · {when}
          </span>
        </a>
        {evaluation.issues.length > 0 && (
          <ul className="evc-issues">
            {evaluation.issues.map(issue => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="rv-actions">
        <ScoreBadge evaluation={evaluation} />
        <DoneButton evaluation={evaluation} assistantId={assistantId} toast={toast} />
      </div>
    </li>
  )
}

// --- Questions the assistant could not answer ----------------------------------------------

function QuestionsCard({ assistant, toast, onAnswered }: Props) {
  const t = useT()
  const query = useQuery(questionsKey(assistant.id), loadQuestions(assistant.id))
  const rows = useRows('knowledge_questions')
  const name = assistant.name.trim()
  const groups = query.data && openGroups(query.data, rows)
  return (
    <Section
      id="rv-questions"
      title={name ? t('settings.review.questions.title', { name }) : t('settings.review.questions.titleDefault')}
      description={t('settings.review.questions.description')}
    >
      <Loading
        what={t('settings.review.questions.loading')}
        loading={groups === undefined}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonList rows={2} action />}
      >
        {groups === undefined ? null : groups.length === 0 ? (
          <p className="help rv-empty">
            {name ? t('settings.review.questions.none', { name }) : t('settings.review.questions.noneDefault')}
          </p>
        ) : (
          <ul className="kn-list rv-list">
            {groups.map(g => (
              <QuestionRow key={g.questionId} group={g} toast={toast} onAnswered={onAnswered} />
            ))}
          </ul>
        )}
      </Loading>
    </Section>
  )
}

function QuestionRow({
  group,
  toast,
  onAnswered,
}: {
  group: QuestionGroup
  toast: (text: string) => void
  onAnswered: Props['onAnswered']
}) {
  const t = useT()
  const write = useWriteAction()
  const calls = useTable('calls')
  const [answering, setAnswering] = useState(false)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState<'answer' | 'dismiss' | null>(null)
  const fieldId = `rv-answer-${group.questionId}`

  async function run(action: 'knowledgeQuestion.answer' | 'knowledgeQuestion.dismiss') {
    setBusy(action === 'knowledgeQuestion.answer' ? 'answer' : 'dismiss')
    try {
      // The row comes back answered or dismissed: the group leaves the list at once (openGroups).
      await write(
        action,
        action === 'knowledgeQuestion.answer'
          ? { questionId: group.questionId, answer: answer.trim() }
          : { questionId: group.questionId },
      )
      if (action === 'knowledgeQuestion.answer') {
        onAnswered(group.question, answer.trim())
        toast(t('settings.review.questions.added'))
      } else toast(t('settings.review.questions.dismissed'))
    } catch (e) {
      toast((e as Error).message)
      setBusy(null)
    }
  }

  return (
    <li className="kn-row rv-row">
      <div className="kn-main">
        <b>{group.question}</b>
        <span className="kn-sub">
          {askedLabel(group.asked)}
          {group.callIds.map((id, i) => {
            const call = calls.get(id)
            if (!call || call.deleted_at) return null
            return (
              <span key={id}>
                {i === 0 ? ' · ' : ', '}
                <AppLink to={`#call/${id}`} title={t('settings.review.openCall')}>
                  {listTime(parseTs(call.started_at))}
                </AppLink>
              </span>
            )
          })}
        </span>
        {answering && (
          <form
            className="rv-answer"
            onSubmit={e => {
              e.preventDefault()
              if (answer.trim()) void run('knowledgeQuestion.answer')
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setAnswering(false)
              }
            }}
          >
            <Input
              id={fieldId}
              value={answer}
              autoFocus
              placeholder={t('settings.review.questions.answerPlaceholder')}
              aria-label={t('settings.review.questions.answerLabel', { question: group.question })}
              disabled={busy !== null}
              onChange={e => setAnswer(e.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              busy={busy === 'answer'}
              disabled={busy !== null || !answer.trim()}
              title={t('settings.review.questions.saveTip')}
            >
              {t('common.action.save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setAnswering(false)}
              title={t('settings.review.questions.cancelTip')}
            >
              {t('common.action.cancel')}
            </Button>
          </form>
        )}
      </div>
      {!answering && (
        <div className="rv-actions">
          <Button size="sm" onClick={() => setAnswering(true)} title={t('settings.review.questions.addTip')}>
            {t('settings.review.questions.add')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            busy={busy === 'dismiss'}
            disabled={busy !== null}
            onClick={() => void run('knowledgeQuestion.dismiss')}
            title={t('settings.review.questions.dismissTip')}
          >
            {t('settings.review.questions.dismiss')}
          </Button>
        </div>
      )}
    </li>
  )
}
