// Business info (LIN-797): the questions callers asked that the assistant could not answer, as the first rows of
// Questions and answers ("No answer yet"). Answering one adds it to the About text on the server
// (knowledgeQuestion.answer) and to the page's draft; Dismiss closes it. Owners and admins only: the API refuses the
// read to anyone else, so for them it is not asked at all.
import type { QuestionGroup } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { T, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { loadQuestions, questionsKey } from '../review/reviewData.ts'
import { askedLabel, openGroups, otherIds } from '../review/reviewModel.ts'
import { useRows } from '../store.tsx'
import { listTime, parseTs } from '../time.ts'
import { appLink } from '../ui/AppLink.tsx'
import { Textarea } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { useWriteAction } from './settings-api.ts'

/** The open question groups of this assistant, most asked first; [] while loading and for members. */
export function useOpenQuestions(assistant: Assistant, canReview: boolean): QuestionGroup[] {
  const query = useQuery(canReview ? questionsKey(assistant.id) : null, loadQuestions(assistant.id))
  const rows = useRows('knowledge_questions')
  return canReview && query.data ? openGroups(query.data, rows) : []
}

/** "Asked 3 times · last 9:07 AM": the time opens the last call that asked it. */
function AskedLine({ group }: { group: QuestionGroup }) {
  const t = useT()
  const last = group.callIds[0]
  return (
    <span className="kn-sub">
      {last ? (
        <T
          k="settings.review.questions.askedLast"
          values={{
            count: Math.max(1, group.asked),
            time: listTime(parseTs(group.lastAskedAt)),
            link: appLink(`#call/${encodeURIComponent(last)}`, { title: t('settings.review.questions.lastCallTip') }),
          }}
        />
      ) : (
        askedLabel(group.asked)
      )}
    </span>
  )
}

type RowProps = {
  group: QuestionGroup
  canEdit: boolean
  open: boolean
  onOpen: (open: boolean) => void
  toast: (text: string) => void
  /** After the server added it: the page's draft gets the line too. */
  onAnswered: (question: string, answer: string) => void
}

/** One open question: a row like the others with "No answer yet"; a click opens it to answer or dismiss in place. */
export function OpenQuestionRow({ group, canEdit, open, onOpen, toast, onAnswered }: RowProps) {
  const t = useT()
  const write = useWriteAction()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'answer' | 'dismiss' | null>(null)
  const alsoIds = otherIds(group)

  async function run(action: 'answer' | 'dismiss') {
    setBusy(action)
    try {
      // The rows come back answered or dismissed, the whole group: it leaves the list at once (openGroups).
      if (action === 'answer') {
        await write('knowledgeQuestion.answer', { questionId: group.questionId, answer: text.trim(), alsoIds })
        onAnswered(group.question, text.trim())
        toast(t('settings.review.questions.added'))
      } else {
        await write('knowledgeQuestion.dismiss', { questionId: group.questionId, alsoIds })
        toast(t('settings.review.questions.dismissed'))
      }
    } catch (e) {
      toast((e as Error).message)
      setBusy(null)
    }
  }
  const save = () => {
    if (text.trim() && busy === null) void run('answer')
  }

  if (!open)
    return (
      <button
        type="button"
        className="kn-qrow kn-open-row"
        onClick={() => onOpen(true)}
        aria-expanded={false}
        title={t('settings.review.questions.addTip')}
      >
        <span className="kn-qrow-main">
          <b>{group.question}</b>
          <span className="kn-qrow-tags">
            <Badge tone="warning" dot>
              {t('settings.knowledge.open.badge')}
            </Badge>
            <AskedLine group={group} />
          </span>
        </span>
      </button>
    )

  return (
    <div className="kn-qedit kn-open-edit" role="group" aria-label={group.question}>
      <span className="kn-qrow-main">
        <b>{group.question}</b>
        <AskedLine group={group} />
      </span>
      <Textarea
        rows={3}
        autoFocus
        value={text}
        disabled={!canEdit}
        placeholder={t('settings.review.questions.answerPlaceholder')}
        aria-label={t('settings.review.questions.answerLabel', { question: group.question })}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            save()
          }
          if (e.key === 'Escape') onOpen(false)
        }}
      />
      <div className="kn-qedit-foot">
        <Button
          size="sm"
          variant="ghost"
          disabled={!canEdit || busy !== null}
          busy={busy === 'dismiss'}
          onClick={() => void run('dismiss')}
          title={t('settings.review.questions.dismissTip')}
        >
          {t('settings.review.questions.dismiss')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!canEdit || busy !== null || !text.trim()}
          busy={busy === 'answer'}
          onClick={save}
          title={t('settings.review.questions.saveTip')}
        >
          {t('settings.review.questions.add')}
        </Button>
      </div>
    </div>
  )
}
