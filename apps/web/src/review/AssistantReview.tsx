// How <assistant> did (Assistant area, #assistant/<id>/review; G R): the calls the language model scored low,
// each with what went wrong and Mark as checked, and the questions callers asked that the assistant could not answer, each
// answered once into About the business or dismissed. Owners and admins only (the API refuses everyone else).
import type { CallEvaluation, QuestionGroup } from '@linedesk/actions'
import type { Assistant, Call, Contact } from '@linedesk/db/types'
import { useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { callerName, callTitle } from '../inbox-model.ts'
import { Section } from '../settings/fields.tsx'
import { useWriteAction } from '../settings/settings-api.ts'
import { useRows, useTable } from '../store.tsx'
import { listTime, parseTs } from '../time.ts'
import { Input } from '../ui/form.tsx'
import { Badge, Button, Note } from '../ui/kit.tsx'
import { LoadProblem, Skeleton } from '../ui/LoadStates.tsx'
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
  return (
    <Badge
      tone={needsALook(evaluation.score) ? 'outline' : 'neutral'}
      title={`Score ${evaluation.score} of 5, judged by ${evaluation.model ?? 'the language model'}`}
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = evaluation.reviewedAt !== null
  async function toggle() {
    setBusy(true)
    setError(null)
    try {
      await setEvaluationDone(evaluation, assistantId, !done)
      toast?.(done ? 'Back on the list.' : 'Marked as checked.')
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
        title={done ? 'Put it back on the list' : 'You looked at it: take it off the list'}
      >
        {checkLabel(done)}
      </Button>
      {error && <Note tone="danger">{error}</Note>}
    </>
  )
}

function CallsCard({ assistant, toast }: { assistant: Assistant; toast: (text: string) => void }) {
  const [showDone, setShowDone] = useState(false)
  const query = useQuery(reviewListKey(assistant.id, !showDone), loadReviewList(assistant.id, !showDone))
  const calls = useTable('calls')
  const contacts = useTable('contacts')
  const name = assistant.name.trim() || 'The assistant'
  const list = query.data?.evaluations.filter(e => !calls.get(e.callId)?.deleted_at)
  return (
    <Section
      id="rv-calls"
      title={reviewTitle(assistant.name)}
      description={`Calls ${name} could have handled better. Look at each one, then mark it as checked.`}
      actions={
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={showDone}
          onClick={() => setShowDone(s => !s)}
          title={showDone ? 'Show the calls still to look at' : 'Show the calls marked as checked'}
        >
          {listToggleLabel(showDone)}
        </Button>
      }
    >
      {list === undefined ? (
        query.error ? (
          <LoadProblem what="The calls" />
        ) : (
          <Skeleton className="sk-card" />
        )
      ) : list.length === 0 ? (
        <p className="help rv-empty">
          {showDone ? 'Nothing checked yet.' : `Nothing to look at. ${name} handled every call well.`}
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
  const who = call ? callerName(call, call.contact_id ? contacts.get(call.contact_id) : undefined) : 'A call'
  const when = listTime(parseTs(call?.started_at ?? evaluation.createdAt))
  return (
    <li className="kn-row rv-row">
      <div className="kn-main">
        <a className="rv-call" href={`#call/${evaluation.callId}`} title="Open the call">
          <b>{call ? callTitle(call) : 'Call'}</b>
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
  const query = useQuery(questionsKey(assistant.id), loadQuestions(assistant.id))
  const rows = useRows('knowledge_questions')
  const name = assistant.name.trim() || 'The assistant'
  const groups = query.data && openGroups(query.data, rows)
  return (
    <Section
      id="rv-questions"
      title={`Questions ${name} couldn't answer`}
      description="Answer once; it is added to About the business for every caller."
    >
      {groups === undefined ? (
        query.error ? (
          <LoadProblem what="The questions" />
        ) : (
          <Skeleton className="sk-card" />
        )
      ) : groups.length === 0 ? (
        <p className="help rv-empty">No open questions. {name} could answer everything callers asked.</p>
      ) : (
        <ul className="kn-list rv-list">
          {groups.map(g => (
            <QuestionRow key={g.questionId} group={g} toast={toast} onAnswered={onAnswered} />
          ))}
        </ul>
      )}
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
        toast('Added to About the business.')
      } else toast('Dismissed.')
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
                <a href={`#call/${id}`} title="Open the call">
                  {listTime(parseTs(call.started_at))}
                </a>
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
              placeholder="Your answer"
              aria-label={`Answer to: ${group.question}`}
              disabled={busy !== null}
              onChange={e => setAnswer(e.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              busy={busy === 'answer'}
              disabled={busy !== null || !answer.trim()}
              title="Add the question and answer to About the business (enter)"
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setAnswering(false)}
              title="Cancel (esc)"
            >
              Cancel
            </Button>
          </form>
        )}
      </div>
      {!answering && (
        <div className="rv-actions">
          <Button size="sm" onClick={() => setAnswering(true)} title="Write the answer once, for every caller">
            Add answer
          </Button>
          <Button
            size="sm"
            variant="ghost"
            busy={busy === 'dismiss'}
            disabled={busy !== null}
            onClick={() => void run('knowledgeQuestion.dismiss')}
            title="Not worth an answer: hide it"
          >
            Dismiss
          </Button>
        </div>
      )}
    </li>
  )
}
