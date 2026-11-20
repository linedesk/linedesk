// What the support mail shows (LIN-643, step 3 of LIN-615), under the mailboxes on Integrations › Support email: the
// owner starts an analysis of the last 6 or 12 months (mail.analyze), sees its status, and reviews the topics it found:
// accept (as edited) into an assistant's About the business, or drop (mail.reviewTopic). Data: mailReview.ts.
import type { MailAnalysis, MailTopic } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { T, useFormat, useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, useState } from 'react'
import { Section } from '../settings/fields.tsx'
import { useRows } from '../store.tsx'
import { appLink } from '../ui/AppLink.tsx'
import { Input, Textarea } from '../ui/form.tsx'
import { Badge, Button, cx, Icon, Note, Spinner } from '../ui/kit.tsx'
import { Loading, SkeletonList } from '../ui/LoadStates.tsx'
import {
  analysisErrorKey,
  assistantChoices,
  canAccept,
  counts,
  draftOf,
  isPending,
  type MailReview as Review,
  previewLine,
  stateOf,
  type TopicDraft,
  useMailReview,
} from './mailReview.ts'
import './mail-review.css'

type Props = { canEdit: boolean; toast: (text: string) => void }

export function MailReview({ canEdit, toast }: Props) {
  const t = useT()
  const review = useMailReview(toast)
  const { analysis } = review
  if (!canEdit) return null
  return (
    <Section
      id="ig-mail-review"
      title={t('settings.integrations.mailReview.title')}
      help={t('settings.integrations.mailReview.help')}
    >
      <Loading
        what={t('settings.integrations.mailReview.title')}
        loading={analysis === undefined}
        error={review.error}
        onRetry={() => void review.reload()}
        skeleton={<SkeletonList rows={2} />}
      >
        {analysis === undefined ? null : analysis === null ? (
          <StartAnalysis review={review} />
        ) : isPending(analysis) ? (
          <Running analysis={analysis} />
        ) : analysis.status === 'failed' ? (
          <>
            <Note tone="danger">{t(analysisErrorKey(analysis.error))}</Note>
            <StartAnalysis review={review} again />
          </>
        ) : (
          <Done analysis={analysis} review={review} />
        )}
      </Loading>
    </Section>
  )
}

function StartAnalysis({ review, again, compact }: { review: Review; again?: boolean; compact?: boolean }) {
  const t = useT()
  const [months, setMonths] = useState<6 | 12>(review.analysis?.months === 6 ? 6 : 12)
  return (
    <div className={cx('mr-start', compact && 'is-compact')}>
      {!compact && <p className="mr-lead">{t('settings.integrations.mailReview.startLead')}</p>}
      <div className="mr-start-row">
        <div className="mr-seg" role="radiogroup" aria-label={t('settings.integrations.mailReview.range')}>
          {([6, 12] as const).map(m => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={months === m}
              className={cx('mr-seg-btn', months === m && 'is-on')}
              onClick={() => setMonths(m)}
            >
              {t('settings.integrations.mailReview.months', { count: m })}
            </button>
          ))}
        </div>
        <Button
          variant={again ? 'secondary' : 'primary'}
          busy={review.starting}
          onClick={() => void review.start(months)}
          title={t('settings.integrations.mailReview.startTip', { count: months })}
        >
          {again ? t('settings.integrations.mailReview.runAgain') : t('settings.integrations.mailReview.start')}
        </Button>
      </div>
      {!compact && <p className="help">{t('settings.integrations.mailReview.privacy')}</p>}
    </div>
  )
}

function Running({ analysis }: { analysis: MailAnalysis }) {
  const t = useT()
  return (
    <div className="mr-running" role="status">
      <Spinner />
      <div>
        <b>
          {analysis.status === 'queued'
            ? t('settings.integrations.mailReview.queued')
            : t('settings.integrations.mailReview.running', { count: analysis.months })}
        </b>
        <span className="kn-sub">{t('settings.integrations.mailReview.runningLine')}</span>
      </div>
    </div>
  )
}

