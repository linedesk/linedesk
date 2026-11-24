// Open questions (Assistant area, #assistant/<id>/review; G R): the questions callers asked that the assistant could
// not answer, grouped (the same question however it was worded), most asked first. Each group is answered once into
// About the business, or dismissed, for all of its questions. Owners and admins only (the API refuses everyone else).
// How the assistant itself did on each call is not here: the owner cannot change it, staff look at it (Server admin ›
// Call reviews).
import type { QuestionGroup } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { T, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { Section } from '../settings/fields.tsx'
import { useWriteAction } from '../settings/settings-api.ts'
import { useRows } from '../store.tsx'
import { listTime, parseTs } from '../time.ts'
import { appLink } from '../ui/AppLink.tsx'
import { Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { ZeroState } from '../ui/listPage.tsx'
import { Loading, SkeletonList } from '../ui/LoadStates.tsx'
import { loadQuestions, questionsKey } from './reviewData.ts'
import { askedLabel, openGroups, otherIds, questionsTitle } from './reviewModel.ts'
import './review.css'

type Props = {
  assistant: Assistant
  toast: (text: string) => void
  /** After an answer was added to About the business on the server: the page's unsaved draft gets it too. */
  onAnswered: (question: string, answer: string) => void
}

export function AssistantReview({ assistant, toast, onAnswered }: Props) {
  const t = useT()
  const query = useQuery(questionsKey(assistant.id), loadQuestions(assistant.id))
  const rows = useRows('knowledge_questions')
  const name = assistant.name.trim()
  const groups = query.data && openGroups(query.data, rows)
  return (
    <Section
      id="rv-questions"
      title={questionsTitle(assistant.name)}
      description={groups?.length ? t('settings.review.questions.description') : undefined}
    >
      <Loading
        what={t('settings.review.questions.loading')}
        loading={groups === undefined}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonList rows={3} action />}
      >
        {groups === undefined ? null : groups.length === 0 ? (
          <div className="rv-zero">
            <ZeroState
              title={t('settings.review.questions.emptyTitle')}
              line={
                name
                  ? t('settings.review.questions.emptyLine', { name })
                  : t('settings.review.questions.emptyLineDefault')
              }
            />
          </div>
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

/** "Asked 3 times · last 9:07 AM": the time opens the last call that asked it. */
function AskedLine({ group }: { group: QuestionGroup }) {
  const t = useT()
  const time = listTime(parseTs(group.lastAskedAt))
  const last = group.callIds[0]
  return (
    <span className="kn-sub">
      {last ? (
        <T
          k="settings.review.questions.askedLast"
          values={{
            count: Math.max(1, group.asked),
            time,
            link: appLink(`#call/${encodeURIComponent(last)}`, { title: t('settings.review.questions.lastCallTip') }),
          }}
        />
      ) : (
        askedLabel(group.asked)
      )}
    </span>
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
  const [answering, setAnswering] = useState(false)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState<'answer' | 'dismiss' | null>(null)
  const fieldId = `rv-answer-${group.questionId}`
  const alsoIds = otherIds(group)

  async function run(action: 'knowledgeQuestion.answer' | 'knowledgeQuestion.dismiss') {
    setBusy(action === 'knowledgeQuestion.answer' ? 'answer' : 'dismiss')
    try {
      // The rows come back answered or dismissed, the whole group: it leaves the list at once (openGroups).
      await write(
        action,
        action === 'knowledgeQuestion.answer'
          ? { questionId: group.questionId, answer: answer.trim(), alsoIds }
          : { questionId: group.questionId, alsoIds },
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
        <AskedLine group={group} />
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
