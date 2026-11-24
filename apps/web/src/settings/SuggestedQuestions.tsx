// Business info (LIN-809): the topics of the support mail review not yet reviewed, as "Suggested" rows of Questions and
// answers, right after the open questions. A suggestion opens with its question and answer filled in from the topic;
// Add to answers puts it into the About text on the server (mail.reviewTopic accept) and into the page's draft;
// Dismiss drops it. Data and writes: integrations/mailReview.ts (the Support email page reviews the same topics).
import type { MailTopic } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { draftOf, stateOf, type TopicDraft, useMailReview } from '../integrations/mailReview.ts'
import { Input, Textarea } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'

export type Suggestion = { index: number; topic: MailTopic }

/** The topics still to review, the ones most support emails were about first; none until the analysis is done. */
export function openSuggestions(topics: readonly MailTopic[] | undefined): Suggestion[] {
  return (topics ?? [])
    .map((topic, index) => ({ index, topic }))
    .filter(s => stateOf(s.topic) === 'open')
    .sort((a, b) => b.topic.conversations - a.topic.conversations)
}

/** The suggestions of the latest analysis and the review that accepts or drops them; none for members (not read). */
export function useSuggestions(toast: (text: string) => void, canReview: boolean) {
  const review = useMailReview(toast, canReview)
  const done = review.analysis?.status === 'done'
  return { items: done ? openSuggestions(review.analysis?.topics) : [], review }
}

type RowProps = {
  s: Suggestion
  assistantId: string
  canEdit: boolean
  open: boolean
  onOpen: (open: boolean) => void
  review: ReturnType<typeof useMailReview>
  /** After the server added it: the page's draft gets the line too. */
  onAccepted: (question: string, answer: string) => void
}

function Tags({ s }: { s: Suggestion }) {
  const t = useT()
  return (
    <span className="kn-qrow-tags">
      <Badge tone="info" dot>
        {t('settings.knowledge.sugg.badge')}
      </Badge>
      <span className="kn-sub">{t('settings.knowledge.sugg.from', { count: s.topic.conversations })}</span>
    </span>
  )
}

/** One suggestion as a row of the list; a click opens it in place to adjust and add, or dismiss. */
export function SuggestedRow({ s, assistantId, canEdit, open, onOpen, review, onAccepted }: RowProps) {
  const t = useT()
  const [draft, setDraft] = useState<TopicDraft>(() => draftOf(s.topic))
  const busy = review.busy === s.index
  async function accept() {
    if (await review.accept(s.index, draft, assistantId)) onAccepted(draft.question.trim(), draft.answer.trim())
  }

  if (!open)
    return (
      <button
        type="button"
        className="kn-qrow kn-sugg-row"
        onClick={() => onOpen(true)}
        aria-expanded={false}
        title={t('settings.knowledge.sugg.openTip')}
      >
        <span className="kn-qrow-main">
          <b>{draftOf(s.topic).question}</b>
          <span className="kn-qrow-answer">{s.topic.answer}</span>
          <Tags s={s} />
        </span>
      </button>
    )

  return (
    <div className="kn-qedit kn-sugg-open" role="group" aria-label={draft.question}>
      <Tags s={s} />
      <Input
        value={draft.question}
        disabled={!canEdit}
        aria-label={t('settings.knowledge.panel.question')}
        onChange={e => setDraft(d => ({ ...d, question: e.target.value }))}
        onKeyDown={e => e.key === 'Escape' && onOpen(false)}
      />
      <Textarea
        rows={3}
        value={draft.answer}
        disabled={!canEdit}
        aria-label={t('settings.knowledge.panel.answer')}
        onChange={e => setDraft(d => ({ ...d, answer: e.target.value }))}
        onKeyDown={e => e.key === 'Escape' && onOpen(false)}
      />
      <div className="kn-qedit-foot">
        <Button
          size="sm"
          variant="ghost"
          disabled={!canEdit || busy}
          onClick={() => void review.drop(s.index)}
          title={t('settings.knowledge.sugg.dismissTip')}
        >
          {t('settings.review.questions.dismiss')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={busy}
          disabled={!canEdit || !draft.question.trim() || !draft.answer.trim()}
          onClick={() => void accept()}
          title={t('settings.knowledge.sugg.addTip')}
        >
          {t('settings.knowledge.sugg.add')}
        </Button>
      </div>
    </div>
  )
}