function Done({ analysis, review }: { analysis: MailAnalysis; review: Review }) {
  const t = useT()
  const f = useFormat()
  const assistants = assistantChoices(useRows('assistants'))
  const [assistantId, setAssistantId] = useState<string | null>(null)
  const target = assistants.find(a => a.id === assistantId) ?? assistants[0]
  const c = counts(analysis.topics)
  const props = { analysis, review, assistant: target }
  return (
    <>
      <div className="mr-summary">
        <span>
          {t('settings.integrations.mailReview.summary', {
            count: analysis.conversationsAnalyzed,
            months: analysis.months,
            date: analysis.finishedAt ? f.date(new Date(analysis.finishedAt), { month: 'short', day: 'numeric' }) : '',
          })}
        </span>
        <span className="mr-counts">
          {t('settings.integrations.mailReview.counts', { accepted: c.accepted, open: c.open, dropped: c.dropped })}
        </span>
      </div>
      {assistants.length > 1 && target && (
        <label className="mr-target">
          <span>{t('settings.integrations.mailReview.addTo')}</span>
          <select value={target.id} onChange={e => setAssistantId(e.target.value)}>
            {assistants.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {analysis.topics.length === 0 ? (
        <p className="help">{t('settings.integrations.mailReview.noTopics')}</p>
      ) : (
        <Split {...props} />
      )}
      <div className="mr-again">
        <StartAnalysis review={review} again compact />
        <span className="help">{t('settings.integrations.mailReview.againNote')}</span>
      </div>
    </>
  )
}

type LayoutProps = { analysis: MailAnalysis; review: Review; assistant: Assistant | undefined }

/** The drafts of every topic, kept while the owner moves between them. */
function useDrafts(topics: MailTopic[]) {
  const [drafts, setDrafts] = useState<Record<number, TopicDraft>>({})
  return {
    get: (i: number) => drafts[i] ?? draftOf(topics[i]!),
    set: (i: number, d: TopicDraft) => setDrafts(prev => ({ ...prev, [i]: d })),
  }
}

/** "Mentioned in 18 conversations". */
function CountBadge({ topic }: { topic: MailTopic }) {
  const t = useT()
  return (
    <Badge tone="outline">{t('settings.integrations.mailReview.conversations', { count: topic.conversations })}</Badge>
  )
}

/** The fields of one topic: the question as a caller asks it, the answer, the facts to ask for, and the line itself. */
function TopicEditor({
  id,
  draft,
  onChange,
  disabled,
  assistant,
}: {
  id: string
  draft: TopicDraft
  onChange: (d: TopicDraft) => void
  disabled?: boolean
  assistant: Assistant | undefined
}) {
  const t = useT()
  const [fact, setFact] = useState('')
  const addFact = () => {
    const v = fact.trim()
    if (v && !draft.facts.includes(v)) onChange({ ...draft, facts: [...draft.facts, v] })
    setFact('')
  }
  return (
    <div className="mr-editor">
      <label className="mr-field" htmlFor={`${id}-q`}>
        <span>{t('settings.integrations.mailReview.question')}</span>
        <Input
          id={`${id}-q`}
          value={draft.question}
          disabled={disabled}
          onChange={e => onChange({ ...draft, question: e.target.value })}
        />
      </label>
      <label className="mr-field" htmlFor={`${id}-a`}>
        <span>{t('settings.integrations.mailReview.answer')}</span>
        <Textarea
          id={`${id}-a`}
          rows={3}
          value={draft.answer}
          disabled={disabled}
          onChange={e => onChange({ ...draft, answer: e.target.value })}
        />
      </label>
      <div className="mr-field">
        <span>{t('settings.integrations.mailReview.askFor')}</span>
        <div className="mr-facts">
          {draft.facts.map(f => (
            <span key={f} className="mr-fact">
              {f}
              <button
                type="button"
                disabled={disabled}
                aria-label={t('settings.integrations.mailReview.removeFact', { fact: f })}
                title={t('settings.integrations.mailReview.removeFact', { fact: f })}
                onClick={() => onChange({ ...draft, facts: draft.facts.filter(x => x !== f) })}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
          <input
            className="mr-fact-add"
            value={fact}
            disabled={disabled}
            placeholder={t('settings.integrations.mailReview.addFact')}
            aria-label={t('settings.integrations.mailReview.addFact')}
            onChange={e => setFact(e.target.value)}
            onBlur={addFact}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addFact()
              }
            }}
          />
        </div>
      </div>
      <div className="mr-preview">
        <span>
          {assistant
            ? t('settings.integrations.mailReview.previewName', { name: assistant.name })
            : t('settings.integrations.mailReview.preview')}
        </span>
        <code>{previewLine(draft)}</code>
      </div>
    </div>
  )
}

function useAcceptDrop(review: Review, assistant: Assistant | undefined) {
  return {
    accept: async (i: number, d: TopicDraft) => {
      if (!assistant || !canAccept(d)) return false
      return review.accept(i, d, assistant.id)
    },
    drop: (i: number) => review.drop(i),
  }
}

/** A reviewed topic, folded: accepted or dropped, with Undo for a drop. */
function Folded({ topic, index, review }: { topic: MailTopic; index: number; review: Review }) {
  const t = useT()
  const state = stateOf(topic)
  const owner = useRows('assistants').find(a => a.id === topic.review?.assistantId)
  return (
    <div className={cx('mr-folded', `is-${state}`)}>
      <Icon name={state === 'accepted' ? 'check' : 'close'} size={14} />
      <b>{topic.title}</b>
      <span className="kn-sub">
        {state === 'dropped' ? (
          t('settings.integrations.mailReview.dropped')
        ) : owner ? (
          <T
            k="settings.integrations.mailReview.acceptedIn"
            values={{
              name: owner.name,
              link: appLink(`#assistant/${encodeURIComponent(owner.id)}/business`, {
                title: t('settings.integrations.mailReview.aboutTip', { name: owner.name }),
              }),
            }}
          />
        ) : (
          t('settings.integrations.mailReview.accepted')
        )}
      </span>
      {state === 'dropped' && (
        <Button
          size="sm"
          variant="ghost"
          busy={review.busy === index}
          onClick={() => void review.reopen(index)}
          title={t('settings.integrations.mailReview.undoTip')}
        >
          {t('settings.integrations.mailReview.undo')}
        </Button>
      )}
    </div>
  )
}

function Actions({
  index,
  draft,
  review,
  assistant,
  onDone,
}: {
  index: number
  draft: TopicDraft
  review: Review
  assistant: Assistant | undefined
  onDone?: () => void
}) {
  const t = useT()
  const { accept, drop } = useAcceptDrop(review, assistant)
  const busy = review.busy !== null
  return (
    <div className="mr-actions">
      <Button
        variant="primary"
        size="sm"
        icon="check"
        busy={review.busy === index}
        disabled={busy || !canAccept(draft) || !assistant}
        onClick={() => void accept(index, draft).then(ok => ok && onDone?.())}
        title={t('settings.integrations.mailReview.acceptTip', { name: assistant?.name ?? '' })}
        shortcut={['⌘', '↵']}
      >
        {t('settings.integrations.mailReview.accept')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void drop(index).then(ok => ok && onDone?.())}
        title={t('settings.integrations.mailReview.dropTip')}
      >
        {t('settings.integrations.mailReview.drop')}
      </Button>
    </div>
  )
}

// --- The review: the topics on the left, the chosen one on the right (layout C, chosen by Tim) ---------------------

function Split({ analysis, review, assistant }: LayoutProps) {
  const t = useT()
  const drafts = useDrafts(analysis.topics)
  const { accept } = useAcceptDrop(review, assistant)
  const firstOpen = analysis.topics.findIndex(tp => stateOf(tp) === 'open')
  const [at, setAt] = useState(Math.max(firstOpen, 0))
  const topic = analysis.topics[at]!
  const last = analysis.topics.length - 1
  /** After a decision: the next open topic, wrapping to the first; stays when none is left. */
  const next = () => {
    const after = analysis.topics.findIndex((tp, i) => i > at && stateOf(tp) === 'open')
    const first = analysis.topics.findIndex((tp, i) => i !== at && stateOf(tp) === 'open')
    setAt(after >= 0 ? after : first >= 0 ? first : at)
  }
  /** J/K (or the arrow keys) move through the list; ⌘↵ in a field adds the topic and moves on. */
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && stateOf(topic) === 'open') {
        e.preventDefault()
        void accept(at, drafts.get(at)).then(ok => ok && next())
      }
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault()
      setAt(Math.min(last, at + 1))
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault()
      setAt(Math.max(0, at - 1))
    }
  }
  return (
    <>
      {counts(analysis.topics).open === 0 && (
        <div className="mr-all-done">
          <Icon name="check" size={18} />
          <b>{t('settings.integrations.mailReview.allDone')}</b>
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: J/K and ⌘↵ from the list or any field of the topic */}
      <div className="mr-split" onKeyDown={onKey}>
        <ul className="mr-split-list" aria-label={t('settings.integrations.mailReview.title')}>
          {analysis.topics.map((tp, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one analysis's topics, a fixed list that never reorders
            <li key={i}>
              <button
                type="button"
                aria-current={i === at}
                className={cx('mr-split-item', i === at && 'is-at', `is-${stateOf(tp)}`)}
                onClick={() => setAt(i)}
                title={t('settings.integrations.mailReview.pickTip')}
              >
                <span className="mr-split-mark">
                  {stateOf(tp) === 'accepted' ? (
                    <Icon name="check" size={13} />
                  ) : stateOf(tp) === 'dropped' ? (
                    <Icon name="close" size={13} />
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="mr-split-title">{tp.title}</span>
                <span className="mr-split-count">{tp.conversations}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mr-split-detail">
          <div className="mr-card-head">
            <span className="mr-step-pos">
              {t('settings.integrations.mailReview.position', { at: at + 1, count: last + 1 })}
            </span>
            <b>{topic.title}</b>
            <CountBadge topic={topic} />
          </div>
          {stateOf(topic) === 'open' ? (
            <>
              <TopicEditor
                id={`mr-${at}`}
                draft={drafts.get(at)}
                onChange={d => drafts.set(at, d)}
                disabled={review.busy === at}
                assistant={assistant}
              />
              <Actions index={at} draft={drafts.get(at)} review={review} assistant={assistant} onDone={next} />
            </>
          ) : (
            <Folded topic={topic} index={at} review={review} />
          )}
        </div>
      </div>
    </>
  )
}
